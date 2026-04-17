/**
 * Unit tests for Prometheus MCP data collection adapter (SPEC-007-1-3, Task 6).
 *
 * Test case IDs correspond to the spec's acceptance criteria:
 *   TC-1-3-01 through TC-1-3-05, TC-1-3-11, TC-1-3-12.
 */

import {
  PrometheusAdapter,
  PROMETHEUS_QUERIES,
  DETECTION_QUERIES,
} from '../../src/adapters/prometheus-adapter';
import type {
  McpToolCaller,
  QueryBudgetTracker,
  DataSourceName,
  ConnectivityReport,
} from '../../src/adapters/types';
import {
  DefaultQueryBudgetTracker,
  AdapterTimeoutError,
} from '../../src/adapters/types';
import type { ServiceConfig } from '../../src/config/intelligence-config.schema';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal ServiceConfig for testing. */
function buildService(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: 'api-gateway',
    repo: 'org/api-gateway',
    prometheus_job: 'api-gateway',
    grafana_dashboard_uid: 'abc123',
    opensearch_index: 'logs-api-gateway-*',
    criticality: 'critical',
    ...overrides,
  };
}

/** Builds a mock MCP tool caller that records calls and returns a value. */
function buildMockMcp(response: unknown = buildMockPrometheusResponse()): {
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

/** Builds a standard Prometheus instant query response. */
function buildMockPrometheusResponse(
  value: string = '12.3',
  timestamp: number = 1712588400,
): Record<string, unknown> {
  return {
    status: 'success',
    data: {
      resultType: 'vector',
      result: [
        {
          metric: { job: 'api-gateway' },
          value: [timestamp, value],
        },
      ],
    },
  };
}

/** Builds a Prometheus range query response with multiple data points. */
function buildMockRangeResponse(
  values: Array<[number, string]>,
): Record<string, unknown> {
  return {
    status: 'success',
    data: {
      resultType: 'matrix',
      result: [
        {
          metric: { job: 'api-gateway' },
          values,
        },
      ],
    },
  };
}

/** Builds a default query budget tracker with standard limits. */
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

/** Builds a ConnectivityReport with the given Prometheus status. */
function buildConnectivity(
  prometheusStatus: 'available' | 'degraded' | 'unreachable' = 'available',
): ConnectivityReport {
  return {
    results: [
      { source: 'prometheus', status: prometheusStatus, response_time_ms: 50 },
      { source: 'grafana', status: 'available', response_time_ms: 30 },
      { source: 'opensearch', status: 'available', response_time_ms: 40 },
      { source: 'sentry', status: 'available', response_time_ms: 20 },
    ],
    all_unreachable: false,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TC-1-3-01: Prometheus error rate query
// ---------------------------------------------------------------------------

describe('PrometheusAdapter', () => {
  describe('PROMETHEUS_QUERIES templates', () => {
    test('TC-1-3-01: error_rate query generates correct PromQL', () => {
      const query = PROMETHEUS_QUERIES.error_rate('api-gateway', '5m');
      expect(query).toBe(
        'sum(rate(http_requests_total{job="api-gateway",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="api-gateway"}[5m])) * 100',
      );
    });

    test('latency_p50 query generates correct PromQL', () => {
      const query = PROMETHEUS_QUERIES.latency_p50('api-gateway', '5m');
      expect(query).toBe(
        'histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{job="api-gateway"}[5m])) by (le)) * 1000',
      );
    });

    test('latency_p95 query generates correct PromQL', () => {
      const query = PROMETHEUS_QUERIES.latency_p95('api-gateway', '5m');
      expect(query).toBe(
        'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job="api-gateway"}[5m])) by (le)) * 1000',
      );
    });

    test('latency_p99 query generates correct PromQL', () => {
      const query = PROMETHEUS_QUERIES.latency_p99('api-gateway', '5m');
      expect(query).toBe(
        'histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job="api-gateway"}[5m])) by (le)) * 1000',
      );
    });

    test('throughput query generates correct PromQL', () => {
      const query = PROMETHEUS_QUERIES.throughput('api-gateway', '5m');
      expect(query).toBe(
        'sum(rate(http_requests_total{job="api-gateway"}[5m]))',
      );
    });

    test('availability query generates correct PromQL', () => {
      const query = PROMETHEUS_QUERIES.availability('api-gateway', '5m');
      expect(query).toBe(
        'avg_over_time(up{job="api-gateway"}[5m]) * 100',
      );
    });

    test('error_rate_by_endpoint query generates correct PromQL', () => {
      const query = PROMETHEUS_QUERIES.error_rate_by_endpoint('api-gateway', '5m');
      expect(query).toBe(
        'topk(5, sum by (handler) (rate(http_requests_total{job="api-gateway",status=~"5.."}[5m])) / sum by (handler) (rate(http_requests_total{job="api-gateway"}[5m])) * 100)',
      );
    });

    test('all seven query templates are defined', () => {
      expect(Object.keys(PROMETHEUS_QUERIES)).toHaveLength(7);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-02: Prometheus range query
  // -------------------------------------------------------------------------

  describe('TC-1-3-02: sustained error rate range query', () => {
    test('executes range query with step=60s and correct timestamps', async () => {
      const rangeResponse = buildMockRangeResponse([
        [1712588100, '2.5'],
        [1712588160, '3.1'],
        [1712588220, '4.0'],
      ]);
      const { mcp, calls } = buildMockMcp(rangeResponse);
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const result = await adapter.querySustainedErrorRate(service, 30);

      expect(calls).toHaveLength(1);
      expect(calls[0].toolName).toBe('prometheus_query_range');
      expect(calls[0].params.step).toBe('60s');
      expect(calls[0].params.query).toContain('api-gateway');
      // Start should be ~30 minutes before end
      const startTime = new Date(calls[0].params.start as string).getTime();
      const endTime = new Date(calls[0].params.end as string).getTime();
      const durationMs = endTime - startTime;
      expect(durationMs).toBeGreaterThanOrEqual(29 * 60 * 1000);
      expect(durationMs).toBeLessThanOrEqual(31 * 60 * 1000);

      expect(result.query_name).toBe('sustained_error_rate');
      expect(result.data_points).toHaveLength(3);
      expect(result.data_points[0].value).toBe(2.5);
      expect(result.data_points[2].value).toBe(4.0);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-03: Prometheus result parsing
  // -------------------------------------------------------------------------

  describe('TC-1-3-03: result parsing', () => {
    test('parses instant query value correctly', async () => {
      const response = buildMockPrometheusResponse('12.3', 1712588400);
      const { mcp } = buildMockMcp(response);
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);

      expect(results.length).toBeGreaterThan(0);
      const errorRate = results.find((r) => r.query_name === 'error_rate');
      expect(errorRate).toBeDefined();
      expect(errorRate!.value).toBe(12.3);
    });

    test('parses timestamp from Prometheus epoch format', async () => {
      const response = buildMockPrometheusResponse('12.3', 1712588400);
      const { mcp } = buildMockMcp(response);
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);
      const errorRate = results.find((r) => r.query_name === 'error_rate');
      expect(errorRate!.timestamp).toBe(new Date(1712588400 * 1000).toISOString());
    });

    test('returns null value when result array is empty', async () => {
      const emptyResponse = {
        status: 'success',
        data: { resultType: 'vector', result: [] },
      };
      const { mcp } = buildMockMcp(emptyResponse);
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);
      const errorRate = results.find((r) => r.query_name === 'error_rate');
      expect(errorRate!.value).toBeNull();
    });

    test('handles NaN values gracefully', async () => {
      const nanResponse = buildMockPrometheusResponse('NaN', 1712588400);
      const { mcp } = buildMockMcp(nanResponse);
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);
      const errorRate = results.find((r) => r.query_name === 'error_rate');
      expect(errorRate!.value).toBeNull();
    });

    test('includes labels when metric object has entries', async () => {
      const response = buildMockPrometheusResponse('5.0', 1712588400);
      const { mcp } = buildMockMcp(response);
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);
      const errorRate = results.find((r) => r.query_name === 'error_rate');
      expect(errorRate!.labels).toEqual({ job: 'api-gateway' });
    });

    test('preserves raw_response for downstream processing', async () => {
      const response = buildMockPrometheusResponse('12.3', 1712588400);
      const { mcp } = buildMockMcp(response);
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);
      expect(results[0].raw_response).toEqual(response);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-04: Prometheus budget respected
  // -------------------------------------------------------------------------

  describe('TC-1-3-04: budget enforcement', () => {
    test('stops querying when budget is exhausted', async () => {
      const { mcp, calls } = buildMockMcp();
      // Budget of 3 queries -- should execute only 3 of 7 templates
      const budget = buildBudget({
        prometheus: { max_queries_per_service: 3, timeout_seconds: 30 },
      });
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);

      expect(results).toHaveLength(3);
      expect(calls).toHaveLength(3);
      expect(budget.remaining('prometheus', 'api-gateway')).toBe(0);
    });

    test('executes at budget limit then blocks next call', async () => {
      const { mcp, calls } = buildMockMcp();
      // Budget that allows exactly 1 query
      const budget = buildBudget({
        prometheus: { max_queries_per_service: 1, timeout_seconds: 30 },
      });
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);

      expect(results).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(budget.canQuery('prometheus', 'api-gateway')).toBe(false);
    });

    test('budget at 19/20 executes one more query then blocks', async () => {
      const { mcp } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      // Simulate 19 previous queries
      for (let i = 0; i < 19; i++) {
        budget.recordQuery('prometheus', 'api-gateway');
      }
      expect(budget.remaining('prometheus', 'api-gateway')).toBe(1);

      const results = await adapter.collectServiceMetrics(service);

      // Should execute exactly 1 query (the first one) then stop
      expect(results).toHaveLength(1);
      expect(budget.canQuery('prometheus', 'api-gateway')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-05: Prometheus unavailable
  // -------------------------------------------------------------------------

  describe('TC-1-3-05: unreachable source', () => {
    test('returns empty results when source is unreachable', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const connectivity = buildConnectivity('unreachable');
      const adapter = new PrometheusAdapter(mcp, budget, connectivity);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);

      expect(results).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    test('sustained error rate returns empty when unreachable', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const connectivity = buildConnectivity('unreachable');
      const adapter = new PrometheusAdapter(mcp, budget, connectivity);
      const service = buildService();

      const result = await adapter.querySustainedErrorRate(service, 30);

      expect(result.data_points).toEqual([]);
      expect(result.value).toBeNull();
      expect(calls).toHaveLength(0);
    });

    test('detection query returns empty when unreachable', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const connectivity = buildConnectivity('unreachable');
      const adapter = new PrometheusAdapter(mcp, budget, connectivity);
      const service = buildService();

      const result = await adapter.executeDetectionQuery(service, 'crash_down');

      expect(result.value).toBeNull();
      expect(calls).toHaveLength(0);
    });

    test('queries normally when source is available', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const connectivity = buildConnectivity('available');
      const adapter = new PrometheusAdapter(mcp, budget, connectivity);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);

      expect(results.length).toBeGreaterThan(0);
      expect(calls.length).toBeGreaterThan(0);
    });

    test('queries normally when source is degraded', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const connectivity = buildConnectivity('degraded');
      const adapter = new PrometheusAdapter(mcp, budget, connectivity);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);

      expect(results.length).toBeGreaterThan(0);
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-11: Timeout handling
  // -------------------------------------------------------------------------

  describe('TC-1-3-11: timeout handling', () => {
    test('throws AdapterTimeoutError when query exceeds budget timeout', async () => {
      const slowMcp: McpToolCaller = {
        callTool: () => new Promise((resolve) => {
          setTimeout(() => resolve({}), 5000);
        }),
      };
      // Very short timeout
      const budget = buildBudget({
        prometheus: { max_queries_per_service: 20, timeout_seconds: 0.05 },
      });
      const adapter = new PrometheusAdapter(slowMcp, budget);
      const service = buildService();

      await expect(adapter.collectServiceMetrics(service)).rejects.toThrow(
        AdapterTimeoutError,
      );
    });

    test('timeout error includes source, query name, and duration', async () => {
      const slowMcp: McpToolCaller = {
        callTool: () => new Promise((resolve) => {
          setTimeout(() => resolve({}), 5000);
        }),
      };
      const budget = buildBudget({
        prometheus: { max_queries_per_service: 20, timeout_seconds: 0.05 },
      });
      const adapter = new PrometheusAdapter(slowMcp, budget);
      const service = buildService();

      try {
        await adapter.collectServiceMetrics(service);
        fail('Expected AdapterTimeoutError');
      } catch (err) {
        expect(err).toBeInstanceOf(AdapterTimeoutError);
        const timeoutErr = err as AdapterTimeoutError;
        expect(timeoutErr.source).toBe('prometheus');
        expect(timeoutErr.queryName).toBe('error_rate');
        expect(timeoutErr.timeoutMs).toBe(50);
      }
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-12: Latency in milliseconds
  // -------------------------------------------------------------------------

  describe('TC-1-3-12: latency unit conversion', () => {
    test('latency queries multiply seconds by 1000 to produce milliseconds', async () => {
      // Prometheus returns latency in seconds (0.045)
      // The * 1000 is in the PromQL template itself, so Prometheus does the math.
      // Here we verify the query template includes the multiplication.
      const p99Query = PROMETHEUS_QUERIES.latency_p99('api-gateway', '5m');
      expect(p99Query).toContain('* 1000');

      const p95Query = PROMETHEUS_QUERIES.latency_p95('api-gateway', '5m');
      expect(p95Query).toContain('* 1000');

      const p50Query = PROMETHEUS_QUERIES.latency_p50('api-gateway', '5m');
      expect(p50Query).toContain('* 1000');
    });

    test('parsed result reflects the multiplied value from Prometheus', async () => {
      // Prometheus already returns the value in ms because of * 1000 in the query
      // e.g., 0.045 seconds * 1000 = 45 ms
      const response = buildMockPrometheusResponse('45', 1712588400);
      const { mcp } = buildMockMcp(response);
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);
      const p99 = results.find((r) => r.query_name === 'latency_p99');
      expect(p99).toBeDefined();
      expect(p99!.value).toBe(45);
    });
  });

  // -------------------------------------------------------------------------
  // Detection queries
  // -------------------------------------------------------------------------

  describe('detection queries', () => {
    test('crash_down query generates correct PromQL', () => {
      const query = DETECTION_QUERIES.crash_down('api-gateway');
      expect(query).toBe('up{job="api-gateway"} == 0');
    });

    test('crash_restarts query generates correct PromQL', () => {
      const query = DETECTION_QUERIES.crash_restarts('api-gateway', '5m');
      expect(query).toBe('changes(up{job="api-gateway"}[5m])');
    });

    test('sustained_error_rate uses 1m resolution', () => {
      const query = DETECTION_QUERIES.sustained_error_rate('api-gateway');
      expect(query).toContain('[1m]');
    });

    test('executeDetectionQuery calls MCP with correct query', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      await adapter.executeDetectionQuery(service, 'crash_down');

      expect(calls).toHaveLength(1);
      expect(calls[0].toolName).toBe('prometheus_query');
      expect(calls[0].params.query).toBe('up{job="api-gateway"} == 0');
    });

    test('executeDetectionQuery throws for unknown query key', async () => {
      const { mcp } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      await expect(
        adapter.executeDetectionQuery(service, 'nonexistent'),
      ).rejects.toThrow('Unknown detection query key');
    });
  });

  // -------------------------------------------------------------------------
  // collectServiceMetrics integration
  // -------------------------------------------------------------------------

  describe('collectServiceMetrics', () => {
    test('executes all 7 queries when budget allows', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceMetrics(service);

      expect(results).toHaveLength(7);
      expect(calls).toHaveLength(7);

      const queryNames = results.map((r) => r.query_name);
      expect(queryNames).toEqual([
        'error_rate',
        'latency_p50',
        'latency_p95',
        'latency_p99',
        'throughput',
        'availability',
        'error_rate_by_endpoint',
      ]);
    });

    test('passes service prometheus_job to query templates', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService({ prometheus_job: 'my-custom-job' });

      await adapter.collectServiceMetrics(service);

      // All queries should reference the custom job name
      for (const call of calls) {
        const query = call.params.query as string;
        expect(query).toContain('my-custom-job');
      }
    });

    test('uses the specified window parameter', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      await adapter.collectServiceMetrics(service, '15m');

      for (const call of calls) {
        const query = call.params.query as string;
        expect(query).toContain('[15m]');
      }
    });

    test('calls prometheus_query MCP tool', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new PrometheusAdapter(mcp, budget);
      const service = buildService();

      await adapter.collectServiceMetrics(service);

      for (const call of calls) {
        expect(call.toolName).toBe('prometheus_query');
      }
    });
  });
});
