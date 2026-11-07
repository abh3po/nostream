# Relay moderation

Programmatic, content- and behaviour-based moderation for the relay, with a
human review window. Nothing here gates authors (npubs) as a precondition;
rules key on the event itself, and a caught event is held for review rather
than silently dropped.

## Behaviour

- Rules run at ingest, so they only see events published after moderation is
  enabled. Events already stored are not re-scanned.
- A caught event is **quarantined**: it is persisted so an operator can review
  it, but hidden from every read path (REQ streams, COUNT, live broadcasts).
- The publisher still receives a normal `OK true`. This is deliberate
  ("shadow"): a spammer cannot tell which rule fired or that they were caught.
- A quarantined event is hard-deleted after `quarantineSeconds` unless an
  operator overturns it first. The maintenance sweep runs this.

## Rules

Per-event content rules (`src/utils/moderation.ts`):

| Rule | Catches |
| --- | --- |
| `app_store_promo` | App-store links plus marketing hashtags / multiple links |
| `self_promo_boilerplate` | "I built N+ apps … solo developer" style copy |
| `link_flood` | Many links in one event with little prose |
| `hashtag_stuffing` | Many hashtags with little prose |
| `bitcoin_block_fees` | `Block <height>` + fee-priority table + `#bitcoinfees` / `#mempool` template |

Stateful rules (`src/services/moderation-service.ts`):

| Rule | Catches |
| --- | --- |
| `duplicate_burst` | One author repeating the same content skeleton quickly |
| `report_quorum` | A pubkey flagged by enough distinct NIP-56 reporters |

All rules honour `moderation.scanKinds`; encrypted kinds (4, 1059) are never
scanned. `duplicate_burst` additionally ignores replaceable and
parameterized-replaceable kinds (0, 3, 10000–19999, 30000–39999), because
re-sending those is an update by design, not a duplicate.

## Configuration (`moderation` in settings)

| Key | Meaning |
| --- | --- |
| `enabled` | master switch |
| `scanKinds` | kinds/ranges whose content is scanned |
| `quarantineSeconds` | review window before hard delete (default 86400) |
| `rules.*` | per-rule `{ enabled, action }`; `action` is `quarantine` or `reject` |
| `duplicateBurst` | `{ enabled, action, minCount, windowSeconds }` |
| `reportQuorum` | `{ enabled, action, minReporters, windowSeconds }` |
| `membersApiUrl` | roster endpoint used to resolve admins (see below) |

## Admin API

Mounted at `/moderation`, authenticated per request with NIP-98 plus an
active-admin check. It is independent of the password-login `/admin` console
(`admin.enabled`).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/moderation/queue` | list quarantined events (`?limit=&offset=`) |
| `POST` | `/moderation/{eventId}/overturn` | restore a quarantined event |
| `POST` | `/moderation/{eventId}/delete` | hard-delete it now |

POST actions carry no request body; the action is bound by the signed URL and
method.

## Admin identity

The moderation API does not have its own account system. It verifies the
NIP-98 signature and then confirms the signer is an active admin by calling a
roster endpoint:

```
GET {membersApiUrl}/members/{npub}   ->  200 { "role": "ADMIN", "status": "ACTIVE" }
```

`membersApiUrl` is configured in settings or `MODERATION_MEMBERS_API_URL`, and
defaults to `http://db:4000`. The check **fails closed**: if the endpoint is
unreachable the request is refused. Results are cached per worker for 60s.

This endpoint is deliberately generic — point it at whatever roster service
owns admin identity. It is not coupled to a specific control plane.

## Migration

`migrations/20261007_120000_add_moderation_quarantine_to_events.js` adds the
quarantine columns and partial index to `events`. It is additive and
nullable-only, so it does not rewrite existing rows.
