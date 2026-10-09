import { DBEvent } from '../@types/event'
import { fromBuffer } from './transform'

export interface ModeratedEventRecord {
  id: string
  pubkey: string
  kind: number
  created_at: number
  content: string
  tags: string[][]
  sig: string
  reason: string | null
  quarantinedAt: string | null
  overturnedAt: string | null
  reviewedBy: string | null
}

/**
 * Wire shape for a quarantined event. Includes the full Nostr event so an
 * operator can judge it in the UI, plus the moderation metadata. `reviewedBy`
 * is hex-encoded for consistency with Nostr pubkeys.
 */
export const serializeModeratedEvent = (row: DBEvent): ModeratedEventRecord => ({
  id: fromBuffer(row.event_id),
  pubkey: fromBuffer(row.event_pubkey),
  kind: row.event_kind,
  created_at: row.event_created_at,
  content: row.event_content,
  tags: row.event_tags,
  sig: fromBuffer(row.event_signature),
  reason: row.moderation_reason ?? null,
  quarantinedAt: row.quarantined_at ? new Date(row.quarantined_at).toISOString() : null,
  overturnedAt: row.moderation_overturned_at ? new Date(row.moderation_overturned_at).toISOString() : null,
  reviewedBy: row.moderation_reviewed_by ? fromBuffer(row.moderation_reviewed_by) : null,
})
