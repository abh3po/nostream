import chai from 'chai'
import Sinon from 'sinon'

import { Event } from '../../../src/@types/event'
import { Settings } from '../../../src/@types/settings'
import { ModerationService } from '../../../src/services/moderation-service'

const { expect } = chai

const FIXED_NOW = 1_700_000_000

const makeEvent = (overrides: Partial<Event> = {}): Event =>
  ({
    id: 'f'.repeat(64),
    pubkey: 'a'.repeat(64),
    created_at: FIXED_NOW,
    kind: 1,
    tags: [],
    sig: 'f'.repeat(128),
    content: 'hello world',
    ...overrides,
  }) as Event

const makeService = (moderation: Settings['moderation']) =>
  new ModerationService(() => ({ moderation }) as Settings)

describe('ModerationService', () => {
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    sandbox.useFakeTimers(FIXED_NOW * 1000)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('returns undefined when moderation is disabled', () => {
    const service = makeService({ enabled: false, rules: { appStorePromo: { enabled: true } } })
    const event = makeEvent({ content: 'check https://play.google.com/store/apps/details?id=x #gamedev #android #indiedev' })
    expect(service.evaluate(event)).to.equal(undefined)
  })

  it('flags app-store promo with marketing hashtags', () => {
    const service = makeService({ enabled: true })
    const event = makeEvent({
      content: 'My game! https://play.google.com/store/apps/details?id=com.x #gamedev #indiedev #solodev',
    })
    expect(service.evaluate(event)).to.deep.equal({ action: 'quarantine', rule: 'app_store_promo' })
  })

  it('does not flag an ordinary note mentioning the play store once', () => {
    const service = makeService({ enabled: true })
    const event = makeEvent({ content: 'I found this app useful: https://play.google.com/store/apps/details?id=com.x' })
    expect(service.evaluate(event)).to.equal(undefined)
  })

  it('flags self-promo boilerplate', () => {
    const service = makeService({ enabled: true })
    const event = makeEvent({ content: '🎮 I built 80+ Android apps as a solo developer from South Korea!' })
    expect(service.evaluate(event)).to.deep.equal({ action: 'quarantine', rule: 'self_promo_boilerplate' })
  })

  it('flags a link flood', () => {
    const service = makeService({ enabled: true })
    const event = makeEvent({ content: 'see https://a.com https://b.com https://c.com https://d.com' })
    expect(service.evaluate(event)).to.deep.equal({ action: 'quarantine', rule: 'link_flood' })
  })

  it('flags hashtag stuffing', () => {
    const service = makeService({ enabled: true })
    const event = makeEvent({ content: '#a #b #c #d #e #f #g #h' })
    expect(service.evaluate(event)).to.deep.equal({ action: 'quarantine', rule: 'hashtag_stuffing' })
  })

  it('flags the bitcoin block fee template', () => {
    const service = makeService({ enabled: true })
    const event = makeEvent({
      content:
        'Block 974759\n\n4 - high priority\n4 - medium priority\n4 - low priority\n2 - no priority\n1 - purging\n\n#bitcoinfees #mempool',
    })
    expect(service.evaluate(event)).to.deep.equal({ action: 'quarantine', rule: 'bitcoin_block_fees' })
  })

  it('never scans encrypted kinds', () => {
    const service = makeService({ enabled: true, scanKinds: [1] })
    const event = makeEvent({ kind: 4, content: 'see https://a.com https://b.com https://c.com https://d.com' })
    expect(service.evaluate(event)).to.equal(undefined)
  })

  it('respects the configured action for a rule', () => {
    const service = makeService({ enabled: true, rules: { linkFlood: { action: 'reject' } } })
    const event = makeEvent({ content: 'https://a.com https://b.com https://c.com https://d.com' })
    expect(service.evaluate(event)).to.deep.equal({ action: 'reject', rule: 'link_flood' })
  })

  it('flags a duplicate-template burst once the threshold is reached', () => {
    const service = makeService({ enabled: true, duplicateBurst: { enabled: true, minCount: 3, windowSeconds: 86400 } })
    const base = makeEvent({ content: 'Buy my thing at https://spam.example/1' })

    expect(service.evaluate(base)).to.equal(undefined)
    expect(service.evaluate(makeEvent({ content: 'Buy my thing at https://spam.example/2' }))).to.equal(undefined)
    expect(service.evaluate(makeEvent({ content: 'Buy my thing at https://spam.example/3' }))).to.deep.equal({
      action: 'quarantine',
      rule: 'duplicate_burst',
    })
  })

  it('does not treat a single varied note as a burst', () => {
    const service = makeService({ enabled: true, duplicateBurst: { enabled: true, minCount: 3 } })
    expect(service.evaluate(makeEvent({ content: 'one' }))).to.equal(undefined)
    expect(service.evaluate(makeEvent({ content: 'two' }))).to.equal(undefined)
    expect(service.evaluate(makeEvent({ content: 'three' }))).to.equal(undefined)
  })

  it('never flags replaceable events as a burst (they are updates)', () => {
    const service = makeService({ enabled: true, duplicateBurst: { enabled: true, minCount: 2 } })
    for (let i = 0; i < 5; i++) {
      expect(service.evaluate(makeEvent({ kind: 0, content: '{"name":"bridge"}' }))).to.equal(undefined)
    }
    for (let i = 0; i < 5; i++) {
      expect(service.evaluate(makeEvent({ kind: 30078 as any, content: i === 0 ? '["a","b"]' : '["a","c"]' }))).to.equal(undefined)
    }
  })

  it('honors scanKinds for duplicate bursts', () => {
    const service = makeService({
      enabled: true,
      scanKinds: [1],
      duplicateBurst: { enabled: true, minCount: 2 },
    })
    for (let i = 0; i < 5; i++) {
      expect(service.evaluate(makeEvent({ kind: 24133 as any, content: 'same rpc blob' }))).to.equal(undefined)
    }
  })

  it('does not collide distinct long payloads sharing a prefix', () => {
    const service = makeService({ enabled: true, duplicateBurst: { enabled: true, minCount: 2 } })
    const prefix = 'x'.repeat(5000)
    expect(service.evaluate(makeEvent({ content: `${prefix}-alpha` }))).to.equal(undefined)
    expect(service.evaluate(makeEvent({ content: `${prefix}-beta` }))).to.equal(undefined)
  })

  it('quarantines an author after enough distinct reporters flag them', () => {
    const service = makeService({ enabled: true, reportQuorum: { enabled: true, minReporters: 2, windowSeconds: 604800 } })
    const target = 'b'.repeat(64)

    const report = (reporter: string) =>
      makeEvent({
        kind: 1984,
        pubkey: reporter,
        tags: [['p', target, 'spam']],
      })

    service.recordReport(report('1'.repeat(64)))
    expect(service.evaluate(makeEvent({ pubkey: target, content: 'normal note here' }))).to.equal(undefined)

    service.recordReport(report('2'.repeat(64)))
    expect(service.evaluate(makeEvent({ pubkey: target, content: 'normal note here' }))).to.deep.equal({
      action: 'quarantine',
      rule: 'report_quorum',
    })
  })

  it('ignores report types outside the configured set', () => {
    const service = makeService({ enabled: true, reportQuorum: { enabled: true, minReporters: 1 } })
    const target = 'c'.repeat(64)
    service.recordReport(makeEvent({ kind: 1984, pubkey: '1'.repeat(64), tags: [['p', target, 'illegal']] }))
    expect(service.evaluate(makeEvent({ pubkey: target, content: 'normal note here' }))).to.equal(undefined)
  })
})
