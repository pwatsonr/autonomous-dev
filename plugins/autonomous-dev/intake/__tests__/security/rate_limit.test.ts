/**
 * Security tests for rate limit enforcement.
 *
 * Uses a real in-memory SQLite database and real RateLimiter.
 * Tests exact boundary enforcement for both submission and query limits,
 * and verifies retryAfterMs accuracy.
 *
 * Implements SPEC-008-1-09, Task 18 -- rate_limit.
 *
 * Total: 3 tests.
 *
 * @module rate_limit.test
 */

import * as path from 'path';

import { Repository } from '../../db/repository';
import { initializeDatabase } from '../../db/migrator';
import { RateLimiter, DEFAULT_RATE_LIMITS } from '../../rate_limit/rate_limiter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  repo: Repository;
  rateLimiter: RateLimiter;
}

function setupTestContext(): TestContext {
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const { db } = initializeDatabase(':memory:', migrationsDir);
  const repo = new Repository(db);
  const rateLimiter = new RateLimiter(repo);

  return { repo, rateLimiter };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Rate Limit Enforcement Security (SPEC-008-1-09)', () => {
  // -----------------------------------------------------------------------
  // Test 1: Submission rate limit (default 10/hour)
  // -----------------------------------------------------------------------
  test('submission: first 10 succeed, 11th returns RATE_LIMITED with retryAfterMs > 0', () => {
    const ctx = setupTestContext();
    const userId = 'test-user';

    // First 10 submissions should succeed
    for (let i = 0; i < 10; i++) {
      const result = ctx.rateLimiter.checkLimit(userId, 'submission');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(DEFAULT_RATE_LIMITS.submissions_per_hour - i - 1);
    }

    // 11th should be denied
    const denied = ctx.rateLimiter.checkLimit(userId, 'submission');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.message).toBeDefined();
    expect(denied.message).toContain('Rate limit exceeded');
  });

  // -----------------------------------------------------------------------
  // Test 2: Query rate limit (default 60/minute)
  // -----------------------------------------------------------------------
  test('query: first 60 succeed, 61st returns RATE_LIMITED', () => {
    const ctx = setupTestContext();
    const userId = 'test-user';

    // First 60 queries should succeed
    for (let i = 0; i < 60; i++) {
      const result = ctx.rateLimiter.checkLimit(userId, 'query');
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(DEFAULT_RATE_LIMITS.queries_per_minute - i - 1);
    }

    // 61st should be denied
    const denied = ctx.rateLimiter.checkLimit(userId, 'query');
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
    expect(denied.message).toContain('Rate limit exceeded');
  });

  // -----------------------------------------------------------------------
  // Test 3: retryAfterMs accuracy (within 1 second of expected)
  // -----------------------------------------------------------------------
  test('retryAfterMs is within 1 second of expected value', () => {
    const ctx = setupTestContext();
    const userId = 'test-user';

    // Record the start time
    const startTime = Date.now();

    // Exhaust the submission limit
    for (let i = 0; i < 10; i++) {
      ctx.rateLimiter.checkLimit(userId, 'submission');
    }

    const denied = ctx.rateLimiter.checkLimit(userId, 'submission');
    expect(denied.allowed).toBe(false);

    // The retryAfterMs should be approximately 1 hour (3,600,000 ms) minus
    // the time elapsed since the first action. The oldest action was recorded
    // near startTime, so retryAfterMs should be close to 3,600,000 ms.
    const elapsed = Date.now() - startTime;
    const expectedRetry = 3_600_000 - elapsed;

    // Allow 1 second tolerance
    expect(Math.abs(denied.retryAfterMs - expectedRetry)).toBeLessThanOrEqual(1_000);
  });
});
