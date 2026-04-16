/**
 * Per-invocation metric schema and types (SPEC-005-2-1, Task 1).
 *
 * Defines the complete data model for agent invocation metrics,
 * alert records, and aggregate snapshots consumed by the JSONL
 * writer, SQLite store, and the rest of the Agent Factory.
 */

// ---------------------------------------------------------------------------
// Literal / enum types
// ---------------------------------------------------------------------------

/** Outcome of a review pass on an invocation output. */
export type ReviewOutcome =
  | 'approved'
  | 'rejected'
  | 'revision_requested'
  | 'not_reviewed';

/** Runtime environment in which the invocation occurred. */
export type Environment = 'production' | 'validation' | 'canary';

/** Severity level for an alert record. */
export type AlertSeverity = 'info' | 'warning' | 'critical';

// ---------------------------------------------------------------------------
// Tool-call record
// ---------------------------------------------------------------------------

/** Aggregated record of tool usage within a single invocation. */
export interface ToolCallRecord {
  tool_name: string;
  invocation_count: number;
  total_duration_ms: number;
  /** true if any call to this tool was blocked by a runtime hook. */
  blocked: boolean;
  blocked_reason?: string;
}

// ---------------------------------------------------------------------------
// Quality dimension score
// ---------------------------------------------------------------------------

/** Score for a single quality dimension within an invocation. */
export interface QualityDimensionScore {
  dimension: string;
  /** 1.0 - 5.0 */
  score: number;
  weight: number;
}

// ---------------------------------------------------------------------------
// InvocationMetric — the primary per-invocation record
// ---------------------------------------------------------------------------

/**
 * Complete per-invocation metric record.
 *
 * This is the primary unit of data written to the JSONL log (primary
 * storage) and replicated into SQLite (secondary / queryable storage).
 */
export interface InvocationMetric {
  /** UUID v4 identifying this invocation. */
  invocation_id: string;
  agent_name: string;
  agent_version: string;
  /** null for standalone (non-pipeline) invocations. */
  pipeline_run_id: string | null;
  /** SHA-256 hex digest of the invocation input. */
  input_hash: string;
  /** Classified domain tag (e.g. "typescript", "python"). */
  input_domain: string;
  input_tokens: number;
  /** SHA-256 hex digest of the invocation output. */
  output_hash: string;
  output_tokens: number;
  /** Overall quality score, 1.0 - 5.0. */
  output_quality_score: number;
  quality_dimensions: QualityDimensionScore[];
  /** 0 = first pass accepted without revision. */
  review_iteration_count: number;
  review_outcome: ReviewOutcome;
  /** null if no review was performed. */
  reviewer_agent: string | null;
  wall_clock_ms: number;
  turn_count: number;
  tool_calls: ToolCallRecord[];
  /** ISO 8601 timestamp. */
  timestamp: string;
  environment: Environment;
}

// ---------------------------------------------------------------------------
// AlertRecord
// ---------------------------------------------------------------------------

/** An alert raised by an anomaly-detection rule. */
export interface AlertRecord {
  /** UUID v4. */
  alert_id: string;
  agent_name: string;
  rule_id: string;
  severity: AlertSeverity;
  message: string;
  evidence: Record<string, unknown>;
  /** ISO 8601 creation timestamp. */
  created_at: string;
  /** ISO 8601 resolution timestamp; null while active. */
  resolved_at: string | null;
  acknowledged: boolean;
}

// ---------------------------------------------------------------------------
// Domain stats (used inside AggregateSnapshot)
// ---------------------------------------------------------------------------

/** Per-domain statistics within an aggregate snapshot. */
export interface DomainStats {
  invocation_count: number;
  approval_rate: number;
  avg_quality_score: number;
}

// ---------------------------------------------------------------------------
// AggregateSnapshot
// ---------------------------------------------------------------------------

/** Point-in-time aggregate metrics for a single agent over a time window. */
export interface AggregateSnapshot {
  /** UUID v4. */
  snapshot_id: string;
  agent_name: string;
  /** ISO 8601 timestamp when this snapshot was computed. */
  computed_at: string;
  /** Sliding window size in days (e.g. 30). */
  window_days: number;
  invocation_count: number;
  approval_rate: number;
  avg_quality_score: number;
  median_quality_score: number;
  stddev_quality_score: number;
  avg_review_iterations: number;
  avg_wall_clock_ms: number;
  avg_turns: number;
  total_tokens: number;
  trend_direction: 'improving' | 'stable' | 'declining';
  trend_slope: number;
  /** R-squared confidence of the trend regression. */
  trend_confidence: number;
  domain_breakdown: Record<string, DomainStats>;
}

// ---------------------------------------------------------------------------
// TrendResult (SPEC-005-2-2)
// ---------------------------------------------------------------------------

/** Result of linear regression trend analysis over recent invocations. */
export interface TrendResult {
  direction: 'improving' | 'stable' | 'declining';
  /** Linear regression slope of quality scores. */
  slope: number;
  /** R-squared confidence (0.0 - 1.0). */
  confidence: number;
  /** Number of data points used in the regression. */
  sample_size: number;
  /** true if sample_size < 5 (insufficient data for reliable trend). */
  low_confidence: boolean;
}

// ---------------------------------------------------------------------------
// AggregateMetrics (SPEC-005-2-2)
// ---------------------------------------------------------------------------

/** Computed aggregate metrics for an agent over a rolling window. */
export interface AggregateMetrics {
  agent_name: string;
  /** Rolling window size in days (e.g. 30). */
  window_days: number;
  invocation_count: number;
  /** approved / total invocations. */
  approval_rate: number;
  avg_quality_score: number;
  median_quality_score: number;
  stddev_quality_score: number;
  avg_review_iterations: number;
  avg_wall_clock_ms: number;
  avg_turns: number;
  total_tokens: number;
  trend: TrendResult;
  domain_breakdown: Record<string, DomainStats>;
}

// ---------------------------------------------------------------------------
// IMetricsEngine (SPEC-005-2-2)
// ---------------------------------------------------------------------------

/** Query options for retrieving invocations. */
export interface QueryOptions {
  since?: string;
  until?: string;
  domain?: string;
  environment?: Environment;
  limit?: number;
}

/** Query options for retrieving alerts. */
export interface AlertQueryOptions {
  agentName?: string;
  severity?: AlertSeverity;
  activeOnly?: boolean;
}

/**
 * The single entry point for all metrics operations.
 *
 * Orchestrates JSONL-primary / SQLite-secondary dual-write, aggregate
 * computation, and anomaly evaluation.
 */
export interface IMetricsEngine {
  record(metric: InvocationMetric): void;
  getInvocations(agentName: string, opts?: QueryOptions): InvocationMetric[];
  getAggregate(agentName: string): AggregateMetrics | null;
  getAlerts(opts?: AlertQueryOptions): AlertRecord[];
  evaluateAnomalies(agentName: string): AlertRecord[];
}
