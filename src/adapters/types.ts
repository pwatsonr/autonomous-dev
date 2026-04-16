/**
 * Shared types for the connectivity validation and query budget enforcement
 * adapters.
 *
 * Based on SPEC-007-1-2 (Tasks 4 & 5).
 */

// ---------------------------------------------------------------------------
// Connectivity validation types (Task 4)
// ---------------------------------------------------------------------------

/** Classification of a data source's health after a probe. */
export type DataSourceStatus = 'available' | 'degraded' | 'unreachable' | 'not_configured';

/** Valid DataSourceStatus values for runtime validation. */
export const DATA_SOURCE_STATUSES: readonly DataSourceStatus[] = [
  'available',
  'degraded',
  'unreachable',
  'not_configured',
] as const;

/** Result of probing a single data source. */
export interface ConnectivityResult {
  /** Canonical source name: "prometheus" | "grafana" | "opensearch" | "sentry". */
  source: string;
  /** Health classification determined by the probe. */
  status: DataSourceStatus;
  /** Elapsed wall-clock time in milliseconds, or null on error / not_configured. */
  response_time_ms: number | null;
  /** Error message captured on failure, undefined when healthy. */
  error?: string;
}

/** Aggregated connectivity report produced before each observation run. */
export interface ConnectivityReport {
  /** Per-source probe results. */
  results: ConnectivityResult[];
  /** True when every *configured* source is unreachable (run should abort). */
  all_unreachable: boolean;
  /** ISO 8601 timestamp of report generation. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Query budget types (Task 5)
// ---------------------------------------------------------------------------

/** Budget configuration for a single data source. */
export interface QueryBudgetConfig {
  /** Maximum number of queries allowed per service per run. */
  max_queries_per_service: number;
  /** Per-query timeout in seconds. */
  timeout_seconds: number;
}

/** Snapshot of budget consumption for one source/service pair. */
export interface BudgetState {
  /** Canonical source name. */
  source: string;
  /** Service identifier. */
  service: string;
  /** Number of queries successfully dispatched. */
  queries_executed: number;
  /** Number of queries blocked due to budget exhaustion. */
  queries_blocked: number;
  /** True once the per-service limit has been reached. */
  budget_exhausted: boolean;
}

// ---------------------------------------------------------------------------
// Default budgets (from TDD section 3.1.4)
// ---------------------------------------------------------------------------

/** Default query budget configurations keyed by source name. */
export const DEFAULT_BUDGETS: Record<string, QueryBudgetConfig> = {
  prometheus: { max_queries_per_service: 20, timeout_seconds: 30 },
  grafana: { max_queries_per_service: 10, timeout_seconds: 30 },
  opensearch: { max_queries_per_service: 15, timeout_seconds: 60 },
  sentry: { max_queries_per_service: 10, timeout_seconds: 30 },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard timeout for connectivity probes (milliseconds). */
export const PROBE_HARD_TIMEOUT_MS = 30_000;

/** Threshold (ms) above which a probe response is classified as degraded. */
export const PROBE_DEGRADED_THRESHOLD_MS = 5_000;

// ---------------------------------------------------------------------------
// MCP tool caller abstraction (SPEC-007-1-3)
// ---------------------------------------------------------------------------

/**
 * Abstraction over the MCP tool call mechanism.
 * Implementations call the actual MCP server; tests inject mocks.
 */
export interface McpToolCaller {
  callTool(toolName: string, params: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Query budget tracker interface (SPEC-007-1-3)
// ---------------------------------------------------------------------------

/** Canonical data source name. */
export type DataSourceName = 'prometheus' | 'grafana' | 'opensearch' | 'sentry';

/**
 * Tracks per-source, per-service query counts against configured budgets.
 * All adapters check canQuery() before MCP calls and call recordQuery() after.
 */
export interface QueryBudgetTracker {
  /** Returns true if the budget allows another query for this source/service pair. */
  canQuery(source: DataSourceName, serviceName: string): boolean;

  /** Records that a query was executed for this source/service pair. */
  recordQuery(source: DataSourceName, serviceName: string): void;

  /** Returns the remaining query count for this source/service pair. */
  remaining(source: DataSourceName, serviceName: string): number;

  /** Returns the timeout in milliseconds for a given source. */
  getTimeoutMs(source: DataSourceName): number;
}

/**
 * Default in-memory implementation of QueryBudgetTracker.
 *
 * Tracks usage counts per source/service pair and enforces the budget
 * limits from the provided config map.
 */
export class DefaultQueryBudgetTracker implements QueryBudgetTracker {
  private readonly counts = new Map<string, number>();

  constructor(
    private readonly budgets: Record<string, QueryBudgetConfig>,
  ) {}

  private key(source: DataSourceName, serviceName: string): string {
    return `${source}:${serviceName}`;
  }

  canQuery(source: DataSourceName, serviceName: string): boolean {
    const budget = this.budgets[source];
    if (!budget) return false;
    const used = this.counts.get(this.key(source, serviceName)) ?? 0;
    return used < budget.max_queries_per_service;
  }

  recordQuery(source: DataSourceName, serviceName: string): void {
    const k = this.key(source, serviceName);
    this.counts.set(k, (this.counts.get(k) ?? 0) + 1);
  }

  remaining(source: DataSourceName, serviceName: string): number {
    const budget = this.budgets[source];
    if (!budget) return 0;
    const used = this.counts.get(this.key(source, serviceName)) ?? 0;
    return Math.max(0, budget.max_queries_per_service - used);
  }

  getTimeoutMs(source: DataSourceName): number {
    const budget = this.budgets[source];
    return budget ? budget.timeout_seconds * 1000 : 30_000;
  }
}

// ---------------------------------------------------------------------------
// Prometheus result types (SPEC-007-1-3, Task 6)
// ---------------------------------------------------------------------------

export interface PrometheusResult {
  query_name: string;
  query: string;
  value: number | null;
  timestamp: string;
  labels?: Record<string, string>;
  raw_response: unknown;
}

export interface PrometheusRangeResult extends PrometheusResult {
  data_points: Array<{ timestamp: string; value: number }>;
}

// ---------------------------------------------------------------------------
// OpenSearch result types (SPEC-007-1-3, Task 7)
// ---------------------------------------------------------------------------

export interface OpenSearchHit {
  timestamp: string;
  message: string;
  stack_trace?: string;
  trace_id?: string;
  user_id?: string;
  request_path?: string;
}

export interface OpenSearchAggregation {
  error_messages: Array<{ key: string; doc_count: number }>;
}

export interface OpenSearchResult {
  query_name: string;
  hits: OpenSearchHit[];
  aggregations?: OpenSearchAggregation;
  total_hits: number;
}

// ---------------------------------------------------------------------------
// Grafana result types (SPEC-007-1-3, Task 8)
// ---------------------------------------------------------------------------

export type GrafanaAlertState = 'alerting' | 'pending' | 'ok' | 'no_data';

export interface GrafanaAlert {
  name: string;
  state: GrafanaAlertState;
  dashboard_uid: string;
  since: string;
  annotations?: Record<string, string>;
}

export interface GrafanaAlertResult {
  alerts: GrafanaAlert[];
}

export interface GrafanaAnnotation {
  id: number;
  time: string;
  text: string;
  tags: string[];
  dashboard_uid: string;
}

export interface GrafanaAnnotationResult {
  annotations: GrafanaAnnotation[];
}

// ---------------------------------------------------------------------------
// Adapter timeout error
// ---------------------------------------------------------------------------

export class AdapterTimeoutError extends Error {
  constructor(
    public readonly source: DataSourceName,
    public readonly queryName: string,
    public readonly timeoutMs: number,
  ) {
    super(`Query "${queryName}" to ${source} timed out after ${timeoutMs}ms`);
    this.name = 'AdapterTimeoutError';
  }
}
