/**
 * Unit tests for Grafana MCP data collection adapter (SPEC-007-1-3, Task 8).
 *
 * Test case IDs correspond to the spec's acceptance criteria:
 *   TC-1-3-09, TC-1-3-10, TC-1-3-11.
 */

import { GrafanaAdapter } from '../../src/adapters/grafana-adapter';
import type {
  McpToolCaller,
  ConnectivityReport,
} from '../../src/adapters/types';
import {
  DefaultQueryBudgetTracker,
  AdapterTimeoutError,
} from '../../src/adapters/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a mock MCP tool caller that records calls and returns a value. */
function buildMockMcp(response: unknown = buildMockAlertResponse()): {
  mcp: McpToolCaller;
  calls: Array<{ toolName: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ toolName: string; params: Record<string, unknown> }> = [];
  const mcp: McpToolCaller = {
    callTool: async (toolName, params) => {
      calls.push({ toolName, params });
      return response;
    },
  };
  return { mcp, calls };
}

/** Builds a mock Grafana alert list response. */
function buildMockAlertResponse(): unknown[] {
  return [
    {
      name: 'High Error Rate',
      state: 'alerting',
      dashboardUID: 'abc123',
      newStateDate: '2026-04-08T09:30:00.000Z',
      annotations: { summary: 'Error rate above threshold' },
    },
    {
      name: 'Latency Warning',
      state: 'pending',
      dashboardUID: 'abc123',
      newStateDate: '2026-04-08T09:45:00.000Z',
      annotations: { summary: 'P99 latency increasing' },
    },
    {
      name: 'CPU Healthy',
      state: 'ok',
      dashboardUID: 'abc123',
      newStateDate: '2026-04-08T08:00:00.000Z',
    },
  ];
}

/** Builds a mock Grafana annotations response. */
function buildMockAnnotationResponse(): unknown[] {
  return [
    {
      id: 1001,
      time: 1712566800000,
      text: 'Deploy v2.3.1 by user@example.com',
      tags: ['deploy', 'production'],
      dashboardUID: 'abc123',
    },
    {
      id: 1002,
      time: 1712570400000,
      text: 'Deploy v2.3.2 hotfix by admin@example.com',
      tags: ['deploy', 'production', 'hotfix'],
      dashboardUID: 'abc123',
    },
  ];
}

/** Builds a default query budget tracker. */
function buildBudget(
  overrides: Partial<Record<string, { max_queries_per_service: number; timeout_seconds: number }>> = {},
): DefaultQueryBudgetTracker {
  return new DefaultQueryBudgetTracker({
    prometheus: { max_queries_per_service: 20, timeout_seconds: 30 },
    grafana: { max_queries_per_service: 10, timeout_seconds: 30 },
    opensearch: { max_queries_per_service: 15, timeout_seconds: 60 },
    sentry: { max_queries_per_service: 10, timeout_seconds: 30 },
    ...overrides,
  });
}

/** Builds a ConnectivityReport with the given Grafana status. */
function buildConnectivity(
  grafanaStatus: 'available' | 'degraded' | 'unreachable' = 'available',
): ConnectivityReport {
  return {
    results: [
      { source: 'prometheus', status: 'available', response_time_ms: 50 },
      { source: 'grafana', status: grafanaStatus, response_time_ms: 30 },
      { source: 'opensearch', status: 'available', response_time_ms: 40 },
      { source: 'sentry', status: 'available', response_time_ms: 20 },
    ],
    all_unreachable: false,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TC-1-3-09: Grafana alert listing
// ---------------------------------------------------------------------------

describe('GrafanaAdapter', () => {
  describe('TC-1-3-09: alert listing', () => {
    test('calls grafana_list_alerts with correct dashboard_uid and states', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      await adapter.listAlerts('abc123', ['alerting', 'pending'], 'api-gateway');

      expect(calls).toHaveLength(1);
      expect(calls[0].toolName).toBe('grafana_list_alerts');
      expect(calls[0].params.dashboard_uid).toBe('abc123');
      expect(calls[0].params.state).toBe('alerting,pending');
    });

    test('returns structured alerts with name, state, and since', async () => {
      const { mcp } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.listAlerts('abc123', ['alerting', 'pending'], 'api-gateway');

      // Should filter to only alerting and pending (not ok)
      expect(result.alerts).toHaveLength(2);

      const alerting = result.alerts.find((a) => a.state === 'alerting');
      expect(alerting).toBeDefined();
      expect(alerting!.name).toBe('High Error Rate');
      expect(alerting!.dashboard_uid).toBe('abc123');
      expect(alerting!.since).toBe('2026-04-08T09:30:00.000Z');
      expect(alerting!.annotations).toEqual({ summary: 'Error rate above threshold' });

      const pending = result.alerts.find((a) => a.state === 'pending');
      expect(pending).toBeDefined();
      expect(pending!.name).toBe('Latency Warning');
    });

    test('filters alerts to only requested states', async () => {
      const { mcp } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.listAlerts('abc123', ['alerting'], 'api-gateway');

      expect(result.alerts).toHaveLength(1);
      expect(result.alerts[0].state).toBe('alerting');
    });

    test('returns empty array when no alerts match requested states', async () => {
      const { mcp } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.listAlerts('abc123', ['no_data'], 'api-gateway');

      expect(result.alerts).toHaveLength(0);
    });

    test('uses default states (alerting, pending) when not specified', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.listAlerts('abc123', undefined, 'api-gateway');

      expect(calls[0].params.state).toBe('alerting,pending');
      expect(result.alerts).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-10: Grafana annotations
  // -------------------------------------------------------------------------

  describe('TC-1-3-10: deploy annotations', () => {
    test('calls grafana_get_annotations with correct params', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAnnotationResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      await adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway');

      expect(calls).toHaveLength(1);
      expect(calls[0].toolName).toBe('grafana_get_annotations');
      expect(calls[0].params.dashboard_uid).toBe('abc123');
      expect(calls[0].params.tags).toEqual(['deploy']);

      // Verify time range: from should be ~4 hours before to
      const from = new Date(calls[0].params.from as string).getTime();
      const to = new Date(calls[0].params.to as string).getTime();
      const durationMs = to - from;
      expect(durationMs).toBeGreaterThanOrEqual(3.9 * 60 * 60 * 1000);
      expect(durationMs).toBeLessThanOrEqual(4.1 * 60 * 60 * 1000);
    });

    test('returns structured annotations with text preserved for scrubbing', async () => {
      const { mcp } = buildMockMcp(buildMockAnnotationResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway');

      expect(result.annotations).toHaveLength(2);

      const first = result.annotations[0];
      expect(first.id).toBe(1001);
      expect(first.text).toBe('Deploy v2.3.1 by user@example.com');
      expect(first.tags).toEqual(['deploy', 'production']);
      expect(first.dashboard_uid).toBe('abc123');
      // time should be converted from epoch ms to ISO string
      expect(first.time).toBe(new Date(1712566800000).toISOString());
    });

    test('uses default 4-hour window and deploy tag', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAnnotationResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      await adapter.getAnnotations('abc123', undefined, undefined, 'api-gateway');

      expect(calls[0].params.tags).toEqual(['deploy']);
      const from = new Date(calls[0].params.from as string).getTime();
      const to = new Date(calls[0].params.to as string).getTime();
      const durationHours = (to - from) / (60 * 60 * 1000);
      expect(Math.round(durationHours)).toBe(4);
    });

    test('handles empty annotation response', async () => {
      const { mcp } = buildMockMcp([]);
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway');

      expect(result.annotations).toEqual([]);
    });

    test('handles annotations with string time values', async () => {
      const response = [
        {
          id: 1001,
          time: '2026-04-08T10:00:00.000Z',
          text: 'Deploy v2.3.1',
          tags: ['deploy'],
          dashboardUID: 'abc123',
        },
      ];
      const { mcp } = buildMockMcp(response);
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway');

      expect(result.annotations[0].time).toBe('2026-04-08T10:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // Budget enforcement
  // -------------------------------------------------------------------------

  describe('budget enforcement', () => {
    test('records query after successful alert listing', async () => {
      const { mcp } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      await adapter.listAlerts('abc123', ['alerting'], 'api-gateway');

      expect(budget.remaining('grafana', 'api-gateway')).toBe(9);
    });

    test('records query after successful annotation retrieval', async () => {
      const { mcp } = buildMockMcp(buildMockAnnotationResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      await adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway');

      expect(budget.remaining('grafana', 'api-gateway')).toBe(9);
    });

    test('returns empty alerts when budget is exhausted', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      // Exhaust budget
      for (let i = 0; i < 10; i++) {
        budget.recordQuery('grafana', 'api-gateway');
      }

      const result = await adapter.listAlerts('abc123', ['alerting'], 'api-gateway');

      expect(result.alerts).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    test('returns empty annotations when budget is exhausted', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAnnotationResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      // Exhaust budget
      for (let i = 0; i < 10; i++) {
        budget.recordQuery('grafana', 'api-gateway');
      }

      const result = await adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway');

      expect(result.annotations).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Unreachable source
  // -------------------------------------------------------------------------

  describe('unreachable source', () => {
    test('returns empty alerts when source is unreachable', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const connectivity = buildConnectivity('unreachable');
      const adapter = new GrafanaAdapter(mcp, budget, connectivity);

      const result = await adapter.listAlerts('abc123', ['alerting'], 'api-gateway');

      expect(result.alerts).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    test('returns empty annotations when source is unreachable', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAnnotationResponse());
      const budget = buildBudget();
      const connectivity = buildConnectivity('unreachable');
      const adapter = new GrafanaAdapter(mcp, budget, connectivity);

      const result = await adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway');

      expect(result.annotations).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    test('queries normally when source is available', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const connectivity = buildConnectivity('available');
      const adapter = new GrafanaAdapter(mcp, budget, connectivity);

      const result = await adapter.listAlerts('abc123', ['alerting', 'pending'], 'api-gateway');

      expect(result.alerts.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
    });

    test('queries normally when source is degraded', async () => {
      const { mcp, calls } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const connectivity = buildConnectivity('degraded');
      const adapter = new GrafanaAdapter(mcp, budget, connectivity);

      const result = await adapter.listAlerts('abc123', ['alerting', 'pending'], 'api-gateway');

      expect(result.alerts.length).toBeGreaterThan(0);
      expect(calls).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-11: Timeout handling
  // -------------------------------------------------------------------------

  describe('TC-1-3-11: timeout handling', () => {
    test('throws AdapterTimeoutError when alert query exceeds timeout', async () => {
      const slowMcp: McpToolCaller = {
        callTool: () => new Promise((resolve) => {
          setTimeout(() => resolve({}), 5000);
        }),
      };
      const budget = buildBudget({
        grafana: { max_queries_per_service: 10, timeout_seconds: 0.05 },
      });
      const adapter = new GrafanaAdapter(slowMcp, budget);

      await expect(
        adapter.listAlerts('abc123', ['alerting'], 'api-gateway'),
      ).rejects.toThrow(AdapterTimeoutError);
    });

    test('throws AdapterTimeoutError when annotation query exceeds timeout', async () => {
      const slowMcp: McpToolCaller = {
        callTool: () => new Promise((resolve) => {
          setTimeout(() => resolve({}), 5000);
        }),
      };
      const budget = buildBudget({
        grafana: { max_queries_per_service: 10, timeout_seconds: 0.05 },
      });
      const adapter = new GrafanaAdapter(slowMcp, budget);

      await expect(
        adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway'),
      ).rejects.toThrow(AdapterTimeoutError);
    });

    test('timeout error includes source and query name', async () => {
      const slowMcp: McpToolCaller = {
        callTool: () => new Promise((resolve) => {
          setTimeout(() => resolve({}), 5000);
        }),
      };
      const budget = buildBudget({
        grafana: { max_queries_per_service: 10, timeout_seconds: 0.05 },
      });
      const adapter = new GrafanaAdapter(slowMcp, budget);

      try {
        await adapter.listAlerts('abc123', ['alerting'], 'api-gateway');
        fail('Expected AdapterTimeoutError');
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterTimeoutError);
        const timeoutErr = err as AdapterTimeoutError;
        expect(timeoutErr.source).toBe('grafana');
        expect(timeoutErr.queryName).toBe('list_alerts');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    test('handles non-array alert response gracefully', async () => {
      const { mcp } = buildMockMcp({ unexpected: 'format' });
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.listAlerts('abc123', ['alerting'], 'api-gateway');

      expect(result.alerts).toEqual([]);
    });

    test('handles non-array annotation response gracefully', async () => {
      const { mcp } = buildMockMcp({ unexpected: 'format' });
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      const result = await adapter.getAnnotations('abc123', 4, ['deploy'], 'api-gateway');

      expect(result.annotations).toEqual([]);
    });

    test('uses dashboardUid as default serviceName for budget tracking', async () => {
      const { mcp } = buildMockMcp(buildMockAlertResponse());
      const budget = buildBudget();
      const adapter = new GrafanaAdapter(mcp, budget);

      await adapter.listAlerts('abc123');

      // Default serviceName is the dashboardUid
      expect(budget.remaining('grafana', 'abc123')).toBe(9);
    });
  });
});
