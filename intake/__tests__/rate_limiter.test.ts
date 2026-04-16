/**
 * Unit tests for the sliding-window rate limiter (SPEC-008-1-08).
 *
 * Covers:
 *  - Under-limit (returns allowed with correct remaining)
 *  - At-limit (returns denied with retryAfterMs)
 *  - Sliding window expiry (old actions no longer counted)
 *  - Role-based override resolution
 *  - Both action types (submission: 1h window, query: 1m window)
 *  - 100% branch coverage on `checkLimit` and `resolveLimit`
 *
 * @module rate_limiter.test
 */

import {
  RateLimiter,
  DEFAULT_RATE_LIMITS,
  type RateLimitConfig,
  type RateLimitOverrides,
  type RateLimitRepository,
  type RateLimitResult,
  type ActionType,
} from '../../rate_limit/rate_limiter';

// ---------------------------------------------------------------------------
// Mock repository factory
// ---------------------------------------------------------------------------

interface MockRepo extends RateLimitRepository {
  _countActions: jest.Mock;
  _recordAction: jest.Mock;
  _getOldestActionInWindow: jest.Mock;
}

function createMockRepo(overrides: Partial<{
  countActions: number;
  getOldestActionInWindow: Date | null;
}> = {}): MockRepo {
  const _countActions = jest.fn().mockReturnValue(overrides.countActions ?? 0);
  const _recordAction = jest.fn();
  const _getOldestActionInWindow = jest.fn().mockReturnValue(
    overrides.getOldestActionInWindow ?? null,
  );

  return {
    countActions: _countActions,
    recordAction: _recordAction,
    getOldestActionInWindow: _getOldestActionInWindow,
    _countActions,
    _recordAction,
    _getOldestActionInWindow,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RateLimiter', () => {
  // =========================================================================
  // Under-limit: allowed
  // =========================================================================

  describe('under-limit', () => {
    it('allows action when count is 0 (no prior actions)', () => {
      const repo = createMockRepo({ countActions: 0 });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'submission');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(DEFAULT_RATE_LIMITS.submissions_per_hour - 1);
      expect(result.limit).toBe(DEFAULT_RATE_LIMITS.submissions_per_hour);
      expect(result.retryAfterMs).toBe(0);
      expect(result.message).toBeUndefined();
    });

    it('allows action when count is below limit', () => {
      const repo = createMockRepo({ countActions: 5 });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'submission');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(DEFAULT_RATE_LIMITS.submissions_per_hour - 5 - 1);
      expect(result.retryAfterMs).toBe(0);
    });

    it('records the action when allowed', () => {
      const repo = createMockRepo({ countActions: 0 });
      const limiter = new RateLimiter(repo);

      limiter.checkLimit('user1', 'submission');

      expect(repo._recordAction).toHaveBeenCalledTimes(1);
      expect(repo._recordAction).toHaveBeenCalledWith(
        'user1',
        'submission',
        expect.any(Date),
      );
    });

    it('returns correct remaining for query action type', () => {
      const repo = createMockRepo({ countActions: 10 });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'query');

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(DEFAULT_RATE_LIMITS.queries_per_minute - 10 - 1);
      expect(result.limit).toBe(DEFAULT_RATE_LIMITS.queries_per_minute);
    });
  });

  // =========================================================================
  // At-limit: denied
  // =========================================================================

  describe('at-limit (denied)', () => {
    it('denies action when count equals limit', () => {
      const repo = createMockRepo({
        countActions: DEFAULT_RATE_LIMITS.submissions_per_hour,
        getOldestActionInWindow: new Date(Date.now() - 3_500_000), // ~58 minutes ago
      });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'submission');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.message).toContain('Rate limit exceeded');
      expect(result.message).toContain(`${DEFAULT_RATE_LIMITS.submissions_per_hour}`);
    });

    it('denies action when count exceeds limit', () => {
      const repo = createMockRepo({
        countActions: DEFAULT_RATE_LIMITS.submissions_per_hour + 5,
        getOldestActionInWindow: new Date(Date.now() - 3_000_000),
      });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'submission');

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
    });

    it('does not record the action when denied', () => {
      const repo = createMockRepo({
        countActions: DEFAULT_RATE_LIMITS.submissions_per_hour,
        getOldestActionInWindow: new Date(),
      });
      const limiter = new RateLimiter(repo);

      limiter.checkLimit('user1', 'submission');

      expect(repo._recordAction).not.toHaveBeenCalled();
    });

    it('retryAfterMs is computed from oldest action in window', () => {
      const now = Date.now();
      const windowMs = 3_600_000; // 1 hour for submission
      const oldestTs = now - 3_000_000; // 50 minutes ago
      const expectedRetry = oldestTs + windowMs - now; // ~10 minutes

      const repo = createMockRepo({
        countActions: DEFAULT_RATE_LIMITS.submissions_per_hour,
        getOldestActionInWindow: new Date(oldestTs),
      });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'submission');

      // Allow 100ms tolerance for test execution time
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(Math.abs(result.retryAfterMs - expectedRetry)).toBeLessThan(100);
    });

    it('retryAfterMs falls back to full window when no oldest action', () => {
      const repo = createMockRepo({
        countActions: DEFAULT_RATE_LIMITS.submissions_per_hour,
        getOldestActionInWindow: null,
      });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'submission');

      expect(result.allowed).toBe(false);
      // Falls back to full window duration (3,600,000ms for submission)
      expect(result.retryAfterMs).toBe(3_600_000);
    });

    it('retryAfterMs is clamped to 0 when negative', () => {
      // oldest action is older than the window, so retryAfterMs would be negative
      const repo = createMockRepo({
        countActions: DEFAULT_RATE_LIMITS.submissions_per_hour,
        getOldestActionInWindow: new Date(Date.now() - 4_000_000), // beyond 1h window
      });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'submission');

      expect(result.retryAfterMs).toBe(0);
    });
  });

  // =========================================================================
  // Sliding window expiry
  // =========================================================================

  describe('sliding window expiry', () => {
    it('passes the correct windowStart to countActions for submission (1 hour)', () => {
      const repo = createMockRepo({ countActions: 0 });
      const limiter = new RateLimiter(repo);
      const before = Date.now();

      limiter.checkLimit('user1', 'submission');

      const windowStart = repo._countActions.mock.calls[0][2] as Date;
      const expectedWindowStart = before - 3_600_000;
      // windowStart should be approximately 1 hour before now
      expect(Math.abs(windowStart.getTime() - expectedWindowStart)).toBeLessThan(100);
    });

    it('passes the correct windowStart to countActions for query (1 minute)', () => {
      const repo = createMockRepo({ countActions: 0 });
      const limiter = new RateLimiter(repo);
      const before = Date.now();

      limiter.checkLimit('user1', 'query');

      const windowStart = repo._countActions.mock.calls[0][2] as Date;
      const expectedWindowStart = before - 60_000;
      expect(Math.abs(windowStart.getTime() - expectedWindowStart)).toBeLessThan(100);
    });
  });

  // =========================================================================
  // Role-based override resolution
  // =========================================================================

  describe('role-based override resolution', () => {
    it('uses role override for submissions_per_hour when provided', () => {
      const repo = createMockRepo({ countActions: 15 });
      const limiter = new RateLimiter(repo);
      const overrides: RateLimitOverrides = { submissions_per_hour: 20 };

      const result = limiter.checkLimit(
        'user1',
        'submission',
        DEFAULT_RATE_LIMITS,
        overrides,
      );

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(20);
      expect(result.remaining).toBe(20 - 15 - 1);
    });

    it('uses role override for queries_per_minute when provided', () => {
      const repo = createMockRepo({ countActions: 80 });
      const limiter = new RateLimiter(repo);
      const overrides: RateLimitOverrides = { queries_per_minute: 100 };

      const result = limiter.checkLimit(
        'user1',
        'query',
        DEFAULT_RATE_LIMITS,
        overrides,
      );

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(100);
    });

    it('falls back to default config when role override is not provided for submission', () => {
      const repo = createMockRepo({ countActions: 0 });
      const limiter = new RateLimiter(repo);
      const overrides: RateLimitOverrides = { queries_per_minute: 200 };

      const result = limiter.checkLimit(
        'user1',
        'submission',
        DEFAULT_RATE_LIMITS,
        overrides,
      );

      // submissions_per_hour not in override, so falls back to default
      expect(result.limit).toBe(DEFAULT_RATE_LIMITS.submissions_per_hour);
    });

    it('falls back to default config when role override is not provided for query', () => {
      const repo = createMockRepo({ countActions: 0 });
      const limiter = new RateLimiter(repo);
      const overrides: RateLimitOverrides = { submissions_per_hour: 50 };

      const result = limiter.checkLimit(
        'user1',
        'query',
        DEFAULT_RATE_LIMITS,
        overrides,
      );

      expect(result.limit).toBe(DEFAULT_RATE_LIMITS.queries_per_minute);
    });

    it('falls back to default when no overrides object is provided', () => {
      const repo = createMockRepo({ countActions: 0 });
      const limiter = new RateLimiter(repo);

      const result = limiter.checkLimit('user1', 'submission');

      expect(result.limit).toBe(DEFAULT_RATE_LIMITS.submissions_per_hour);
    });

    it('role override can lower the limit to deny sooner', () => {
      const repo = createMockRepo({
        countActions: 3,
        getOldestActionInWindow: new Date(Date.now() - 1_000_000),
      });
      const limiter = new RateLimiter(repo);
      const overrides: RateLimitOverrides = { submissions_per_hour: 3 };

      const result = limiter.checkLimit(
        'user1',
        'submission',
        DEFAULT_RATE_LIMITS,
        overrides,
      );

      expect(result.allowed).toBe(false);
      expect(result.limit).toBe(3);
    });
  });

  // =========================================================================
  // Custom config
  // =========================================================================

  describe('custom config', () => {
    it('uses custom config values instead of defaults', () => {
      const repo = createMockRepo({ countActions: 0 });
      const limiter = new RateLimiter(repo);
      const customConfig: RateLimitConfig = {
        submissions_per_hour: 5,
        queries_per_minute: 30,
      };

      const subResult = limiter.checkLimit('user1', 'submission', customConfig);
      expect(subResult.limit).toBe(5);

      const queryResult = limiter.checkLimit('user1', 'query', customConfig);
      expect(queryResult.limit).toBe(30);
    });
  });
});
