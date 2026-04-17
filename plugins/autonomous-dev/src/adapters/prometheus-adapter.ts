/**
 * Prometheus MCP data collection adapter (SPEC-007-1-3, Task 6).
 *
 * Executes parameterized PromQL queries via MCP tool calls to collect
 * error rates, latency percentiles, throughput, and availability metrics
 * for monitored services. Respects query budgets and handles unreachable
 * sources gracefully.
 */

import type { ServiceConfig } from '../config/intelligence-config.schema';
import type {
  McpToolCaller,
  QueryBudgetTracker,
  PrometheusResult,
  PrometheusRangeResult,
  DataSourceName,
} from './types';
import { AdapterTimeoutError } from './types';
import type { ConnectivityReport } from './types';

// ---------------------------------------------------------------------------
// PromQL query templates (TDD section 3.3.1)
// ---------------------------------------------------------------------------

export const PROMETHEUS_QUERIES: Record<string, (job: string, window: string) => string> = {
  error_rate: (job: string, window: string) =>
    `sum(rate(http_requests_total{job="${job}",status=~"5.."}[${window}])) / sum(rate(http_requests_total{job="${job}"}[${window}])) * 100`,

  latency_p50: (job: string, window: string) =>
    `histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{job="${job}"}[${window}])) by (le)) * 1000`,

  latency_p95: (job: string, window: string) =>
    `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job="${job}"}[${window}])) by (le)) * 1000`,

  latency_p99: (job: string, window: string) =>
    `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job="${job}"}[${window}])) by (le)) * 1000`,

  throughput: (job: string, window: string) =>
    `sum(rate(http_requests_total{job="${job}"}[${window}]))`,

  availability: (job: string, window: string) =>
    `avg_over_time(up{job="${job}"}[${window}]) * 100`,

  error_rate_by_endpoint: (job: string, window: string) =>
    `topk(5, sum by (handler) (rate(http_requests_total{job="${job}",status=~"5.."}[${window}])) / sum by (handler) (rate(http_requests_total{job="${job}"}[${window}])) * 100)`,
};

// ---------------------------------------------------------------------------
// Additional detection queries
// ---------------------------------------------------------------------------

export const DETECTION_QUERIES: Record<string, (job: string, window?: string) => string> = {
  crash_down: (job: string) =>
    `up{job="${job}"} == 0`,

  crash_restarts: (job: string, window: string = '5m') =>
    `changes(up{job="${job}"}[${window}])`,

  sustained_error_rate: (job: string) =>
    `sum(rate(http_requests_total{job="${job}",status=~"5.."}[1m])) / sum(rate(http_requests_total{job="${job}"}[1m])) * 100`,
};

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number, queryName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AdapterTimeoutError('prometheus', queryName, ms)),
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
 * Parses an instant query response from Prometheus.
 *
 * Prometheus instant query responses have the shape:
 * ```json
 * {
 *   "status": "success",
 *   "data": {
 *     "resultType": "vector",
 *     "result": [{ "metric": {...}, "value": [timestamp, "value_string"] }]
 *   }
 * }
 * ```
 */
function parseInstantResult(
  queryName: string,
  query: string,
  raw: unknown,
): PrometheusResult {
  const response = raw as Record<string, unknown>;
  const data = response?.data as Record<string, unknown> | undefined;
  const results = (data?.result as Array<Record<string, unknown>>) ?? [];

  if (results.length === 0) {
    return {
      query_name: queryName,
      query,
      value: null,
      timestamp: new Date().toISOString(),
      raw_response: raw,
    };
  }

  const first = results[0];
  const valueTuple = first.value as [number, string] | undefined;
  const metric = (first.metric as Record<string, string>) ?? {};

  const numericValue = valueTuple ? parseFloat(valueTuple[1]) : null;
  const timestamp = valueTuple
    ? new Date(valueTuple[0] * 1000).toISOString()
    : new Date().toISOString();

  return {
    query_name: queryName,
    query,
    value: numericValue !== null && isNaN(numericValue) ? null : numericValue,
    timestamp,
    labels: Object.keys(metric).length > 0 ? metric : undefined,
    raw_response: raw,
  };
}

/**
 * Parses a range query response from Prometheus.
 *
 * Range query responses have the shape:
 * ```json
 * {
 *   "status": "success",
 *   "data": {
 *     "resultType": "matrix",
 *     "result": [{ "metric": {...}, "values": [[timestamp, "value"], ...] }]
 *   }
 * }
 * ```
 */
function parseRangeResult(
  queryName: string,
  query: string,
  raw: unknown,
): PrometheusRangeResult {
  const response = raw as Record<string, unknown>;
  const data = response?.data as Record<string, unknown> | undefined;
  const results = (data?.result as Array<Record<string, unknown>>) ?? [];

  if (results.length === 0) {
    return {
      query_name: queryName,
      query,
      value: null,
      timestamp: new Date().toISOString(),
      data_points: [],
      raw_response: raw,
    };
  }

  const first = results[0];
  const values = (first.values as Array<[number, string]>) ?? [];
  const metric = (first.metric as Record<string, string>) ?? {};

  const dataPoints = values.map(([ts, val]) => ({
    timestamp: new Date(ts * 1000).toISOString(),
    value: parseFloat(val),
  }));

  // Last data point's value is the "current" value
  const lastPoint = dataPoints[dataPoints.length - 1];
  const currentValue = lastPoint ? lastPoint.value : null;
  const currentTimestamp = lastPoint ? lastPoint.timestamp : new Date().toISOString();

  return {
    query_name: queryName,
    query,
    value: currentValue !== null && isNaN(currentValue) ? null : currentValue,
    timestamp: currentTimestamp,
    labels: Object.keys(metric).length > 0 ? metric : undefined,
    data_points: dataPoints,
    raw_response: raw,
  };
}

// ---------------------------------------------------------------------------
// PrometheusAdapter
// ---------------------------------------------------------------------------

export class PrometheusAdapter {
  private readonly source: DataSourceName = 'prometheus';

  constructor(
    private readonly mcp: McpToolCaller,
    private readonly budget: QueryBudgetTracker,
    private readonly connectivity?: ConnectivityReport,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Collects all standard service metrics using the seven PromQL templates.
   *
   * Checks source reachability first; if the source is unreachable, returns
   * an empty array without making any MCP calls.
   *
   * @param service The service configuration with prometheus_job set
   * @param window  PromQL range window (default "5m")
   * @returns Array of PrometheusResult, one per successfully executed query
   */
  async collectServiceMetrics(
    service: ServiceConfig,
    window: string = '5m',
  ): Promise<PrometheusResult[]> {
    if (this.isUnreachable()) {
      return [];
    }

    const results: PrometheusResult[] = [];
    const job = service.prometheus_job;

    for (const [name, queryFn] of Object.entries(PROMETHEUS_QUERIES)) {
      if (!this.budget.canQuery(this.source, service.name)) {
        break;
      }
      const query = queryFn(job, window);
      const result = await this.executeQuery(name, query);
      this.budget.recordQuery(this.source, service.name);
      results.push(result);
    }

    return results;
  }

  /**
   * Executes a sustained error rate range query for detecting prolonged
   * error conditions.
   *
   * Uses prometheus_query_range with 1-minute step resolution over the
   * specified duration window.
   *
   * @param service          The service configuration
   * @param durationMinutes  Duration to query in minutes (default 30)
   * @returns A PrometheusRangeResult with per-minute data points
   */
  async querySustainedErrorRate(
    service: ServiceConfig,
    durationMinutes: number = 30,
  ): Promise<PrometheusRangeResult> {
    if (this.isUnreachable()) {
      return {
        query_name: 'sustained_error_rate',
        query: '',
        value: null,
        timestamp: new Date().toISOString(),
        data_points: [],
        raw_response: null,
      };
    }

    if (!this.budget.canQuery(this.source, service.name)) {
      return {
        query_name: 'sustained_error_rate',
        query: '',
        value: null,
        timestamp: new Date().toISOString(),
        data_points: [],
        raw_response: null,
      };
    }

    const query = DETECTION_QUERIES.sustained_error_rate(service.prometheus_job);
    const now = new Date();
    const start = new Date(now.getTime() - durationMinutes * 60 * 1000);

    const timeoutMs = this.budget.getTimeoutMs(this.source);
    const raw = await withTimeout(
      this.mcp.callTool('prometheus_query_range', {
        query,
        start: start.toISOString(),
        end: now.toISOString(),
        step: '60s',
      }),
      timeoutMs,
      'sustained_error_rate',
    );
    this.budget.recordQuery(this.source, service.name);

    return parseRangeResult('sustained_error_rate', query, raw);
  }

  /**
   * Executes a single detection query (crash_down, crash_restarts, etc.).
   *
   * @param service   The service configuration
   * @param queryKey  Key into DETECTION_QUERIES
   * @param window    PromQL range window (default "5m")
   * @returns A PrometheusResult
   */
  async executeDetectionQuery(
    service: ServiceConfig,
    queryKey: string,
    window: string = '5m',
  ): Promise<PrometheusResult> {
    if (this.isUnreachable()) {
      return {
        query_name: queryKey,
        query: '',
        value: null,
        timestamp: new Date().toISOString(),
        raw_response: null,
      };
    }

    if (!this.budget.canQuery(this.source, service.name)) {
      return {
        query_name: queryKey,
        query: '',
        value: null,
        timestamp: new Date().toISOString(),
        raw_response: null,
      };
    }

    const queryFn = DETECTION_QUERIES[queryKey];
    if (!queryFn) {
      throw new Error(`Unknown detection query key: ${queryKey}`);
    }

    const query = queryFn(service.prometheus_job, window);
    const result = await this.executeQuery(queryKey, query);
    this.budget.recordQuery(this.source, service.name);

    return result;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Executes a single instant PromQL query via the prometheus_query MCP tool.
   */
  private async executeQuery(
    name: string,
    query: string,
  ): Promise<PrometheusResult> {
    const timeoutMs = this.budget.getTimeoutMs(this.source);
    const raw = await withTimeout(
      this.mcp.callTool('prometheus_query', { query }),
      timeoutMs,
      name,
    );

    return parseInstantResult(name, query, raw);
  }

  /**
   * Checks whether Prometheus was classified as unreachable during
   * connectivity validation.
   */
  private isUnreachable(): boolean {
    if (!this.connectivity) return false;
    const promResult = this.connectivity.results.find(
      (r) => r.source === 'prometheus',
    );
    return promResult?.status === 'unreachable';
  }
}
