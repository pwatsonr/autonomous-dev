/**
 * OpenSearch MCP data collection adapter (SPEC-007-1-3, Task 7).
 *
 * Executes parameterized OpenSearch queries via MCP tool calls to collect
 * error log aggregations and deduplicated error samples for monitored
 * services. Respects query budgets and handles unreachable sources.
 */

import type { ServiceConfig } from '../config/intelligence-config.schema';
import type {
  McpToolCaller,
  QueryBudgetTracker,
  OpenSearchResult,
  OpenSearchHit,
  OpenSearchAggregation,
  DataSourceName,
  ConnectivityReport,
} from './types';
import { AdapterTimeoutError } from './types';

// ---------------------------------------------------------------------------
// Query template builders (TDD section 3.3.1)
// ---------------------------------------------------------------------------

/**
 * Builds an OpenSearch aggregation query for top error messages.
 *
 * Returns the top 20 error messages by count within the specified time
 * window, along with the 50 most recent error log entries.
 *
 * @param service      Service name for filtering
 * @param windowHours  Lookback window in hours (default 4)
 */
export function buildErrorAggregationQuery(
  service: string,
  windowHours: number = 4,
): Record<string, unknown> {
  return {
    query: {
      bool: {
        must: [
          { match: { level: 'ERROR' } },
          { range: { '@timestamp': { gte: `now-${windowHours}h` } } },
        ],
        filter: [
          { term: { 'service.name': service } },
        ],
      },
    },
    aggs: {
      error_messages: {
        terms: { field: 'message.keyword', size: 20 },
      },
    },
    size: 50,
    _source: ['@timestamp', 'message', 'level', 'stack_trace', 'trace_id'],
  };
}

/**
 * Builds an OpenSearch collapsed/deduplicated error sample query.
 *
 * Returns the 10 most recent unique error messages (collapsed on
 * message.keyword) with stack traces and trace IDs for correlation.
 *
 * @param service      Service name for filtering
 * @param windowHours  Lookback window in hours (default 4)
 */
export function buildErrorSampleQuery(
  service: string,
  windowHours: number = 4,
): Record<string, unknown> {
  return {
    query: {
      bool: {
        must: [
          { match: { level: 'ERROR' } },
          { range: { '@timestamp': { gte: `now-${windowHours}h` } } },
        ],
        filter: [
          { term: { 'service.name': service } },
        ],
      },
    },
    collapse: { field: 'message.keyword' },
    sort: [{ '@timestamp': 'desc' }],
    size: 10,
    _source: ['@timestamp', 'message', 'stack_trace', 'trace_id', 'user_id', 'request_path'],
  };
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, queryName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AdapterTimeoutError('opensearch', queryName, ms)),
      ms,
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// ---------------------------------------------------------------------------
// Response parsing helpers
// ---------------------------------------------------------------------------

/**
 * Parses an OpenSearch search response into structured hits.
 *
 * OpenSearch responses have the shape:
 * ```json
 * {
 *   "hits": {
 *     "total": { "value": 123 },
 *     "hits": [{ "_source": { "@timestamp": "...", "message": "...", ... } }]
 *   },
 *   "aggregations": { ... }
 * }
 * ```
 */
function parseSearchResponse(
  queryName: string,
  raw: unknown,
): OpenSearchResult {
  const response = raw as Record<string, unknown>;
  const hitsWrapper = response?.hits as Record<string, unknown> | undefined;

  // Total hits
  const totalObj = hitsWrapper?.total;
  let totalHits = 0;
  if (typeof totalObj === 'number') {
    totalHits = totalObj;
  } else if (totalObj && typeof totalObj === 'object') {
    totalHits = (totalObj as Record<string, unknown>).value as number ?? 0;
  }

  // Parse individual hits
  const rawHits = (hitsWrapper?.hits as Array<Record<string, unknown>>) ?? [];
  const hits: OpenSearchHit[] = rawHits.map((hit) => {
    const source = (hit._source as Record<string, unknown>) ?? {};
    return {
      timestamp: (source['@timestamp'] as string) ?? '',
      message: (source.message as string) ?? '',
      stack_trace: source.stack_trace as string | undefined,
      trace_id: source.trace_id as string | undefined,
      user_id: source.user_id as string | undefined,
      request_path: source.request_path as string | undefined,
    };
  });

  // Parse aggregations
  let aggregations: OpenSearchAggregation | undefined;
  const rawAggs = response?.aggregations as Record<string, unknown> | undefined;
  if (rawAggs?.error_messages) {
    const errorMsgs = rawAggs.error_messages as Record<string, unknown>;
    const buckets = (errorMsgs.buckets as Array<Record<string, unknown>>) ?? [];
    aggregations = {
      error_messages: buckets.map((b) => ({
        key: b.key as string,
        doc_count: b.doc_count as number,
      })),
    };
  }

  return {
    query_name: queryName,
    hits,
    aggregations,
    total_hits: totalHits,
  };
}

// ---------------------------------------------------------------------------
// OpenSearchAdapter
// ---------------------------------------------------------------------------

export class OpenSearchAdapter {
  private readonly source: DataSourceName = 'opensearch';

  constructor(
    private readonly mcp: McpToolCaller,
    private readonly budget: QueryBudgetTracker,
    private readonly connectivity?: ConnectivityReport,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Collects error logs for a service by executing both query templates:
   * 1. Error aggregation (top error messages with counts)
   * 2. Error sample retrieval (deduplicated latest errors with stack traces)
   *
   * Returns empty results if the source is unreachable or the budget is
   * exhausted.
   *
   * @param service      The service configuration
   * @param windowHours  Lookback window in hours (default 4)
   * @returns Array of OpenSearchResult (one per executed query)
   */
  async collectServiceLogs(
    service: ServiceConfig,
    windowHours: number = 4,
  ): Promise<OpenSearchResult[]> {
    if (this.isUnreachable()) {
      return [];
    }

    const results: OpenSearchResult[] = [];

    // Query 1: Error aggregation
    if (this.budget.canQuery(this.source, service.name)) {
      const aggQuery = buildErrorAggregationQuery(service.name, windowHours);
      const aggResult = await this.executeSearch(
        'error_aggregation',
        service.opensearch_index,
        aggQuery,
        service.name,
      );
      this.budget.recordQuery(this.source, service.name);
      results.push(aggResult);
    }

    // Query 2: Error sample retrieval (collapsed/deduped)
    if (this.budget.canQuery(this.source, service.name)) {
      const sampleQuery = buildErrorSampleQuery(service.name, windowHours);
      const sampleResult = await this.executeSearch(
        'error_samples',
        service.opensearch_index,
        sampleQuery,
        service.name,
      );
      this.budget.recordQuery(this.source, service.name);
      results.push(sampleResult);
    }

    return results;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Executes a single OpenSearch search query via the opensearch_search
   * MCP tool.
   */
  private async executeSearch(
    queryName: string,
    index: string,
    body: Record<string, unknown>,
    serviceName: string,
  ): Promise<OpenSearchResult> {
    const timeoutMs = this.budget.getTimeoutMs(this.source);
    const raw = await withTimeout(
      this.mcp.callTool('opensearch_search', { index, body }),
      timeoutMs,
      queryName,
    );

    return parseSearchResponse(queryName, raw);
  }

  /**
   * Checks whether OpenSearch was classified as unreachable during
   * connectivity validation.
   */
  private isUnreachable(): boolean {
    if (!this.connectivity) return false;
    const osResult = this.connectivity.results.find(
      (r) => r.source === 'opensearch',
    );
    return osResult?.status === 'unreachable';
  }
}
