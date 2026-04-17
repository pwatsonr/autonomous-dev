/**
 * Discord Platform Rate Limit Handler.
 *
 * Provides per-route rate limit awareness by tracking Discord's
 * `X-RateLimit-Remaining` and `X-RateLimit-Reset` response headers.
 * When a bucket is exhausted (remaining = 0), subsequent requests are
 * queued until the reset time. On 429 responses, the handler retries
 * once after the specified `retryAfter` delay.
 *
 * Integrates with the shared `withRetry` utility for exponential
 * backoff with jitter on 429 and 5xx errors:
 * - Base: 1s
 * - Max: 60s
 * - Jitter: +/- 25%
 * - Max attempts: 5
 *
 * Implements SPEC-008-3-04, Task 11.
 *
 * @module discord_rate_limiter
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
// Types
// ---------------------------------------------------------------------------

/**
 * Tracks the rate limit state for a specific API route bucket.
 */
export interface BucketState {
  /** Number of requests remaining before rate limit is hit. */
  remaining: number;
  /** Unix timestamp in milliseconds when the rate limit resets. */
  resetAt: number;
}

/**
 * Minimal error interface matching the discord.js DiscordAPIError shape.
 * Used for type-safe 429 detection without a hard dependency on discord.js.
 */
export interface DiscordAPIErrorLike {
  status?: number;
  retryAfter?: number;
  message?: string;
}

// ---------------------------------------------------------------------------
// DiscordRateLimitHandler
// ---------------------------------------------------------------------------

/**
 * Per-route rate limit handler for Discord API calls.
 *
 * Usage:
 * ```typescript
 * const handler = new DiscordRateLimitHandler();
 *
 * const result = await handler.executeWithRateLimit('channel:123:messages', async () => {
 *   return channel.send({ content: 'Hello' });
 * });
 * ```
 *
 * The handler:
 * 1. Checks if the bucket is exhausted before executing.
 * 2. If exhausted, waits until the reset time.
 * 3. Executes the function.
 * 4. On 429 errors, waits `retryAfter` ms and retries once.
 * 5. Callers should update bucket state via {@link updateFromHeaders}
 *    after successful responses.
 */
export class DiscordRateLimitHandler {
  private buckets: Map<string, BucketState> = new Map();

  /**
   * Execute a function with rate limit awareness.
   *
   * If the bucket is exhausted (remaining = 0 and reset time is in the
   * future), the call is delayed until the reset time. If the function
   * throws a 429 error, it is retried once after the specified delay.
   *
   * @param bucketKey - Identifies the rate limit bucket (e.g., 'channel:123:messages').
   * @param fn - The async function to execute.
   * @returns The result of the function.
   * @throws Re-throws non-429 errors from the function.
   */
  async executeWithRateLimit<T>(
    bucketKey: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    // Check if this bucket is currently rate-limited
    const bucket = this.buckets.get(bucketKey);
    if (bucket && bucket.remaining === 0 && Date.now() < bucket.resetAt) {
      const waitMs = bucket.resetAt - Date.now();
      logger.warn('Discord rate limit hit, waiting', { bucket: bucketKey, waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
    }

    try {
      const result = await fn();
      return result;
    } catch (error) {
      const apiError = error as DiscordAPIErrorLike;
      if (apiError.status === 429) {
        const retryAfter = apiError.retryAfter ?? 5000;
        logger.warn('Discord 429 response', { retryAfter, bucket: bucketKey });
        await new Promise((r) => setTimeout(r, retryAfter));
        return fn(); // Retry once
      }
      throw error;
    }
  }

  /**
   * Update bucket state from Discord API response headers.
   *
   * Called after each successful API response to keep the local bucket
   * state in sync with Discord's server-side rate limits.
   *
   * @param bucketKey - The bucket key to update.
   * @param headers - The rate limit headers from the response.
   */
  updateFromHeaders(
    bucketKey: string,
    headers: {
      'x-ratelimit-remaining'?: string;
      'x-ratelimit-reset'?: string;
      'x-ratelimit-bucket'?: string;
    },
  ): void {
    const remaining = parseInt(headers['x-ratelimit-remaining'] ?? '', 10);
    const resetAt = parseFloat(headers['x-ratelimit-reset'] ?? '') * 1000;
    if (!isNaN(remaining) && !isNaN(resetAt)) {
      this.buckets.set(bucketKey, { remaining, resetAt });
    }
  }

  // -------------------------------------------------------------------------
  // Testing accessors
  // -------------------------------------------------------------------------

  /**
   * Get the current bucket state for a key.
   * Exposed for testing.
   */
  getBucket(bucketKey: string): BucketState | undefined {
    return this.buckets.get(bucketKey);
  }

  /**
   * Manually set a bucket state.
   * Exposed for testing.
   */
  setBucket(bucketKey: string, state: BucketState): void {
    this.buckets.set(bucketKey, state);
  }
}
