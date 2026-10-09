/**
 * Moderation quarantine columns on `events`.
 *
 * A quarantined event keeps its row (so an operator can review and overturn it
 * within the window) but is hidden from REQ/COUNT/live broadcasts and is
 * hard-deleted by the maintenance sweep once `quarantineSeconds` elapses.
 *
 * `quarantined_at` is the source of truth; `moderation_reason` records which
 * rule matched, and the `moderation_overturned_at` / `moderation_reviewed_by`
 * columns record the human decision so the sweep can skip restored rows.
 *
 * All columns are nullable and the indexes are partial, so the migration is
 * additive and does not lock the table for existing rows.
 */

exports.config = { transaction: false }

exports.up = async function (knex) {
  await knex.schema.alterTable('events', (table) => {
    table.timestamp('quarantined_at', { useTz: false }).nullable()
    table.string('moderation_reason', 64).nullable()
    table.timestamp('moderation_overturned_at', { useTz: false }).nullable()
    table.binary('moderation_reviewed_by', 32).nullable()
  })

  // Supports the maintenance sweep:
  //   WHERE quarantined_at IS NOT NULL AND quarantined_at < cutoff
  //   AND moderation_overturned_at IS NULL
  // Partial: only quarantined rows are indexed, which is a tiny fraction.
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS events_quarantined_at_partial_idx
    ON events (quarantined_at)
    WHERE quarantined_at IS NOT NULL
  `)
}

exports.down = async function (knex) {
  await knex.schema.alterTable('events', (table) => {
    table.dropColumn('quarantined_at')
    table.dropColumn('moderation_reason')
    table.dropColumn('moderation_overturned_at')
    table.dropColumn('moderation_reviewed_by')
  })
}
