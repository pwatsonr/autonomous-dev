/**
 * Unit tests for OpenSearch MCP data collection adapter (SPEC-007-1-3, Task 7).
 *
 * Test case IDs correspond to the spec's acceptance criteria:
 *   TC-1-3-06 through TC-1-3-08, TC-1-3-11.
 */

import {
  OpenSearchAdapter,
  buildErrorAggregationQuery,
  buildErrorSampleQuery,
} from '../../src/adapters/opensearch-adapter';
import type {
  McpToolCaller,
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
function buildMockMcp(response: unknown = buildMockAggregationResponse()): {
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

/** Builds a mock OpenSearch aggregation response. */
function buildMockAggregationResponse(): Record<string, unknown> {
  return {
    hits: {
      total: { value: 150 },
      hits: [
        {
          _source: {
            '@timestamp': '2026-04-08T10:00:00.000Z',
            message: 'NullPointerException in UserService.getUser',
            level: 'ERROR',
            stack_trace: 'java.lang.NullPointerException\n\tat UserService.getUser(UserService.java:42)',
            trace_id: 'abc-123-def',
          },
        },
        {
          _source: {
            '@timestamp': '2026-04-08T09:55:00.000Z',
            message: 'Connection timeout to database',
            level: 'ERROR',
            stack_trace: 'java.net.ConnectException: Connection timed out',
            trace_id: 'xyz-456-ghi',
          },
        },
      ],
    },
    aggregations: {
      error_messages: {
        buckets: [
          { key: 'NullPointerException in UserService.getUser', doc_count: 85 },
          { key: 'Connection timeout to database', doc_count: 42 },
          { key: 'OutOfMemoryError in BatchProcessor', doc_count: 23 },
        ],
      },
    },
  };
}

/** Builds a mock OpenSearch collapsed/sample response. */
function buildMockSampleResponse(count: number = 10): Record<string, unknown> {
  const hits = Array.from({ length: count }, (_, i) => ({
    _source: {
      '@timestamp': `2026-04-08T${String(10 - i).padStart(2, '0')}:00:00.000Z`,
      message: `Unique error message ${i + 1}`,
      stack_trace: `Error stack trace ${i + 1}\n\tat SomeClass.method(SomeClass.java:${i + 10})`,
      trace_id: `trace-${i + 1}`,
      user_id: `user-${i + 1}`,
      request_path: `/api/endpoint-${i + 1}`,
    },
  }));

  return {
    hits: {
      total: { value: count },
      hits,
    },
  };
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

/** Builds a ConnectivityReport with the given OpenSearch status. */
function buildConnectivity(
  opensearchStatus: 'available' | 'degraded' | 'unreachable' = 'available',
): ConnectivityReport {
  return {
    results: [
      { source: 'prometheus', status: 'available', response_time_ms: 50 },
      { source: 'grafana', status: 'available', response_time_ms: 30 },
      { source: 'opensearch', status: opensearchStatus, response_time_ms: 40 },
      { source: 'sentry', status: 'available', response_time_ms: 20 },
    ],
    all_unreachable: false,
    timestamp: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// TC-1-3-06: OpenSearch aggregation query template
// ---------------------------------------------------------------------------

describe('OpenSearchAdapter', () => {
  describe('query templates', () => {
    test('TC-1-3-06: aggregation query matches TDD section 3.3.1 template', () => {
      const query = buildErrorAggregationQuery('api-gateway', 4);

      // Verify query structure
      expect(query.query).toEqual({
        bool: {
          must: [
            { match: { level: 'ERROR' } },
            { range: { '@timestamp': { gte: 'now-4h' } } },
          ],
          filter: [
            { term: { 'service.name': 'api-gateway' } },
          ],
        },
      });

      // Verify aggregation
      expect(query.aggs).toEqual({
        error_messages: {
          terms: { field: 'message.keyword', size: 20 },
        },
      });

      // Verify size and source fields
      expect(query.size).toBe(50);
      expect(query._source).toEqual([
        '@timestamp', 'message', 'level', 'stack_trace', 'trace_id',
      ]);
    });

    test('aggregation query uses configurable window', () => {
      const query = buildErrorAggregationQuery('api-gateway', 8);
      const must = (query.query as any).bool.must;
      const rangeClause = must.find((c: any) => c.range);
      expect(rangeClause.range['@timestamp'].gte).toBe('now-8h');
    });

    test('sample query includes collapse on message.keyword', () => {
      const query = buildErrorSampleQuery('api-gateway', 4);

      expect(query.collapse).toEqual({ field: 'message.keyword' });
      expect(query.sort).toEqual([{ '@timestamp': 'desc' }]);
      expect(query.size).toBe(10);
    });

    test('sample query includes all required source fields', () => {
      const query = buildErrorSampleQuery('api-gateway', 4);

      expect(query._source).toEqual([
        '@timestamp', 'message', 'stack_trace', 'trace_id', 'user_id', 'request_path',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-07: OpenSearch collapse dedup
  // -------------------------------------------------------------------------

  describe('TC-1-3-07: collapse deduplication', () => {
    test('returns unique error messages from collapsed results', async () => {
      const sampleResponse = buildMockSampleResponse(10);
      let callCount = 0;
      const mcp: McpToolCaller = {
        callTool: async () => {
          callCount++;
          // First call returns aggregation, second returns collapsed samples
          return callCount === 1
            ? buildMockAggregationResponse()
            : sampleResponse;
        },
      };
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);

      const sampleResult = results.find((r) => r.query_name === 'error_samples');
      expect(sampleResult).toBeDefined();
      expect(sampleResult!.hits).toHaveLength(10);

      // Verify all messages are distinct
      const messages = sampleResult!.hits.map((h) => h.message);
      const uniqueMessages = new Set(messages);
      expect(uniqueMessages.size).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // TC-1-3-08: OpenSearch result fields
  // -------------------------------------------------------------------------

  describe('TC-1-3-08: result field extraction', () => {
    test('each hit contains @timestamp, message, stack_trace, trace_id', async () => {
      const { mcp } = buildMockMcp(buildMockAggregationResponse());
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);
      const aggResult = results.find((r) => r.query_name === 'error_aggregation');
      expect(aggResult).toBeDefined();

      for (const hit of aggResult!.hits) {
        expect(hit).toHaveProperty('timestamp');
        expect(hit).toHaveProperty('message');
        // stack_trace and trace_id may be undefined but the properties should exist
        expect('stack_trace' in hit).toBe(true);
        expect('trace_id' in hit).toBe(true);
      }
    });

    test('parses aggregation buckets correctly', async () => {
      const { mcp } = buildMockMcp(buildMockAggregationResponse());
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);
      const aggResult = results.find((r) => r.query_name === 'error_aggregation');
      expect(aggResult!.aggregations).toBeDefined();
      expect(aggResult!.aggregations!.error_messages).toHaveLength(3);
      expect(aggResult!.aggregations!.error_messages[0]).toEqual({
        key: 'NullPointerException in UserService.getUser',
        doc_count: 85,
      });
    });

    test('parses total_hits from response', async () => {
      const { mcp } = buildMockMcp(buildMockAggregationResponse());
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);
      const aggResult = results.find((r) => r.query_name === 'error_aggregation');
      expect(aggResult!.total_hits).toBe(150);
    });

    test('handles missing optional fields gracefully', async () => {
      const sparseResponse = {
        hits: {
          total: { value: 1 },
          hits: [
            {
              _source: {
                '@timestamp': '2026-04-08T10:00:00.000Z',
                message: 'Some error',
              },
            },
          ],
        },
      };
      const { mcp } = buildMockMcp(sparseResponse);
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);
      const aggResult = results[0];
      expect(aggResult.hits[0].stack_trace).toBeUndefined();
      expect(aggResult.hits[0].trace_id).toBeUndefined();
      expect(aggResult.hits[0].user_id).toBeUndefined();
      expect(aggResult.hits[0].request_path).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Budget enforcement
  // -------------------------------------------------------------------------

  describe('budget enforcement', () => {
    test('executes both queries when budget allows', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);

      expect(results).toHaveLength(2);
      expect(calls).toHaveLength(2);
      expect(calls[0].toolName).toBe('opensearch_search');
      expect(calls[1].toolName).toBe('opensearch_search');
    });

    test('skips second query when budget allows only one', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget({
        opensearch: { max_queries_per_service: 1, timeout_seconds: 60 },
      });
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);

      expect(results).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(results[0].query_name).toBe('error_aggregation');
    });

    test('returns empty when budget is fully exhausted', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      // Exhaust budget
      for (let i = 0; i < 15; i++) {
        budget.recordQuery('opensearch', 'api-gateway');
      }

      const results = await adapter.collectServiceLogs(service);

      expect(results).toEqual([]);
      expect(calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Unreachable source
  // -------------------------------------------------------------------------

  describe('unreachable source', () => {
    test('returns empty results when source is unreachable', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const connectivity = buildConnectivity('unreachable');
      const adapter = new OpenSearchAdapter(mcp, budget, connectivity);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);

      expect(results).toEqual([]);
      expect(calls).toHaveLength(0);
    });

    test('queries normally when source is available', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const connectivity = buildConnectivity('available');
      const adapter = new OpenSearchAdapter(mcp, budget, connectivity);
      const service = buildService();

      const results = await adapter.collectServiceLogs(service);

      expect(results).toHaveLength(2);
      expect(calls).toHaveLength(2);
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
      const budget = buildBudget({
        opensearch: { max_queries_per_service: 15, timeout_seconds: 0.05 },
      });
      const adapter = new OpenSearchAdapter(slowMcp, budget);
      const service = buildService();

      await expect(adapter.collectServiceLogs(service)).rejects.toThrow(
        AdapterTimeoutError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // MCP tool call parameters
  // -------------------------------------------------------------------------

  describe('MCP tool call parameters', () => {
    test('passes correct index and body to opensearch_search', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService({ opensearch_index: 'logs-custom-*' });

      await adapter.collectServiceLogs(service);

      expect(calls[0].params.index).toBe('logs-custom-*');
      expect(calls[0].params.body).toBeDefined();
      const body = calls[0].params.body as Record<string, unknown>;
      expect(body.query).toBeDefined();
      expect(body.aggs).toBeDefined();
    });

    test('uses configurable window hours', async () => {
      const { mcp, calls } = buildMockMcp();
      const budget = buildBudget();
      const adapter = new OpenSearchAdapter(mcp, budget);
      const service = buildService();

      await adapter.collectServiceLogs(service, 8);

      const body = calls[0].params.body as Record<string, unknown>;
      const query = body.query as any;
      const rangeClause = query.bool.must.find((c: any) => c.range);
      expect(rangeClause.range['@timestamp'].gte).toBe('now-8h');
    });
  });
});
