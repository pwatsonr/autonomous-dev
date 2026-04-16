/**
 * Core type definitions for the error detection and false positive
 * filtering engine.
 *
 * Based on SPEC-007-3-1 (Tasks 1, 2, 3).
 */

// ---------------------------------------------------------------------------
// Error type enum
// ---------------------------------------------------------------------------

/**
 * The six error types detected by the engine.
 *
 * - crash:                Process termination or restart
 * - exception:            Unhandled exceptions in logs
 * - timeout:              p99 latency exceeding SLA threshold
 * - degraded_performance: p95 latency exceeding 2x baseline
 * - data_inconsistency:   HTTP 422/400 rate spike above baseline
 * - error_rate:           Sustained error rate above configured threshold
 */
export type ErrorType =
  | 'crash'
  | 'exception'
  | 'timeout'
  | 'degraded_performance'
  | 'data_inconsistency'
  | 'error_rate';

// ---------------------------------------------------------------------------
// Candidate observation
// ---------------------------------------------------------------------------

/**
 * A candidate observation produced by the detection layer before LLM
 * classification. Each candidate represents a potential issue that passed
 * threshold checks and (optionally) sustained-duration validation.
 */
export interface CandidateObservation {
  /** Observation category. */
  type: 'error' | 'anomaly' | 'trend' | 'adoption';

  /** Specific error type when `type === 'error'`. */
  error_type?: ErrorType;

  /** Service that produced this observation. */
  service: string;

  /** Current metric value that triggered the detection. */
  metric_value: number;

  /** Configured threshold that was exceeded. */
  threshold_value: number;

  /** Number of consecutive minutes the metric exceeded the threshold. */
  sustained_minutes: number;

  /** HTTP endpoint associated with this observation, if applicable. */
  endpoint?: string;

  /** Exception class name (for exception-type detections). */
  error_class?: string;

  /** Sample log lines supporting this observation (max 5). */
  log_samples: string[];

  /** Request metadata (headers, tags) used for load test marker detection. */
  request_metadata?: Record<string, unknown>;

  /** True when data loss indicators are present. */
  has_data_loss_indicator: boolean;

  /** True when data corruption indicators are present (e.g., HTTP 422). */
  has_data_corruption_indicator: boolean;

  /** Data sources consulted to produce this observation. */
  data_sources_used: string[];

  /** Unique identifier for this observation (assigned during dedup). */
  observation_id?: string;

  /** Number of duplicate occurrences merged into this observation. */
  occurrence_count?: number;

  /** Numeric error/status code (e.g., 503). */
  error_code?: number;

  /** Human-readable error message. */
  error_message?: string;

  /** Normalized stack frames extracted from log samples. */
  stack_frames?: string[];

  /** Timestamp when this observation was first detected. */
  timestamp?: Date;
}

// ---------------------------------------------------------------------------
// Filter result
// ---------------------------------------------------------------------------

/**
 * Result from a single false-positive filter check.
 */
export interface FilterResult {
  /** True when the candidate was identified as a false positive. */
  filtered: boolean;

  /** Human-readable reason the candidate was filtered (undefined when not filtered). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Maintenance window configuration
// ---------------------------------------------------------------------------

/**
 * A recurring maintenance window defined by day-of-week + time range.
 */
export interface RecurringMaintenanceWindow {
  /** Start time in HH:MM format. */
  start: string;

  /** End time in HH:MM format. */
  end: string;

  /** Days of the week this window applies (e.g., ["SAT", "SUN"]). */
  days: string[];

  /** IANA timezone (default "UTC"). */
  timezone?: string;
}

/**
 * A one-time maintenance window defined by ISO 8601 start/end.
 */
export interface OneTimeMaintenanceWindow {
  /** ISO 8601 start timestamp. */
  start: string;

  /** ISO 8601 end timestamp. */
  end: string;
}

/** Union type for any maintenance window. */
export type MaintenanceWindow = RecurringMaintenanceWindow | OneTimeMaintenanceWindow;

// ---------------------------------------------------------------------------
// Load test marker configuration
// ---------------------------------------------------------------------------

/**
 * Identifies traffic as load-test by checking request metadata.
 */
export interface LoadTestMarker {
  /** HTTP header name to check. */
  header?: string;

  /** Expected header value. */
  value?: string;

  /** Metadata tag to check. */
  tag?: string;
}

// ---------------------------------------------------------------------------
// False positive filter configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for the false positive filter chain.
 * Parsed from `intelligence.yaml` `false_positive_filters` section.
 */
export interface FalsePositiveFilterConfig {
  /** Maintenance windows (recurring or one-time). */
  maintenance_windows: MaintenanceWindow[];

  /** Regex patterns to exclude from error detection. */
  excluded_error_patterns: string[];

  /** Load test traffic markers. */
  load_test_markers: LoadTestMarker[];
}

// ---------------------------------------------------------------------------
// Baseline types (referenced by degraded performance / data inconsistency)
// ---------------------------------------------------------------------------

/**
 * Statistical baseline for a single metric over multiple time windows.
 */
export interface MetricBaseline {
  mean_7d: number;
  stddev_7d: number;
  mean_14d: number;
  stddev_14d: number;
  mean_30d: number;
  stddev_30d: number;
  p50: number;
  p95: number;
  p99: number;
}

/**
 * Full baseline record for a service, loaded from
 * `.autonomous-dev/baselines/<service>.json`.
 */
export interface BaselineMetrics {
  service: string;
  learning_mode: boolean;
  learning_started: string;
  learning_completed: string | null;
  last_updated: string;
  observation_run_count: number;
  metrics: Record<string, MetricBaseline>;
}

// ---------------------------------------------------------------------------
// Fingerprint and deduplication types (SPEC-007-3-3)
// ---------------------------------------------------------------------------

/**
 * Persisted fingerprint entry stored in
 * `.autonomous-dev/fingerprints/<service>.json`.
 */
export interface FingerprintEntry {
  hash: string;
  service: string;
  error_class: string;
  endpoint: string;
  first_seen: string;       // ISO 8601
  last_seen: string;        // ISO 8601
  occurrence_count: number;
  linked_observation_id: string;
  triage_status: string;
}

/**
 * Shape of the fingerprint store JSON file.
 */
export interface FingerprintStore {
  fingerprints: FingerprintEntry[];
}

/**
 * Result returned by the deduplication engine for a single candidate.
 */
export interface DeduplicationResult {
  action: 'new' | 'merge_intra_run' | 'update_inter_run' | 'auto_dismiss' | 'related_to_promoted';
  existing_observation_id?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Similarity types (SPEC-007-3-3)
// ---------------------------------------------------------------------------

/**
 * Summary of an existing observation used for fuzzy similarity comparisons.
 */
export interface ObservationSummary {
  id: string;
  service: string;
  error_message?: string;
  stack_frames?: string[];
  timestamp: Date;
}

/**
 * Result of fuzzy similarity matching against an existing observation.
 */
export interface SimilarityMatch {
  matched: boolean;
  method: 'jaccard_stack' | 'levenshtein_message' | 'temporal_correlation';
  similarity_score: number;
  existing_observation_id: string;
}
