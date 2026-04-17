/**
 * Unit tests for query budget enforcement (SPEC-007-1-2, Task 5).
 *
 * Test case IDs correspond to the spec's acceptance criteria:
 *   TC-1-2-08 through TC-1-2-13.
 */

import { QueryBudgetEnforcer, BudgetLogger } from '../../src/adapters/query-budget';
import { QueryBudgetConfig, DEFAULT_BUDGETS } from '../../src/adapters/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a promise that resolves after `ms` milliseconds. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Collects warning messages for assertions. */
function createMockLogger(): BudgetLogger & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    warn(message: string) {
      messages.push(message);
    },
  };
}

// ---------------------------------------------------------------------------
// TC-1-2-08: Budget allows queries under limit
// ---------------------------------------------------------------------------

describe('QueryBudgetEnforcer', () => {
  test('TC-1-2-08: canQuery returns true when under the limit', () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);

    // Execute 5 queries for prometheus / service-A.
    for (let i = 0; i < 5; i++) {
      tracker.recordQuery('prometheus', 'service-A');
    }

    // 5 < 20, so canQuery should return true.
    expect(tracker.canQuery('prometheus', 'service-A')).toBe(true);
    expect(tracker.getCount('prometheus', 'service-A')).toBe(5);
  });

  // -------------------------------------------------------------------------
  // TC-1-2-09: Budget blocks at limit
  // -------------------------------------------------------------------------

  test('TC-1-2-09: canQuery returns false at the limit, warning logged', () => {
    const logger = createMockLogger();
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS, logger);

    // Execute exactly 20 queries (the Prometheus limit).
    for (let i = 0; i < 20; i++) {
      tracker.recordQuery('prometheus', 'service-A');
    }

    expect(tracker.canQuery('prometheus', 'service-A')).toBe(false);

    // Attempt one more via executeQuery -- should be blocked.
    const result = tracker.executeQuery('prometheus', 'service-A', async () => 'data');

    return result.then((val) => {
      expect(val).toBeNull();
      expect(logger.messages).toHaveLength(1);
      expect(logger.messages[0]).toContain('Query budget exhausted');
      expect(logger.messages[0]).toContain('prometheus/service-A');
      expect(logger.messages[0]).toContain('20/20');
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-2-10: Budget is per-service
  // -------------------------------------------------------------------------

  test('TC-1-2-10: budget is tracked per-service independently', () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);

    // Exhaust budget for service A.
    for (let i = 0; i < 20; i++) {
      tracker.recordQuery('prometheus', 'service-A');
    }

    expect(tracker.canQuery('prometheus', 'service-A')).toBe(false);
    // Service B should still be fully available.
    expect(tracker.canQuery('prometheus', 'service-B')).toBe(true);
    expect(tracker.getCount('prometheus', 'service-B')).toBe(0);
  });

  // -------------------------------------------------------------------------
  // TC-1-2-11: Timeout enforcement
  // -------------------------------------------------------------------------

  test('TC-1-2-11: query rejected after per-source timeout', async () => {
    // Use a custom budget with a very short timeout.
    const budgets: Record<string, QueryBudgetConfig> = {
      prometheus: { max_queries_per_service: 20, timeout_seconds: 0.05 }, // 50ms
    };
    const tracker = new QueryBudgetEnforcer(budgets);

    const queryCall = () => delay(200).then(() => 'late data');

    await expect(
      tracker.executeQuery('prometheus', 'service-A', queryCall),
    ).rejects.toThrow('timed out');
  });

  // -------------------------------------------------------------------------
  // TC-1-2-12: Budget state in metadata
  // -------------------------------------------------------------------------

  test('TC-1-2-12: getState returns correct counts for each source/service', async () => {
    const logger = createMockLogger();
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS, logger);

    // 15 Prometheus queries for service-X.
    for (let i = 0; i < 15; i++) {
      tracker.recordQuery('prometheus', 'service-X');
    }

    // 8 Grafana queries for service-X.
    for (let i = 0; i < 8; i++) {
      tracker.recordQuery('grafana', 'service-X');
    }

    // Attempt 2 more Grafana queries beyond the budget (limit is 10).
    // First, fill to the limit.
    tracker.recordQuery('grafana', 'service-X'); // 9
    tracker.recordQuery('grafana', 'service-X'); // 10

    // Now block 2.
    await tracker.executeQuery('grafana', 'service-X', async () => 'blocked-1');
    await tracker.executeQuery('grafana', 'service-X', async () => 'blocked-2');

    const state = tracker.getState();

    const promState = state.find(
      (s) => s.source === 'prometheus' && s.service === 'service-X',
    )!;
    expect(promState).toBeDefined();
    expect(promState.queries_executed).toBe(15);
    expect(promState.queries_blocked).toBe(0);
    expect(promState.budget_exhausted).toBe(false);

    const grafState = state.find(
      (s) => s.source === 'grafana' && s.service === 'service-X',
    )!;
    expect(grafState).toBeDefined();
    expect(grafState.queries_executed).toBe(10);
    expect(grafState.queries_blocked).toBe(2);
    expect(grafState.budget_exhausted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // TC-1-2-13: OpenSearch longer timeout
  // -------------------------------------------------------------------------

  test('TC-1-2-13: OpenSearch query succeeds under 60s timeout', async () => {
    // OpenSearch has timeout_seconds: 60 by default.
    // Simulate a query that takes a while but finishes under the limit.
    const budgets: Record<string, QueryBudgetConfig> = {
      opensearch: { max_queries_per_service: 15, timeout_seconds: 0.2 }, // 200ms for test
    };
    const tracker = new QueryBudgetEnforcer(budgets);

    // Query that takes 50ms (well under the 200ms test timeout).
    const result = await tracker.executeQuery(
      'opensearch',
      'service-A',
      async () => {
        await delay(50);
        return 'opensearch-data';
      },
    );

    expect(result).toBe('opensearch-data');
    expect(tracker.getCount('opensearch', 'service-A')).toBe(1);
  });

  test('TC-1-2-13 (default): OpenSearch default timeout is 60s', () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);
    expect(tracker.getTimeoutMs('opensearch')).toBe(60_000);
  });

  // -------------------------------------------------------------------------
  // Additional edge-case tests
  // -------------------------------------------------------------------------

  test('canQuery returns false for unconfigured sources', () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);
    expect(tracker.canQuery('unknown_source', 'any-service')).toBe(false);
  });

  test('getTimeoutMs falls back to 30s for unconfigured sources', () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);
    expect(tracker.getTimeoutMs('unknown_source')).toBe(30_000);
  });

  test('default budgets match spec values', () => {
    expect(DEFAULT_BUDGETS.prometheus.max_queries_per_service).toBe(20);
    expect(DEFAULT_BUDGETS.prometheus.timeout_seconds).toBe(30);

    expect(DEFAULT_BUDGETS.grafana.max_queries_per_service).toBe(10);
    expect(DEFAULT_BUDGETS.grafana.timeout_seconds).toBe(30);

    expect(DEFAULT_BUDGETS.opensearch.max_queries_per_service).toBe(15);
    expect(DEFAULT_BUDGETS.opensearch.timeout_seconds).toBe(60);

    expect(DEFAULT_BUDGETS.sentry.max_queries_per_service).toBe(10);
    expect(DEFAULT_BUDGETS.sentry.timeout_seconds).toBe(30);
  });

  test('reset clears all counters', () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);

    tracker.recordQuery('prometheus', 'svc-1');
    tracker.recordQuery('prometheus', 'svc-1');
    tracker.recordBlocked('grafana', 'svc-2');

    expect(tracker.getCount('prometheus', 'svc-1')).toBe(2);
    expect(tracker.getBlockedCount('grafana', 'svc-2')).toBe(1);

    tracker.reset();

    expect(tracker.getCount('prometheus', 'svc-1')).toBe(0);
    expect(tracker.getBlockedCount('grafana', 'svc-2')).toBe(0);
    expect(tracker.getState()).toHaveLength(0);
  });

  test('remaining returns correct count', () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);

    expect(tracker.remaining('prometheus', 'svc-1')).toBe(20);

    for (let i = 0; i < 7; i++) {
      tracker.recordQuery('prometheus', 'svc-1');
    }

    expect(tracker.remaining('prometheus', 'svc-1')).toBe(13);

    // Unconfigured source returns 0 remaining.
    expect(tracker.remaining('unknown', 'svc-1')).toBe(0);
  });

  test('executeQuery returns result on success', async () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);
    const result = await tracker.executeQuery(
      'prometheus',
      'svc-1',
      async () => ({ metrics: [1, 2, 3] }),
    );

    expect(result).toEqual({ metrics: [1, 2, 3] });
    expect(tracker.getCount('prometheus', 'svc-1')).toBe(1);
  });

  test('executeQuery propagates query errors', async () => {
    const tracker = new QueryBudgetEnforcer(DEFAULT_BUDGETS);

    await expect(
      tracker.executeQuery('prometheus', 'svc-1', async () => {
        throw new Error('MCP connection failed');
      }),
    ).rejects.toThrow('MCP connection failed');

    // The query was still counted (it was dispatched before the error).
    expect(tracker.getCount('prometheus', 'svc-1')).toBe(1);
  });

  test('getState includes entries from both executed and blocked maps', async () => {
    const logger = createMockLogger();
    const budgets: Record<string, QueryBudgetConfig> = {
      prometheus: { max_queries_per_service: 1, timeout_seconds: 30 },
    };
    const tracker = new QueryBudgetEnforcer(budgets, logger);

    // Execute one query (hits the limit).
    await tracker.executeQuery('prometheus', 'svc-1', async () => 'ok');
    // Block the next one.
    await tracker.executeQuery('prometheus', 'svc-1', async () => 'blocked');

    const state = tracker.getState();
    expect(state).toHaveLength(1);
    expect(state[0]).toEqual({
      source: 'prometheus',
      service: 'svc-1',
      queries_executed: 1,
      queries_blocked: 1,
      budget_exhausted: true,
    });
  });
});
