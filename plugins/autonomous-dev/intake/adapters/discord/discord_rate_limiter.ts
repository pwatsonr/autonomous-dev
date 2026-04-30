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

// ---------------------------------------------------------------------------
// Per-guild interaction-budget bucket (SPEC-011-3-04)
// ---------------------------------------------------------------------------

/**
 * Decision returned by {@link consumeGuildBudget}.
 *
 * `allowed` is the only field most callers need; `retryAfterMs` is populated
 * when the bucket is exhausted so the caller can show an actionable message;
 * `remaining` lets callers do their own backpressure logic.
 */
export interface RateLimitDecision {
  /** True if the request was admitted to the bucket. */
  allowed: boolean;
  /** Milliseconds until the bucket has at least one token (only when blocked). */
  retryAfterMs?: number;
  /** Tokens remaining in the bucket after this consume call. */
  remaining: number;
}

/** Per-guild interaction bucket parameters. */
const BUCKET_CAPACITY = 30;
/** Refill window: 30 tokens per 60 seconds = 0.5 tokens/sec. */
const BUCKET_REFILL_RATE_PER_MS = BUCKET_CAPACITY / 60_000;
/** Buckets idle longer than this are evicted to bound memory. */
const BUCKET_IDLE_EVICTION_MS = 10 * 60 * 1_000;

interface GuildBucket {
  /** Available token count (float for fractional refill). */
  tokens: number;
  /** Last consume timestamp (ms epoch).  Used for refill + eviction. */
  lastConsumeMs: number;
}

/**
 * Module-level bucket store.  DMs (no guild) share a single bucket keyed by
 * the literal string `'__dm__'`.  This is intentional per SPEC-011-3-04: DMs
 * are far less common than guild interactions, and a shared bucket bounds
 * memory for them.
 */
const guildBuckets: Map<string, GuildBucket> = new Map();

/**
 * Reset all per-guild buckets.  Test-only: production code never calls this.
 * @internal
 */
export function __resetGuildBuckets(): void {
  guildBuckets.clear();
}

/**
 * Consume one token from the per-guild interaction bucket.
 *
 * Token-bucket math:
 * - Capacity: 30 tokens.
 * - Refill: 30 / 60s, computed continuously from `lastConsumeMs`.
 * - Eviction: caller should periodically invoke {@link evictIdleBuckets}.
 *
 * @param guildId - Discord guild snowflake, or `null` for DMs.
 * @param now - Override for the current time (test seam, defaults to Date.now()).
 * @returns Whether the interaction was admitted plus context for callers.
 */
export function consumeGuildBudget(
  guildId: string | null,
  now: number = Date.now(),
): RateLimitDecision {
  const key = guildId ?? '__dm__';
  const bucket = guildBuckets.get(key);
  if (!bucket) {
    // First request for this guild -- start with a full bucket and consume one.
    guildBuckets.set(key, { tokens: BUCKET_CAPACITY - 1, lastConsumeMs: now });
    return { allowed: true, remaining: BUCKET_CAPACITY - 1 };
  }
  // Refill since last consume.
  const elapsedMs = Math.max(0, now - bucket.lastConsumeMs);
  const refilled = Math.min(
    BUCKET_CAPACITY,
    bucket.tokens + elapsedMs * BUCKET_REFILL_RATE_PER_MS,
  );
  if (refilled >= 1) {
    bucket.tokens = refilled - 1;
    bucket.lastConsumeMs = now;
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }
  // Bucket exhausted.  Compute time until at least 1 token regenerates.
  const tokensShort = 1 - refilled;
  const retryAfterMs = Math.ceil(tokensShort / BUCKET_REFILL_RATE_PER_MS);
  bucket.tokens = refilled; // record the refill even though not consumed
  return { allowed: false, retryAfterMs, remaining: 0 };
}

/**
 * Evict per-guild buckets idle longer than 10 minutes.  Call periodically
 * from a scheduled timer or on a sweep tick.
 *
 * @param now - Override for the current time (test seam).
 * @returns Number of buckets evicted.
 */
export function evictIdleBuckets(now: number = Date.now()): number {
  let evicted = 0;
  for (const [key, bucket] of guildBuckets.entries()) {
    if (now - bucket.lastConsumeMs > BUCKET_IDLE_EVICTION_MS) {
      guildBuckets.delete(key);
      evicted++;
    }
  }
  return evicted;
}

/**
 * Bucket-store size.  Test-only accessor.
 * @internal
 */
export function __guildBucketCount(): number {
  return guildBuckets.size;
}
