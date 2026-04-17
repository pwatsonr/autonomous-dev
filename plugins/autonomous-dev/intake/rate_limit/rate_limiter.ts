/**
 * Sliding-window counter rate limiter backed by SQLite.
 *
 * Uses the `rate_limit_actions` table to track per-user action counts
 * within a sliding time window.  Supports role-based limit overrides
 * loaded from `intake-auth.yaml`.
 *
 * Window durations:
 *   - `submission`: 1 hour  (3,600,000 ms)
 *   - `query`:      1 minute (60,000 ms)
 *
 * Default limits (from `intake-config.yaml`):
 *   - `submissions_per_hour`: 10
 *   - `queries_per_minute`:   60
 *
 * @module rate_limiter
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The kind of action being rate-limited. */
export type ActionType = 'submission' | 'query';

/** Default rate limit configuration (from `intake-config.yaml`). */
export interface RateLimitConfig {
  submissions_per_hour: number;
  queries_per_minute: number;
}

/** Per-role overrides (from `intake-auth.yaml` `rate_limit_overrides`). */
export interface RateLimitOverrides {
  submissions_per_hour?: number;
  queries_per_minute?: number;
}

/** Result of a rate limit check. */
export interface RateLimitResult {
  /** Whether the action is allowed. */
  allowed: boolean;
  /** How many actions remain before hitting the limit. */
  remaining: number;
  /** The resolved limit for this action type. */
  limit: number;
  /**
   * Milliseconds until the oldest action slides out of the window.
   * Zero when the action is allowed.
   */
  retryAfterMs: number;
  /** Human-readable message (populated on denial). */
  message?: string;
}

// ---------------------------------------------------------------------------
// Repository interface (subset needed by rate limiter)
// ---------------------------------------------------------------------------

/**
 * Minimal database interface for rate limiting operations.
 * Matches the `rate_limit_actions` table in `schema.sql`.
 */
export interface RateLimitRepository {
  /**
   * Count the number of actions of `actionType` for `userId` since
   * `windowStart`.
   */
  countActions(
    userId: string,
    actionType: ActionType,
    windowStart: Date,
  ): number;

  /**
   * Return the timestamp of the oldest action of `actionType` for
   * `userId` since `windowStart`, or `null` if none exist.
   */
  getOldestActionInWindow(
    userId: string,
    actionType: ActionType,
    windowStart: Date,
  ): Date | null;

  /**
   * Record a new action.
   */
  recordAction(
    userId: string,
    actionType: ActionType,
    timestamp: Date,
  ): void;
}

// ---------------------------------------------------------------------------
// Window durations (ms)
// ---------------------------------------------------------------------------

const WINDOW_MS: Record<ActionType, number> = {
  submission: 3_600_000, // 1 hour
  query: 60_000,         // 1 minute
};

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  submissions_per_hour: 10,
  queries_per_minute: 60,
};

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

/**
 * Sliding-window counter rate limiter.
 *
 * Each call to {@link checkLimit} counts actions within the sliding window,
 * compares against the resolved limit, and either records the new action
 * (allowed) or returns a denial with an accurate `retryAfterMs`.
 */
export class RateLimiter {
  constructor(private readonly db: RateLimitRepository) {}

  /**
   * Check whether `userId` may perform `actionType` right now.
   *
   * @param userId         The internal user ID.
   * @param actionType     `'submission'` or `'query'`.
   * @param config         Default rate limit configuration.
   * @param roleOverrides  Optional per-role overrides that take precedence.
   * @returns A {@link RateLimitResult} indicating whether the action is allowed.
   */
  checkLimit(
    userId: string,
    actionType: ActionType,
    config: RateLimitConfig = DEFAULT_RATE_LIMITS,
    roleOverrides?: RateLimitOverrides,
  ): RateLimitResult {
    const limit = this.resolveLimit(actionType, config, roleOverrides);
    const windowMs = WINDOW_MS[actionType];
    const now = Date.now();
    const windowStart = new Date(now - windowMs);

    const count = this.db.countActions(userId, actionType, windowStart);

    if (count >= limit) {
      const oldest = this.db.getOldestActionInWindow(
        userId,
        actionType,
        windowStart,
      );
      const retryAfterMs = oldest
        ? oldest.getTime() + windowMs - now
        : windowMs;

      return {
        allowed: false,
        remaining: 0,
        limit,
        retryAfterMs: Math.max(0, retryAfterMs),
        message: `Rate limit exceeded: ${count}/${limit} ${actionType} actions in the current window. Retry after ${Math.ceil(Math.max(0, retryAfterMs) / 1000)}s.`,
      };
    }

    // Record the action and allow
    this.db.recordAction(userId, actionType, new Date(now));

    return {
      allowed: true,
      remaining: limit - count - 1,
      limit,
      retryAfterMs: 0,
    };
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Resolve the effective limit for the given action type.
   *
   * Role overrides take precedence over default config values.
   */
  private resolveLimit(
    actionType: ActionType,
    config: RateLimitConfig,
    roleOverrides?: RateLimitOverrides,
  ): number {
    if (actionType === 'submission') {
      return roleOverrides?.submissions_per_hour ?? config.submissions_per_hour;
    }
    return roleOverrides?.queries_per_minute ?? config.queries_per_minute;
  }
}
