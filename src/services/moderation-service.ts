import { Event } from '../@types/event'
import { ModerationAction, ModerationSettings, Settings } from '../@types/settings'
import { EventKinds, EventTags } from '../constants/base'
import { createHash } from 'crypto'
import { createLogger } from '../factories/logger-factory'
import {
  contentFingerprint,
  evaluateContentRules,
  isReplaceableKind,
  isScannableKind,
  ModerationRule,
} from '../utils/moderation'

const logger = createLogger('moderation-service')

const DEFAULT_DUPLICATE_MIN_COUNT = 5
const DEFAULT_DUPLICATE_WINDOW_SECONDS = 86400
const DEFAULT_REPORT_MIN_REPORTERS = 3
const DEFAULT_REPORT_WINDOW_SECONDS = 604800
const DEFAULT_REPORT_TYPES = ['spam', 'profanity']
/**
 * Upper bound on tracked duplicate-burst fingerprints per worker. Entries are
 * pruned lazily by age; this cap is a backstop against pathological variety.
 */
const MAX_TRACKED_BUCKETS = 50000
const MAX_TRACKED_REPORTED_PUBKEYS = 50000

export type ModerationDecisionRule = ModerationRule | 'duplicate_burst' | 'report_quorum'

export interface ModerationDecision {
  action: ModerationAction
  rule: ModerationDecisionRule
}

/**
 * Relay-side moderation: decides whether an incoming event should be hidden.
 *
 * Stateless per-event rules live in `utils/moderation`; the only state here is
 * the per-worker duplicate-burst window. That state is deliberately in-memory
 * and process-local: a burst of identical notes almost always lands on one
 * worker, the cost of missing a cross-worker duplicate is low, and avoiding a
 * shared store keeps the hot publish path free of extra I/O. Each worker prunes
 * by age on write, so the map stays bounded without a maintenance coupling.
 */
export class ModerationService {
  private readonly duplicateBuckets = new Map<string, number[]>()
  /** reported pubkey -> reporter pubkey -> latest report timestamp. */
  private readonly reportsByTarget = new Map<string, Map<string, number>>()

  public constructor(private readonly settings: () => Settings) {}

  /**
   * Returns the moderation decision for an event, or `undefined` when the event
   * is clean or moderation is disabled.
   */
  public evaluate(event: Event): ModerationDecision | undefined {
    const moderation = this.settings().moderation
    if (!moderation?.enabled) {
      return undefined
    }

    const rule = evaluateContentRules(event, moderation)
    if (rule) {
      return { action: resolveRuleAction(moderation, rule), rule }
    }

    const duplicate = this.evaluateDuplicateBurst(event, moderation)
    if (duplicate) {
      return duplicate
    }

    return this.evaluateReportQuorum(event, moderation)
  }

  /**
   * Record a NIP-56 report so that a pubkey flagged by enough distinct
   * reporters is quarantined. Called for accepted kind-1984 events.
   */
  public recordReport(report: Event): void {
    const moderation = this.settings().moderation
    if (!moderation?.enabled) {
      return
    }

    const quorum = moderation.reportQuorum
    if (!quorum || quorum.enabled === false) {
      return
    }

    if (report.kind !== EventKinds.REPORT) {
      return
    }

    const allowedTypes = moderation.reportTypes ?? DEFAULT_REPORT_TYPES
    const now = Math.floor(Date.now() / 1000)

    for (const tag of report.tags ?? []) {
      if (tag[0] !== EventTags.Pubkey || typeof tag[1] !== 'string') {
        continue
      }

      const reportType = typeof tag[2] === 'string' ? tag[2].toLowerCase() : ''
      if (reportType.length > 0 && !allowedTypes.includes(reportType)) {
        continue
      }

      const target = tag[1].toLowerCase()
      let reporters = this.reportsByTarget.get(target)
      if (!reporters) {
        reporters = new Map()
        this.reportsByTarget.set(target, reporters)

        if (this.reportsByTarget.size > MAX_TRACKED_REPORTED_PUBKEYS) {
          this.pruneReports(now - (quorum.windowSeconds ?? DEFAULT_REPORT_WINDOW_SECONDS))
        }
      }

      reporters.set(report.pubkey.toLowerCase(), now)
    }
  }

  private evaluateReportQuorum(event: Event, moderation: ModerationSettings): ModerationDecision | undefined {
    const quorum = moderation.reportQuorum
    if (!quorum || quorum.enabled === false) {
      return undefined
    }

    // Same scan allowlist as the content rules: never act on kinds the
    // operator has excluded (encrypted kinds above all).
    if (!isScannableKind(event.kind, moderation.scanKinds)) {
      return undefined
    }

    const windowSeconds = quorum.windowSeconds ?? DEFAULT_REPORT_WINDOW_SECONDS
    const minReporters = quorum.minReporters ?? DEFAULT_REPORT_MIN_REPORTERS
    const reporters = this.reportsByTarget.get(event.pubkey.toLowerCase())
    if (!reporters) {
      return undefined
    }

    const cutoff = Math.floor(Date.now() / 1000) - windowSeconds
    const distinct = [...reporters.values()].filter((timestamp) => timestamp >= cutoff).length
    if (distinct < minReporters) {
      return undefined
    }

    logger('report-quorum: pubkey %s flagged by %d distinct reporters', event.pubkey, distinct)
    return { action: quorum.action ?? 'quarantine', rule: 'report_quorum' }
  }

  private pruneReports(cutoff: number): void {
    for (const [target, reporters] of this.reportsByTarget) {
      for (const [reporter, timestamp] of reporters) {
        if (timestamp < cutoff) {
          reporters.delete(reporter)
        }
      }
      if (reporters.size === 0) {
        this.reportsByTarget.delete(target)
      }
      if (this.reportsByTarget.size <= MAX_TRACKED_REPORTED_PUBKEYS) {
        return
      }
    }
  }

  private evaluateDuplicateBurst(event: Event, moderation: ModerationSettings): ModerationDecision | undefined {
    const burst = moderation.duplicateBurst
    if (!burst || burst.enabled === false) {
      return undefined
    }

    // Honor the same scan allowlist as the content rules. Without this the
    // rule ran on every kind, including kinds deliberately excluded.
    if (!isScannableKind(event.kind, moderation.scanKinds)) {
      return undefined
    }

    // Replaceable and parameterized-replaceable events (0, 3, 10000-19999,
    // 30000-39999) are an *update* by design: re-sending one is normal relay
    // behaviour, not a burst. Excluding them removes the false positives seen
    // on kind-0 profiles and kind-30078 blobs.
    if (isReplaceableKind(event.kind)) {
      return undefined
    }

    if (typeof event.content !== 'string' || event.content.length === 0) {
      return undefined
    }

    const windowSeconds = burst.windowSeconds ?? DEFAULT_DUPLICATE_WINDOW_SECONDS
    const minCount = burst.minCount ?? DEFAULT_DUPLICATE_MIN_COUNT
    if (!Number.isFinite(windowSeconds) || windowSeconds <= 0 || minCount < 1) {
      return undefined
    }

    const now = Math.floor(Date.now() / 1000)
    const cutoff = now - windowSeconds
    // Hash the full normalized content: truncating collided distinct payloads.
    const fingerprint = createHash('sha256').update(contentFingerprint(event.content)).digest('hex')
    const key = `${event.pubkey}:${fingerprint}`

    const bucket = (this.duplicateBuckets.get(key) ?? []).filter((timestamp) => timestamp >= cutoff)
    bucket.push(now)
    this.duplicateBuckets.set(key, bucket)
    this.pruneBuckets(cutoff)

    if (bucket.length >= minCount) {
      logger(
        'duplicate-burst: author %s posted %d matching notes within %ds',
        event.pubkey,
        bucket.length,
        windowSeconds,
      )
      return { action: burst.action ?? 'quarantine', rule: 'duplicate_burst' }
    }

    return undefined
  }

  private pruneBuckets(cutoff: number): void {
    if (this.duplicateBuckets.size <= MAX_TRACKED_BUCKETS) {
      return
    }

    for (const [key, timestamps] of this.duplicateBuckets) {
      const newest = timestamps[timestamps.length - 1] ?? 0
      if (newest < cutoff) {
        this.duplicateBuckets.delete(key)
      }
      if (this.duplicateBuckets.size <= MAX_TRACKED_BUCKETS) {
        return
      }
    }
  }

  /** Exposed for tests. */
  public trackedBuckets(): number {
    return this.duplicateBuckets.size
  }
}

const resolveRuleAction = (moderation: ModerationSettings, rule: ModerationRule): ModerationAction => {
  const rules = moderation.rules
  switch (rule) {
    case 'app_store_promo':
      return rules?.appStorePromo?.action ?? 'quarantine'
    case 'self_promo_boilerplate':
      return rules?.selfPromoBoilerplate?.action ?? 'quarantine'
    case 'link_flood':
      return rules?.linkFlood?.action ?? 'quarantine'
    case 'hashtag_stuffing':
      return rules?.hashtagStuffing?.action ?? 'quarantine'
    default:
      return 'quarantine'
  }
}
