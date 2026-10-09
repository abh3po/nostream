import { Event } from '../@types/event'
import { ModerationSettings } from '../@types/settings'

/**
 * Pure, dependency-free content rules for relay moderation.
 *
 * Design constraints (see MODERATION.md):
 * - Keyed on content shape, never on who the author is. No rule here needs an
 *   npub allowlist.
 * - Compiled for the hot publish path: every rule is a handful of regexes and
 *   string scans over one event, no I/O.
 * - Conservative: a normal human note should not trip any rule. The corpus used
 *   to calibrate these lives in the orchestrator repo's analysis notes; the
 *   only author caught by R1/R2 was a commercial app-marketing bot.
 */

const APP_STORE_URL =
  /(?:play\.google\.com\/store\/apps\/details|apps\.apple\.com\/[a-z-]+\/app|itunes\.apple\.com\/[a-z-]+\/app)/i
const PROMO_HASHTAGS = /#(?:gamedev|indiedev|solodev|mobilegames|indiegame|appdev|googleplay|android)\b/gi
const SELF_PROMO_BOILERPLATE =
  /\bi built\s+\d+\+?[^\n]{0,40}\b(?:apps|games)\b[^\n]{0,80}\b(?:solo|indie)\s+developer\b/i
const URL_RE = /https?:\/\/[^\s<>"')]+/gi
const HASHTAG_RE = /#[\p{L}\p{N}_]+/gu

export type ModerationRule =
  | 'app_store_promo'
  | 'self_promo_boilerplate'
  | 'link_flood'
  | 'hashtag_stuffing'

export interface ContentRuleThresholds {
  /** Minimum distinct links in one event to flag as a link flood. */
  linkFloodMinUrls: number
  /** Minimum hashtags, with little prose, to flag as hashtag stuffing. */
  hashtagStuffingMinTags: number
  /** Max non-tag, non-link prose characters before hashtag stuffing is excused. */
  hashtagStuffingMaxProse: number
}

export const DEFAULT_CONTENT_RULE_THRESHOLDS: ContentRuleThresholds = {
  linkFloodMinUrls: 4,
  hashtagStuffingMinTags: 8,
  hashtagStuffingMaxProse: 120,
}

export const countUrls = (content: string): number => (content.match(URL_RE) ?? []).length

export const countHashtags = (content: string): number => (content.match(HASHTAG_RE) ?? []).length

/**
 * Cheap, stable content skeleton used to detect an author blasting near-identical
 * notes. URLs, long digit runs and whitespace are replaced so formatting drift
 * does not hide a repeated template.
 *
 * The full normalized string is kept (no truncation): truncating collided two
 * genuinely different 67 KB payloads that shared a prefix, flagging them as
 * duplicates. Callers should hash this before storing it in a bucket key.
 */
export const contentFingerprint = (content: string): string =>
  content
    .toLowerCase()
    .replace(URL_RE, '<url>')
    .replace(/[0-9]{4,}/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()

/** Kinds that are an update by design (replaceable / parameterized-replaceable). */
export const isReplaceableKind = (kind: number): boolean =>
  kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000) || (kind >= 30000 && kind < 40000)

/** True when an event's kind is in the moderation `scanKinds` allowlist. */
export const isScannableKind = (
  kind: number,
  scannedKinds: ModerationSettings['scanKinds'],
): boolean =>
  !Array.isArray(scannedKinds) ||
  scannedKinds.some((entry) => (typeof entry === 'number' ? entry === kind : kind >= entry[0] && kind <= entry[1]))

const proseLength = (content: string): number =>
  content
    .replace(HASHTAG_RE, ' ')
    .replace(URL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim().length

const isRuleEnabled = (enabled: boolean | undefined): boolean => enabled !== false

/**
 * Evaluate the per-event content rules against a single event.
 *
 * Returns the first matching rule name, or `undefined` when the event is clean.
 * The caller decides whether to quarantine or reject; this function never
 * mutates and never performs I/O.
 */
export const evaluateContentRules = (
  event: Pick<Event, 'kind' | 'content'>,
  moderation: ModerationSettings | undefined,
  thresholds: ContentRuleThresholds = DEFAULT_CONTENT_RULE_THRESHOLDS,
): ModerationRule | undefined => {
  if (!moderation?.enabled) {
    return undefined
  }

  if (typeof event.content !== 'string' || event.content.length === 0) {
    return undefined
  }

  // Only plaintext note-like events carry scannable content. Encrypted kinds
  // (4, 1059) are opaque ciphertext and are never scanned.
  if (!isScannableKind(event.kind, moderation.scanKinds)) {
    return undefined
  }

  const rules = moderation.rules ?? {}
  const content = event.content

  if (isRuleEnabled(rules.appStorePromo?.enabled)) {
    if (APP_STORE_URL.test(content) && ((content.match(PROMO_HASHTAGS) ?? []).length >= 2 || countUrls(content) >= 2)) {
      return 'app_store_promo'
    }
  }

  if (isRuleEnabled(rules.selfPromoBoilerplate?.enabled)) {
    if (SELF_PROMO_BOILERPLATE.test(content)) {
      return 'self_promo_boilerplate'
    }
  }

  if (isRuleEnabled(rules.linkFlood?.enabled)) {
    if (countUrls(content) >= thresholds.linkFloodMinUrls) {
      return 'link_flood'
    }
  }

  if (isRuleEnabled(rules.hashtagStuffing?.enabled)) {
    if (
      countHashtags(content) >= thresholds.hashtagStuffingMinTags &&
      proseLength(content) < thresholds.hashtagStuffingMaxProse
    ) {
      return 'hashtag_stuffing'
    }
  }

  return undefined
}
