/**
 * Integration tests for starvation prevention promotion.
 *
 * Uses a real in-memory SQLite database with full migrations applied.
 * Tests the StarvationMonitor's promote() method with controlled timestamps
 * to validate relative-timing-based promotion logic.
 *
 * Implements SPEC-008-1-09, Task 17 -- starvation.
 *
 * Total: 5 tests.
 *
 * @module starvation.test
 */

import * as path from 'path';

import { Repository } from '../../db/repository';
import { initializeDatabase } from '../../db/migrator';
import {
  StarvationMonitor,
  type StarvationRepository,
  DEFAULT_STARVATION_CONFIG,
} from '../../queue/starvation_monitor';
import type { Priority, RequestStatus } from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestContext {
  db: ReturnType<typeof initializeDatabase>['db'];
  repo: Repository;
  starvationRepo: StarvationRepository;
  monitor: StarvationMonitor;
}

/**
 * Build a StarvationRepository adapter from the raw DB instance.
 *
 * The SQL matches the contract documented in starvation_monitor.ts:
 * promote queued requests of `fromPriority` whose
 * COALESCE(last_promoted_at, created_at) < threshold.
 */
function buildStarvationRepo(db: ReturnType<typeof initializeDatabase>['db']): StarvationRepository {
  return {
    promoteStarvedRequests(
      fromPriority: Priority,
      toPriority: Priority,
      threshold: Date,
      now: Date,
    ): string[] {
      const nowIso = now.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
      const thresholdIso = threshold.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');

      const rows = db
        .prepare(
          `UPDATE requests
           SET priority = ?,
               updated_at = ?,
               promotion_count = promotion_count + 1,
               last_promoted_at = ?
           WHERE status = 'queued'
             AND priority = ?
             AND COALESCE(last_promoted_at, created_at) < ?
           RETURNING request_id`,
        )
        .all(toPriority, nowIso, nowIso, fromPriority, thresholdIso) as Array<{
        request_id: string;
      }>;

      return rows.map((r) => r.request_id);
    },
  };
}

function setupTestContext(): TestContext {
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const { db } = initializeDatabase(':memory:', migrationsDir);
  const repo = new Repository(db);
  const starvationRepo = buildStarvationRepo(db);
  const monitor = new StarvationMonitor(starvationRepo);

  return { db, repo, starvationRepo, monitor };
}

/** Insert a request with a specific created_at and optional last_promoted_at. */
function insertRequest(
  ctx: TestContext,
  opts: {
    requestId?: string;
    priority: Priority;
    createdAt: Date;
    lastPromotedAt?: Date;
    status?: RequestStatus;
    promotionCount?: number;
  },
): string {
  const reqId = opts.requestId ?? ctx.repo.generateRequestId();
  const createdAtIso = opts.createdAt.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');
  const lastPromotedIso = opts.lastPromotedAt
    ? opts.lastPromotedAt.toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z')
    : null;

  ctx.repo.insertRequest({
    request_id: reqId,
    title: `Test request ${reqId}`,
    description: `Test description for ${reqId}`,
    raw_input: `Test raw input for ${reqId}`,
    priority: opts.priority,
    target_repo: null,
    status: opts.status ?? 'queued',
    current_phase: 'intake',
    phase_progress: null,
    requester_id: 'test-user',
    source_channel: 'claude_app',
    notification_config: '{}',
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: opts.promotionCount ?? 0,
    last_promoted_at: lastPromotedIso,
    paused_at_phase: null,
    created_at: createdAtIso,
    updated_at: createdAtIso,
  });

  return reqId;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Starvation Promotion Integration (SPEC-008-1-09)', () => {
  // -----------------------------------------------------------------------
  // Test 1: Low priority request created 49h ago -> promoted to normal
  // -----------------------------------------------------------------------
  test('low priority request older than threshold is promoted to normal with promotion_count=1', async () => {
    const ctx = setupTestContext();

    const now = new Date();
    const createdAt = new Date(now.getTime() - 49 * 3_600_000); // 49h ago

    const reqId = insertRequest(ctx, { priority: 'low', createdAt });

    const results = await ctx.monitor.promote({
      ...DEFAULT_STARVATION_CONFIG,
      threshold_hours: 48,
    });

    expect(results.length).toBeGreaterThanOrEqual(1);
    const promotion = results.find((r) => r.requestId === reqId);
    expect(promotion).toBeDefined();
    expect(promotion!.fromPriority).toBe('low');
    expect(promotion!.toPriority).toBe('normal');

    // Verify DB state
    const dbRow = ctx.repo.getRequest(reqId);
    expect(dbRow).not.toBeNull();
    expect(dbRow!.priority).toBe('normal');
    expect(dbRow!.promotion_count).toBe(1);
    expect(dbRow!.last_promoted_at).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 2: After promotion, immediate re-run does NOT promote again
  // -----------------------------------------------------------------------
  test('recently promoted request is not promoted again immediately', async () => {
    const ctx = setupTestContext();

    const now = new Date();
    const createdAt = new Date(now.getTime() - 49 * 3_600_000);

    const reqId = insertRequest(ctx, { priority: 'low', createdAt });

    // First promotion
    await ctx.monitor.promote({
      ...DEFAULT_STARVATION_CONFIG,
      threshold_hours: 48,
    });

    const dbRowAfterFirst = ctx.repo.getRequest(reqId);
    expect(dbRowAfterFirst!.priority).toBe('normal');
    expect(dbRowAfterFirst!.promotion_count).toBe(1);

    // Immediate second promotion attempt
    const results2 = await ctx.monitor.promote({
      ...DEFAULT_STARVATION_CONFIG,
      threshold_hours: 48,
    });

    // Should NOT have promoted this request (last_promoted_at is too recent)
    const secondPromotion = results2.find((r) => r.requestId === reqId);
    expect(secondPromotion).toBeUndefined();

    const dbRowAfterSecond = ctx.repo.getRequest(reqId);
    expect(dbRowAfterSecond!.priority).toBe('normal');
    expect(dbRowAfterSecond!.promotion_count).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 3: After 49h more, normal -> high (promotion_count=2)
  // -----------------------------------------------------------------------
  test('request promoted to normal can be promoted to high after another threshold period', async () => {
    const ctx = setupTestContext();

    const now = new Date();
    // Created 98h ago, promoted 49h ago to normal
    const createdAt = new Date(now.getTime() - 98 * 3_600_000);
    const lastPromotedAt = new Date(now.getTime() - 49 * 3_600_000);

    const reqId = insertRequest(ctx, {
      priority: 'normal',
      createdAt,
      lastPromotedAt,
      promotionCount: 1,
    });

    const results = await ctx.monitor.promote({
      ...DEFAULT_STARVATION_CONFIG,
      threshold_hours: 48,
    });

    const promotion = results.find((r) => r.requestId === reqId);
    expect(promotion).toBeDefined();
    expect(promotion!.fromPriority).toBe('normal');
    expect(promotion!.toPriority).toBe('high');

    const dbRow = ctx.repo.getRequest(reqId);
    expect(dbRow!.priority).toBe('high');
    expect(dbRow!.promotion_count).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Test 4: Low priority request created only 10h ago -> NOT promoted
  // -----------------------------------------------------------------------
  test('low priority request younger than threshold is NOT promoted', async () => {
    const ctx = setupTestContext();

    const now = new Date();
    const createdAt = new Date(now.getTime() - 10 * 3_600_000); // 10h ago

    const reqId = insertRequest(ctx, { priority: 'low', createdAt });

    const results = await ctx.monitor.promote({
      ...DEFAULT_STARVATION_CONFIG,
      threshold_hours: 48,
    });

    const promotion = results.find((r) => r.requestId === reqId);
    expect(promotion).toBeUndefined();

    const dbRow = ctx.repo.getRequest(reqId);
    expect(dbRow!.priority).toBe('low');
    expect(dbRow!.promotion_count).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 5: High priority request created 100h ago -> NOT promoted (ceiling)
  // -----------------------------------------------------------------------
  test('high priority request is never promoted further (already at ceiling)', async () => {
    const ctx = setupTestContext();

    const now = new Date();
    const createdAt = new Date(now.getTime() - 100 * 3_600_000); // 100h ago

    const reqId = insertRequest(ctx, { priority: 'high', createdAt });

    const results = await ctx.monitor.promote({
      ...DEFAULT_STARVATION_CONFIG,
      threshold_hours: 48,
    });

    // No promotion for high-priority requests
    const promotion = results.find((r) => r.requestId === reqId);
    expect(promotion).toBeUndefined();

    const dbRow = ctx.repo.getRequest(reqId);
    expect(dbRow!.priority).toBe('high');
    expect(dbRow!.promotion_count).toBe(0);
  });
});
