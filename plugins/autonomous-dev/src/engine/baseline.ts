/**
 * Baseline storage, EWMA update algorithm, and learning mode lifecycle
 * (SPEC-007-3-4, Task 9).
 *
 * Manages per-service baseline files at `.autonomous-dev/baselines/<service>.json`.
 * Uses EWMA (alpha = 0.1) for 7-day rolling statistics and delegates 14d/30d
 * windows to Prometheus range queries.
 */

import type { BaselineMetrics, MetricBaseline } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** EWMA smoothing factor. */
export const EWMA_ALPHA = 0.1;

/** Minimum days in learning mode before baselines are considered stable. */
export const LEARNING_MIN_DAYS = 7;

/** Minimum observation runs required during learning mode. */
export const LEARNING_MIN_RUNS = 6;

/** Standard baseline metrics tracked by the engine. */
export const BASELINE_METRICS = [
  'error_rate',
  'latency_p50_ms',
  'latency_p95_ms',
  'latency_p99_ms',
  'throughput_rps',
  'availability',
] as const;

export type BaselineMetricName = (typeof BASELINE_METRICS)[number];

// ---------------------------------------------------------------------------
// Baseline factory
// ---------------------------------------------------------------------------

/**
 * Creates a new baseline record for a service entering learning mode.
 *
 * @param service  Service name
 * @param now      Optional timestamp for testing; defaults to current time
 */
export function createBaseline(service: string, now: Date = new Date()): BaselineMetrics {
  return {
    service,
    learning_mode: true,
    learning_started: now.toISOString(),
    learning_completed: null,
    last_updated: now.toISOString(),
    observation_run_count: 0,
    metrics: {},
  };
}

// ---------------------------------------------------------------------------
// EWMA update
// ---------------------------------------------------------------------------

/**
 * Initializes a MetricBaseline from a first observation value.
 * All window means are set to the observed value and standard deviations
 * to zero (no variance available from a single data point).
 */
export function initializeMetricBaseline(value: number): MetricBaseline {
  return {
    mean_7d: value,
    stddev_7d: 0,
    mean_14d: value,
    stddev_14d: 0,
    mean_30d: value,
    stddev_30d: 0,
    p50: value,
    p95: value,
    p99: value,
  };
}

/**
 * Updates a single metric baseline using EWMA (alpha = 0.1).
 *
 * Only the 7-day rolling mean and standard deviation are updated here.
 * The 14d/30d windows are updated by separate Prometheus queries
 * (avg_over_time / stddev_over_time).
 *
 * Formula:
 *   mean  = (1 - alpha) * mean  + alpha * new_value
 *   stddev = sqrt((1 - alpha) * stddev^2 + alpha * (new_value - mean)^2)
 *
 * Note: the mean is updated first, then the stddev uses the updated mean.
 *
 * @param existing   Current metric baseline
 * @param newValue   Newly observed metric value
 * @returns          Updated metric baseline (mutates and returns input)
 */
export function updateMetricBaseline(
  existing: MetricBaseline,
  newValue: number,
): MetricBaseline {
  // EWMA mean update
  existing.mean_7d = (1 - EWMA_ALPHA) * existing.mean_7d + EWMA_ALPHA * newValue;

  // EWMA variance-tracking stddev update
  existing.stddev_7d = Math.sqrt(
    (1 - EWMA_ALPHA) * existing.stddev_7d ** 2 +
      EWMA_ALPHA * (newValue - existing.mean_7d) ** 2,
  );

  return existing;
}

/**
 * Updates a full baseline record with current metric values.
 *
 * For each known metric in `currentValues`:
 *   - If no prior baseline exists, initializes from the first observation.
 *   - Otherwise applies EWMA update to the 7-day window.
 *
 * Increments `observation_run_count` and updates `last_updated`.
 *
 * @param baseline       The baseline record to update (mutated in place)
 * @param currentValues  Map of metric name to current observed value
 * @param now            Optional timestamp for testing
 */
export function updateBaseline(
  baseline: BaselineMetrics,
  currentValues: Record<string, number>,
  now: Date = new Date(),
): void {
  for (const metric of BASELINE_METRICS) {
    const newValue = currentValues[metric];
    if (newValue === undefined || newValue === null) continue;

    const existing = baseline.metrics[metric];
    if (!existing) {
      // First observation: initialize directly
      baseline.metrics[metric] = initializeMetricBaseline(newValue);
      continue;
    }

    updateMetricBaseline(existing, newValue);
  }

  baseline.last_updated = now.toISOString();
  baseline.observation_run_count++;
}

// ---------------------------------------------------------------------------
// Extended window update (14d / 30d from Prometheus)
// ---------------------------------------------------------------------------

/**
 * Updates the 14d and 30d baseline windows from Prometheus
 * `avg_over_time` / `stddev_over_time` query results.
 *
 * @param baseline   The baseline record to update (mutated in place)
 * @param metric     Metric name
 * @param window     "14d" or "30d"
 * @param mean       Mean from Prometheus range query
 * @param stddev     Stddev from Prometheus range query
 */
export function updateExtendedWindow(
  baseline: BaselineMetrics,
  metric: string,
  window: '14d' | '30d',
  mean: number,
  stddev: number,
): void {
  const existing = baseline.metrics[metric];
  if (!existing) return;

  if (window === '14d') {
    existing.mean_14d = mean;
    existing.stddev_14d = stddev;
  } else {
    existing.mean_30d = mean;
    existing.stddev_30d = stddev;
  }
}

/**
 * Updates percentile values on a metric baseline.
 *
 * @param baseline  The baseline record to update
 * @param metric    Metric name
 * @param p50       50th percentile value
 * @param p95       95th percentile value
 * @param p99       99th percentile value
 */
export function updatePercentiles(
  baseline: BaselineMetrics,
  metric: string,
  p50: number,
  p95: number,
  p99: number,
): void {
  const existing = baseline.metrics[metric];
  if (!existing) return;

  existing.p50 = p50;
  existing.p95 = p95;
  existing.p99 = p99;
}

// ---------------------------------------------------------------------------
// Learning mode lifecycle
// ---------------------------------------------------------------------------

/**
 * Checks whether a baseline is still in learning mode and transitions
 * it out when both exit conditions are met:
 *
 *   1. At least 7 days since `learning_started`
 *   2. At least 6 observation runs completed
 *
 * @param baseline  The baseline record to evaluate (mutated if transitioning)
 * @param now       Optional timestamp for testing
 * @returns         `true` if the service is STILL in learning mode,
 *                  `false` if learning mode just ended or was already off
 */
export function checkLearningMode(
  baseline: BaselineMetrics,
  now: Date = new Date(),
): boolean {
  if (!baseline.learning_mode) return false;

  const learningStart = new Date(baseline.learning_started);
  const daysSinceLearningStart =
    (now.getTime() - learningStart.getTime()) / (24 * 60 * 60 * 1000);

  // Exit learning mode when BOTH conditions are met
  if (daysSinceLearningStart >= LEARNING_MIN_DAYS && baseline.observation_run_count >= LEARNING_MIN_RUNS) {
    baseline.learning_mode = false;
    baseline.learning_completed = now.toISOString();
    return false; // No longer in learning mode
  }

  return true; // Still in learning mode
}

// ---------------------------------------------------------------------------
// Serialization helpers
// ---------------------------------------------------------------------------

/**
 * Serializes a baseline record to JSON for file storage.
 */
export function serializeBaseline(baseline: BaselineMetrics): string {
  return JSON.stringify(baseline, null, 2);
}

/**
 * Deserializes a baseline record from JSON.
 *
 * @throws {Error} If the JSON is malformed or missing required fields
 */
export function deserializeBaseline(json: string): BaselineMetrics {
  const parsed = JSON.parse(json);

  // Validate required fields
  const required = [
    'service',
    'learning_mode',
    'learning_started',
    'last_updated',
    'observation_run_count',
    'metrics',
  ] as const;

  for (const field of required) {
    if (!(field in parsed)) {
      throw new Error(`Invalid baseline: missing required field '${field}'`);
    }
  }

  return parsed as BaselineMetrics;
}
