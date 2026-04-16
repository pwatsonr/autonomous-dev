/**
 * Slack Platform Rate Limit Handler.
 *
 * Wraps Slack Web API calls with automatic retry logic for rate-limited
 * (`ratelimited`) responses, respecting the `Retry-After` header.
 *
 * Slack API rate limit tiers (for reference):
 * - Tier 1: ~1 req/min  (admin-level methods)
 * - Tier 2: ~20 req/min (most methods)
 * - Tier 3: ~50 req/min (`chat.postMessage`, `chat.update`)
 * - Tier 4: ~100+ req/min (high-volume methods)
 *
 * Implements SPEC-008-4-04, Task 13.
 *
 * @module slack_rate_limiter
 */

// ---------------------------------------------------------------------------
// Logger (structured JSON to stderr, matching codebase conventions)
// ---------------------------------------------------------------------------

const logger = {
  info(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'info', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'warn', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
  error(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'error', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Default retry-after duration (in seconds) when the `Retry-After` header
 * is missing from a rate-limited response.
 *
 * Set to 30 seconds as a conservative default per Slack's recommendation.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

// ---------------------------------------------------------------------------
// SlackRateLimiter
// ---------------------------------------------------------------------------

/**
 * Rate limit handler for Slack Web API calls.
 *
 * Wraps an async function that makes a Slack API call. If the call fails
 * with a `ratelimited` error, the handler:
 *
 * 1. Extracts the `Retry-After` header from the error response.
 * 2. Falls back to {@link DEFAULT_RETRY_AFTER_SECONDS} if the header is missing.
 * 3. Logs the rate limit event at `warn` level.
 * 4. Waits for the specified duration.
 * 5. Retries the call once.
 *
 * Non-rate-limit errors are propagated immediately without retry.
 *
 * Usage:
 * ```typescript
 * const limiter = new SlackRateLimiter();
 * const result = await limiter.executeWithRateLimit(() =>
 *   web.chat.postMessage({ channel, text })
 * );
 * ```
 */
export class SlackRateLimiter {
  /**
   * Execute a Slack API call with automatic rate limit handling.
   *
   * @param fn - The async function that performs the Slack API call.
   * @returns The result of the API call.
   * @throws Re-throws non-rate-limit errors immediately. If the retry
   *         also fails, the second error is thrown.
   */
  async executeWithRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (this.isRateLimited(error)) {
        const retryAfter = this.extractRetryAfter(error);
        logger.warn('Slack rate limit hit', { retryAfter });
        await this.sleep(retryAfter * 1000);
        return fn(); // Retry once
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Internal: rate limit detection
  // -------------------------------------------------------------------------

  /**
   * Check whether an error is a Slack rate-limit error.
   *
   * Slack Web API rate-limited errors have:
   * - `code`: `'slack_webapi_platform_error'`
   * - `data.error`: `'ratelimited'`
   *
   * @param error - The caught error object.
   * @returns `true` if this is a rate-limit error.
   */
  isRateLimited(error: unknown): boolean {
    return (
      error !== null &&
      error !== undefined &&
      typeof error === 'object' &&
      'code' in error &&
      (error as Record<string, unknown>).code === 'slack_webapi_platform_error' &&
      typeof (error as Record<string, unknown>).data === 'object' &&
      (error as Record<string, Record<string, unknown>>).data?.error === 'ratelimited'
    );
  }

  // -------------------------------------------------------------------------
  // Internal: header extraction
  // -------------------------------------------------------------------------

  /**
   * Extract the `Retry-After` duration (in seconds) from a rate-limited error.
   *
   * Looks for the value in `error.data.headers['retry-after']`. Falls back
   * to {@link DEFAULT_RETRY_AFTER_SECONDS} if the header is missing or
   * cannot be parsed.
   *
   * @param error - The caught rate-limit error.
   * @returns Number of seconds to wait before retrying.
   */
  extractRetryAfter(error: unknown): number {
    const data = (error as Record<string, unknown>).data as
      | Record<string, unknown>
      | undefined;
    const headers = data?.headers as Record<string, string> | undefined;
    const retryAfter = headers?.['retry-after'];

    if (retryAfter) {
      const parsed = parseInt(retryAfter, 10);
      if (!isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }

    return DEFAULT_RETRY_AFTER_SECONDS;
  }

  // -------------------------------------------------------------------------
  // Internal: sleep utility
  // -------------------------------------------------------------------------

  /**
   * Sleep for the specified number of milliseconds.
   *
   * Extracted as a method for testability (can be overridden in tests to
   * avoid real delays).
   *
   * @param ms - Milliseconds to wait.
   */
  protected async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
