# Staging nostream relay (relay.stg.formstr.app)

Declarative deployment for the `nso_nostream` relay that fronts mesh-PG on the
staging orchestrator host. This replaces a hand-started container that was not
part of any compose project — so a host reboot used to leave the relay down.

**Reads** come from the orchestrator's central Postgres (same host), which
pg-gateway already fills with every captured event row; **writes** still go
through pg-gateway to the mesh providers. This split is what removed the
per-REQ mesh fan-out and the low per-IP connection cap. See
`docs/RELAY_READ_SCALING.md` in the orchestrator repo.

> **Source of truth:** the live relay is composed from the copy inside the
> **nostream fork** (`abh3po/nostream`, `deploy/nostream-staging/`), checked out
> on the host at `/root/Servers/nostream`. This directory is a **reference
> mirror** of that copy — the two drifted once (this one was missing the
> message rate limit and the container log cap), which is exactly the kind of
> difference that turns into a regression if it is ever deployed from. When you
> change relay config, change it in the fork and mirror it here in the same
> session.

## Files

| File | Purpose |
|---|---|
| `docker-compose.yml` | `nostream` + `nostream-cache`, pinned network, central read replica |
| `settings.yaml` | Relay settings overrides, mounted read-only |
| `sql/central-event-tags.sql` | Enable/rebuild the central `event_tags` derived table |
| `resources/` | Landing page (`index.html`, `css/style.css`), mounted read-only |
| `.env.example` | Secrets / tuning template |

nginx config is **not** here — it lives in its own repo,
`formstr-hq/nginx-72.61.138.38`, which is checked out at `/etc/nginx` on the
host. See "nginx per-IP connection limits" below.

## Why these exist

1. **Restart survival.** The old container had `restart: unless-stopped` but no
   compose project, so it did not come back after a `docker compose down` or a
   host reboot that recreated containers. Declaring the service fixes that.
2. **Settings are source-controlled.** The public-relay overrides and the
   `network.trustedProxies` list (which is what makes rate limiting key on the
   real client IP) previously lived only in the host's
   `.nostr/settings.yaml`. They are now committed and mounted read-only, so the
   running relay cannot drift from the repo.

## Landing page

`resources/` holds the relay's landing page, mounted read-only over the image's
`/app/resources/index.html` and `/app/resources/css/style.css`.

This exists because the deployed `nostream-mesh:staging` image predates the
redesign: it was built 2026-09-07 14:00 UTC, while the redesign commits landed
16:28–16:39 UTC. The redesigned page had been copied into the running
container's writable layer, so recreating the container reverted the relay to
the old bootstrap page. Mounting the files from the repo makes the page
durable across recreation.

To change the page: edit `resources/index.html` / `resources/css/style.css`
or refresh them from the nostream fork's `landing-redesign` branch, then
`docker compose up -d` (compose recreates on mount change). The page must stay
self-contained — no external fonts/scripts — to satisfy the image's CSP.


## Deploy

```bash
cd deploy/nostream-staging
cp .env.example .env && $EDITOR .env
# set SECRET, DB_PASSWORD (pg-gateway), REDIS_PASSWORD, and
# READ_DB_* to the root stack's POSTGRES_USER/PASSWORD/DB
# (defaults: orchestrator/orchestrator, host `postgres`)
# Existing deployment: prepare the derived event_tags table before the relay
# serves reads from central Postgres (takes a write lock on events):
docker compose stop nostream
(cd ../.. && ./scripts/relay-central-read-index.sh)
docker compose up -d
```

For a fresh install, `events`/`event_tags` do not exist until nostream has run
its migrations through pg-gateway once. Start it, stop it, run the script, then
start it again. The script refuses to run if `public.events` is missing.

The nostream image (`NOSTREAM_IMAGE`, default `nostream-mesh:staging`) must
already be loaded on the host. See the fork build notes in
`docs/DEPLOY_STAGING_NOSTREAM_MESHPG.md`.

## Migrating the existing (hand-started) containers

Compose cannot adopt containers it did not create, and the existing
`nostream-net` network is unmanaged, so the first cutover needs a short
outage:

```bash
# 1. Stop and remove the old containers (the nostream-net network is recreated
#    by compose with the same subnet, so the bridge IP stays 172.28.0.1).
docker rm -f nso_nostream nso_nostream_cache
docker network rm nostream-net

# 2. Bring the stack up from this directory.
cd deploy/nostream-staging
docker compose up -d
```

The old redis `cache` volume is not reused (compose gets a fresh project
volume). Relay state that matters — events — lives in the central Postgres
hot-read copy and on the mesh-PG providers, not redis, so this only costs
transient cache contents. Run `scripts/relay-central-read-index.sh` once after
the cutover to rebuild the derived `event_tags` table.

## Trusted proxy / rate limiting

`settings.yaml` sets `network.remoteIpHeader: x-forwarded-for` and lists
`172.28.0.1` in `network.trustedProxies`. `docker-compose.yml` pins the
`nostream-net` subnet to `172.28.0.0/16`, whose gateway is always the first
host address (`172.28.0.1`), so the two stay consistent. nginx already sends
`X-Forwarded-For`.

Without this, every public connection appears to come from the proxy and the
per-IP buckets are shared by all clients — connections get terminated right
after the AUTH challenge and publishes fail. The current overrides are 30/s +
600/min for new connections and 240 messages/min per IP; see `settings.yaml`
for why they are no longer tied to mesh read latency.

## nginx per-IP connection limits

The relay vhosts and the limit zones live in the **host nginx repo**,
`formstr-hq/nginx-72.61.138.38` (checked out at `/etc/nginx` on the host):

| File | Host path |
|---|---|
| `conf.d/relay-limits.conf` | `/etc/nginx/conf.d/relay-limits.conf` |
| `sites-enabled/relay.stg.formstr.app` | `/etc/nginx/sites-enabled/relay.stg.formstr.app` |
| `sites-enabled/relay.formstr.app` | `/etc/nginx/sites-enabled/relay.formstr.app` |

Both hostnames proxy to the same backend (`127.0.0.1:8008`), so one set of
limits covers both.

Why this existed: when reads went through pg-gateway, nostream held a DB-pool
connection for the whole mesh round trip (p99 ~3.7 s). On 2026-09-18 one client
opened and abandoned hundreds of connections (~600 aborts in 30 min), which
starved the pool and wedged every write relay-wide with `KnexTimeoutError`
until nostream was restarted. nostream has no IP blacklist — `ipWhitelist` only
*exempts* IPs from its limiter — so the cap was put at nginx.

That bottleneck is gone: reads now come from central Postgres and return a
connection in ~1 ms. **`limit_conn` is per IP, not global**, so do not read the
number below as the relay's total capacity:

```nginx
limit_conn relay_conn 30;               # per IP; 3-5x the old value, start here
limit_conn relay_total 400;             # optional global cap for this vhost
limit_req  zone=relay_connrate burst=60 nodelay;
```

and in `conf.d/relay-limits.conf`:

```nginx
limit_conn_zone $binary_remote_addr zone=relay_conn:10m;
limit_conn_zone $server_name       zone=relay_total:1m;
limit_req_zone  $binary_remote_addr zone=relay_connrate:10m rate=30r/s;
```

A normal client still uses 1–2 connections, but mobile-carrier NAT can put many
users behind one address, and clients legitimately open several subscriptions
per connection. The real total is bounded by nginx `worker_connections`
(768/worker; a proxied WebSocket uses ~2), relay fd/memory, and Postgres
connections. `RR0_DB_MAX_POOL_SIZE` is a **shared pool**, not per IP. The full
sizing rationale and verification steps are in `docs/RELAY_READ_SCALING.md` in
the orchestrator repo.

Edit on the host and push:

```bash
cd /etc/nginx
$EDITOR sites-enabled/relay.stg.formstr.app   # or conf.d/relay-limits.conf
nginx -t && nginx -s reload
git add -A && git commit -m "..." && git push origin master
```

## Verify

```bash
docker compose ps
curl -s http://127.0.0.1:8008/ -H 'Accept: application/nostr+json' | head -c 200
docker exec nso_nostream_cache redis-cli -a "$REDIS_PASSWORD" --no-auth-warning \
  KEYS '*:connection:*' | head
```

Rate-limit keys should show real client IPs, not `172.28.0.1`.
