import { expect } from 'chai'
import Sinon from 'sinon'

import { calculateEWMA, EWMARateLimiter } from '../../../src/utils/ewma-rate-limiter'
import { ICacheAdapter } from '../../../src/@types/adapters'
import { IRateLimiter } from '../../../src/@types/utils'

describe('EWMARateLimiter', () => {
  let clock: Sinon.SinonFakeTimers
  let cache: ICacheAdapter
  let rateLimiter: IRateLimiter

  let evalStub: Sinon.SinonStub
  let sandbox: Sinon.SinonSandbox

  beforeEach(() => {
    sandbox = Sinon.createSandbox()
    clock = sandbox.useFakeTimers(1665546189000)
    evalStub = sandbox.stub()
    cache = {
        eval: evalStub,
    } as unknown as ICacheAdapter
    rateLimiter = new EWMARateLimiter(cache)
  })

  afterEach(() => {
    clock.restore()
    sandbox.restore()
  })
    describe('calculateEWMA', () => {
        it('returns 1 on first request with no history', () => {
        const result = calculateEWMA(0, 0, 120000, 1)
        expect(result).to.equal(1)
        })

        it('increases rate on burst requests with no time gap', () => {
        const first = calculateEWMA(0, 0, 120000, 1)
        const second = calculateEWMA(first, 0, 120000, 1)
        const third = calculateEWMA(second, 0, 120000, 1)

        expect(third).to.be.greaterThan(first)
        })

        it('decays rate after time gap', () => {
        const rateAfterBurst = calculateEWMA(10, 0, 120000, 1)
        const rateAfterGap = calculateEWMA(rateAfterBurst, 120000, 120000, 1)

        expect(rateAfterGap).to.be.lessThan(rateAfterBurst)
        })

        it('rate approaches 1 after very long inactivity', () => {
        const rateAfterBurst = calculateEWMA(10, 0, 120000, 1)
        const rateAfterLongGap = calculateEWMA(rateAfterBurst, 9999999, 120000, 1)

        expect(rateAfterLongGap).to.be.closeTo(1, 0.001)
        })
    })

    describe('hit', () => {
        it('returns false on first request', async () => {
        // The script now returns {allowed, projectedRate}: [1, rate] = allowed.
        evalStub.resolves([1, '1.5'])
        const result = await rateLimiter.hit('key', 1, { period: 120000, rate: 10 })
        expect(result).to.be.false
        })

        it('returns true when rate limit exceeded', async () => {
        // [0, rate] = refused, projectedRate above the limit.
        evalStub.resolves([0, '42'])
        const result = await rateLimiter.hit('key', 1, { period: 120000, rate: 10 })
        expect(result).to.be.true
        })

        it('check reports a decay-based wait when refused', async () => {
        evalStub.resolves([0, '40'])
        const result = await rateLimiter.check('key', 1, { period: 120000, rate: 10 })
        expect(result.limited).to.be.true
        // R(t) = R0 * e^(-lambda t) reaches `rate` after ln(R0/rate)/lambda,
        // with lambda = ln(2)/period. For R0=40, rate=10, period=120000 that
        // is ln(4)/ln(2) * 120000 = 240000ms. The implementation ceils to a
        // whole ms so a client never retries a hair too early.
        expect(result.retryAfterMs).to.be.closeTo(240000, 2)
        })

        it('always reports a wait when refused, even at the limit', async () => {
        // projectedRate == rate: the refused *step* is what would push it over,
        // so the decay formula yields 0. A client must still be told to wait.
        evalStub.resolves([0, '10'])
        const result = await rateLimiter.check('key', 1, { period: 120000, rate: 10 })
        expect(result.limited).to.be.true
        expect(result.retryAfterMs).to.be.greaterThan(0)
        })

        it('check reports no wait when allowed', async () => {
        evalStub.resolves([1, '1'])
        const result = await rateLimiter.check('key', 1, { period: 120000, rate: 10 })
        expect(result.limited).to.be.false
        expect(result.retryAfterMs).to.equal(undefined)
        })

        it('tolerates a scalar reply from an older cache', async () => {
        // Defensive: if the script is still the old 1/0 form, a 1 means allowed.
        evalStub.resolves(1)
        const result = await rateLimiter.check('key', 1, { period: 120000, rate: 10 })
        expect(result.limited).to.be.false
        })
    })
})
