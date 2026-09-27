import { IRateLimiter, IRateLimiterOptions, IRateLimitResult } from '../@types/utils'
import { createLogger } from '../factories/logger-factory'
import { ICacheAdapter } from '../@types/adapters'

const debug = createLogger('ewma-rate-limiter')

const rateLimitScript = {
    NUMBER_OF_KEYS: 1,
    // Returns `{allowed, projectedRate}`. Reporting the projected smoothed rate
    // lets the caller compute how long until it decays back under the limit
    // (see `check`), which is what a rejected client is told to wait.
    //
    // A refused hit is NOT recorded: recording it would keep inflating the
    // average and extend the block for a client that is already backing off.
    SCRIPT: `
      local key = KEYS[1]
      local timestamp = tonumber(ARGV[1])
      local rate = tonumber(ARGV[2])
      local period = tonumber(ARGV[3])
      local R_old = tonumber(redis.call('HGET', key, 'rate')) or 0
      local T_old = tonumber(redis.call('HGET', key, 'timestamp')) or timestamp

      local deltaT = timestamp - T_old
      local lambda = math.log(2) / period
      local R_new  = R_old * math.exp(-lambda * deltaT) + tonumber(ARGV[4])

      if R_new > rate then
          return {0, tostring(R_new)}
      end

      redis.call('HSET', key, 'rate', R_new, 'timestamp', timestamp)
      redis.call('EXPIRE', key, math.ceil(period / 1000))

      return {1, tostring(R_new)}
    `,
  }

export const calculateEWMA = (
  rOld: number,
  deltaT: number,
  period: number,
  step: number
): number => {
  const lambda = Math.log(2) / period
  return rOld * Math.exp(-lambda * deltaT) + step
}

export class EWMARateLimiter implements IRateLimiter {
  public constructor(
    private readonly cache: ICacheAdapter,
  ) {}

  public async hit(
    key: string,
    step: number,
    options: IRateLimiterOptions,
  ): Promise<boolean> {
    return (await this.check(key, step, options)).limited
  }

  /**
   * Like {@link hit}, but reports how long until the smoothed rate decays back
   * under the limit.
   *
   * The EWMA follows `R(t) = R_0 * e^(-lambda t)`, so it falls back to `rate`
   * after `t = ln(R / rate) / lambda`. That is the hint surfaced to clients.
   */
  public async check(
    key: string,
    step: number,
    options: IRateLimiterOptions,
  ): Promise<IRateLimitResult> {
    const { rate, period } = options

    const result = await this.cache.eval(rateLimitScript.SCRIPT,
       [key],
       [Date.now().toString(), rate.toString(), period.toString(), step.toString()]
    )

    // Redis returns the two-element table; tolerate a scalar from older caches.
    const tuple = Array.isArray(result) ? result : [result, rate]
    const allowed = Number(tuple[0]) === 1
    const projectedRate = Number(tuple[1]) || rate

    debug('ewma rate limited on %s bucket: %s', key, allowed ? 'no' : 'yes')

    if (allowed) {
      return { limited: false }
    }

    const lambda = Math.log(2) / period
    const waitMs = projectedRate > rate && lambda > 0
      ? Math.ceil(Math.log(projectedRate / rate) / lambda)
      : 0

    return { limited: true, retryAfterMs: Math.max(0, waitMs) }
  }

}
