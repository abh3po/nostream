export interface IRateLimiterOptions {
  period: number
  rate: number
}

/**
 * Outcome of a rate-limit check.
 *
 * `limited` is the boolean the limiters have always returned. `retryAfterMs` is
 * how long until the current window frees a slot, which callers surface to
 * clients (an EVENT gets it in its NIP-20 OK message) so a client knows whether
 * to back off for a second or a minute instead of retrying blindly.
 */
export interface IRateLimitResult {
  limited: boolean
  retryAfterMs?: number
}

export interface IRateLimiter {
  hit(key: string, step: number, options: IRateLimiterOptions): Promise<boolean>
  /**
   * Optional richer form of {@link hit} that also reports how long until the
   * caller may retry. Implementations that can compute a wait should provide
   * it; callers fall back to `hit` when absent.
   */
  check?(key: string, step: number, options: IRateLimiterOptions): Promise<IRateLimitResult>
}
