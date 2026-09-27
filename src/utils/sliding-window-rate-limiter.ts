import { IRateLimiter, IRateLimiterOptions, IRateLimitResult } from '../@types/utils'
import { createLogger } from '../factories/logger-factory'
import { ICacheAdapter } from '../@types/adapters'

const logger = createLogger('sliding-window-rate-limiter')

// Returns the remaining wait in milliseconds, or 0 when the hit was allowed.
//
// Previously this returned 1/0 (limited/allowed), which told the caller *that*
// it was limited but not *how long* — so a rate-limited write could only be
// refused with a bare notice. Returning the remaining window lets the relay
// send a NIP-20 OK of `false` with a retry hint, which is what clients
// actually act on.
//
// The remaining time is the difference between now and the moment the oldest
// entry still inside the window ages out.
const SLIDING_WINDOW_RATE_LIMITER_LUA_SCRIPT = `
      local key = KEYS[1]
      local timestamp = tonumber(ARGV[1])
      local period = tonumber(ARGV[2])
      local step = tonumber(ARGV[3])
      local max_rate = tonumber(ARGV[4])

      local windowStart = timestamp - period

      redis.call('ZREMRANGEBYSCORE', key, 0, windowStart)

      local entries = redis.call('ZRANGE', key, 0, -1)
      local hits = 0
      for i=1, #entries do
          local step_str = string.match(entries[i], "^[^:]+:([^:]+)")
          if step_str then
              local entry_step = tonumber(step_str)
              if entry_step then
                  hits = hits + entry_step
              end
          end
      end

      if hits + step > max_rate then
          -- When will enough of the window have aged out to admit this hit?
          -- Walk entries oldest-first accumulating released budget.
          local needed = hits + step - max_rate
          local released = 0
          local retry_at = timestamp
          for i=1, #entries do
              local entry_ts_str, entry_step_str = string.match(entries[i], "^([^:]+):([^:]+)")
              if entry_ts_str and entry_step_str then
                  local entry_ts = tonumber(entry_ts_str)
                  local entry_step = tonumber(entry_step_str)
                  if entry_ts and entry_step then
                      released = released + entry_step
                      if released >= needed then
                          retry_at = entry_ts + period
                          break
                      end
                  end
              end
          end
          local wait = retry_at - timestamp
          if wait < 0 then wait = 0 end
          return wait
      end

      local base_member = timestamp .. ':' .. step
      local member = base_member
      local counter = 0
      while redis.call('ZSCORE', key, member) do
          counter = counter + 1
          member = base_member .. ':' .. counter
      end

      redis.call('ZADD', key, timestamp, member)
      redis.call('PEXPIRE', key, period)

      return 0
`

export class SlidingWindowRateLimiter implements IRateLimiter {
  public constructor(
    private readonly cache: ICacheAdapter,
  ) { }

  public async hit(key: string, step: number, options: IRateLimiterOptions): Promise<boolean> {
    return (await this.check(key, step, options)).limited
  }

  /**
   * Like {@link hit}, but reports how long until the caller may retry.
   * `hit` stays as the boolean API for existing callers.
   */
  public async check(key: string, step: number, options: IRateLimiterOptions): Promise<IRateLimitResult> {
    const timestamp = Date.now()
    const { period, rate } = options

    const result = await this.cache.eval(SLIDING_WINDOW_RATE_LIMITER_LUA_SCRIPT, [key], [
      timestamp.toString(),
      period.toString(),
      step.toString(),
      rate.toString(),
    ])

    const waitMs = Number(result) || 0
    const limited = waitMs > 0

    logger('hit on %s bucket: is rate limited? %s (wait %dms)', key, limited, waitMs)

    return { limited, retryAfterMs: limited ? waitMs : undefined }
  }
}
