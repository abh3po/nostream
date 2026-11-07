import chai from 'chai'

import {
  contentFingerprint,
  countHashtags,
  countUrls,
  DEFAULT_CONTENT_RULE_THRESHOLDS,
  evaluateContentRules,
} from '../../../src/utils/moderation'

const { expect } = chai

const base = { kind: 1 as const }
const enabled = { enabled: true } as const

describe('utils/moderation', () => {
  it('returns undefined when moderation is disabled', () => {
    expect(
      evaluateContentRules({ ...base, content: '#a #b #c #d #e #f #g #h' } as any, { enabled: false }),
    ).to.equal(undefined)
  })

  it('scans only configured kinds', () => {
    const moderation = { enabled: true, scanKinds: [1] as const }
    const event = { kind: 30023 as any, content: 'https://a.com https://b.com https://c.com https://d.com' }
    expect(evaluateContentRules(event as any, moderation as any)).to.equal(undefined)
  })

  it('honours a per-rule disable', () => {
    const moderation = { enabled: true, rules: { linkFlood: { enabled: false } } }
    const event = { ...base, content: 'https://a.com https://b.com https://c.com https://d.com' }
    expect(evaluateContentRules(event, moderation as any)).to.equal(undefined)
  })

  it('counts urls and hashtags', () => {
    expect(countUrls('a https://x.com b https://y.com')).to.equal(2)
    expect(countHashtags('a #one #two #three')).to.equal(3)
  })

  it('fingerprints content ignoring urls, long numbers and whitespace', () => {
    const a = contentFingerprint('Buy  now!  https://a.com/1234567890   extra')
    const b = contentFingerprint('Buy now! https://b.com/9999999999 extra')
    expect(a).to.equal(b)
  })

  it('flags an app-store link with two marketing hashtags', () => {
    const event = { ...base, content: 'https://play.google.com/store/apps/details?id=x #gamedev #indiedev' }
    expect(evaluateContentRules(event, enabled as any)).to.equal('app_store_promo')
  })

  it('does not flag a single app-store link with no promotion', () => {
    const event = { ...base, content: 'https://play.google.com/store/apps/details?id=x' }
    expect(evaluateContentRules(event, enabled as any)).to.equal(undefined)
  })

  it('respects custom thresholds', () => {
    const event = { ...base, content: 'https://a.com https://b.com https://c.com' }
    expect(
      evaluateContentRules(event, enabled as any, { ...DEFAULT_CONTENT_RULE_THRESHOLDS, linkFloodMinUrls: 3 }),
    ).to.equal('link_flood')
  })

  it('flags the bitcoin block fee template', () => {
    const content = [
      'Block 974759',
      '',
      '4 - high priority',
      '4 - medium priority',
      '4 - low priority',
      '2 - no priority',
      '1 - purging',
      '',
      '#bitcoinfees #mempool',
    ].join('\n')
    expect(evaluateContentRules({ ...base, content }, enabled as any)).to.equal('bitcoin_block_fees')
  })

  it('does not flag a fee summary without the block header', () => {
    const content = '4 - high priority\n4 - medium priority\n4 - low priority\n#bitcoinfees #mempool'
    expect(evaluateContentRules({ ...base, content }, enabled as any)).to.equal(undefined)
  })

  it('does not flag a fee summary without the fee hashtags', () => {
    const content = 'Block 974759\n\n4 - high priority\n4 - medium priority\n4 - low priority'
    expect(evaluateContentRules({ ...base, content }, enabled as any)).to.equal(undefined)
  })

  it('does not flag a normal note mentioning priorities and mempool', () => {
    const content = 'high priority fix landed; low priority mempool cleanup can wait'
    expect(evaluateContentRules({ ...base, content }, enabled as any)).to.equal(undefined)
  })
})
