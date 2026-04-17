/**
 * Z-score and IQR anomaly detection (SPEC-007-3-4, Task 10).
 *
 * Two configurable anomaly detection methods that compare current metric
 * values against stored baselines. Anomalies are only surfaced when:
 *   1. The service is NOT in learning mode
 *   2. The anomaly persists across 2 consecutive observation runs
 *   3. The deviation is in a "bad" direction for the metric
 */

import type { MetricBaseline } from './types';

// ---------------------------------------------------------------------------
// Anomaly result type
// ---------------------------------------------------------------------------

/**
 * Result of an anomaly detection check on a single metric.
 */
export interface AnomalyResult {
  /** Whether an anomaly was detected. */
  detected: boolean;
  /** Detection method used. */
  method: 'zscore' | 'iqr';
  /** Metric name that was evaluated. */
  metric: string;
  /** Current observed value. */
  current_value: number;
  /** Baseline mean (7-day) used for comparison. */
  baseline_mean: number;
  /** Baseline standard deviation (7-day) used for comparison. */
  baseline_stddev: number;
  /** Z-score (only present for zscore method). */
  z_score?: number;
  /** Direction of deviation from baseline. */
  direction: 'above' | 'below';
  /** True if this direction represents degradation for this metric. */
  is_bad_direction: boolean;
  /** Number of consecutive runs with anomaly. Must be >= 2 to generate observation. */
  consecutive_runs: number;
}

// ---------------------------------------------------------------------------
// Bad direction mapping
// ---------------------------------------------------------------------------

/** Metrics where an increase indicates degradation. */
const BAD_IF_ABOVE = [
  'error_rate',
  'latency_p50_ms',
  'latency_p95_ms',
  'latency_p99_ms',
];

/** Metrics where a decrease indicates degradation. */
const BAD_IF_BELOW = ['throughput_rps', 'availability'];

/**
 * Determines whether a deviation direction is "bad" (degrading) for
 * the given metric.
 *
 * - Increased error rate / latency = bad
 * - Decreased throughput / availability = bad
 *
 * @param metric     Metric name
 * @param direction  Direction of deviation
 * @returns          True if this direction represents degradation
 */
export function isBadDirection(
  metric: string,
  direction: 'above' | 'below',
): boolean {
  if (BAD_IF_ABOVE.includes(metric)) return direction === 'above';
  if (BAD_IF_BELOW.includes(metric)) return direction === 'below';
  return false;
}

// ---------------------------------------------------------------------------
// Z-score anomaly detection
// ---------------------------------------------------------------------------

/**
 * Detects anomalies using the z-score method.
 *
 * The z-score measures how many standard deviations the current value
 * is from the baseline mean. An anomaly is flagged when:
 *   |z| > sensitivity AND direction is "bad" for this metric
 *
 * Handles zero stddev gracefully by returning `detected: false`.
 *
 * @param metric              Metric name
 * @param currentValue        Current observed value
 * @param baseline            Baseline statistics (7d window)
 * @param sensitivity         Z-score threshold (default 2.5)
 * @param previousRunAnomaly  Whether an anomaly was detected in the previous run
 * @returns                   Anomaly detection result
 */
export function detectAnomalyZScore(
  metric: string,
  currentValue: number,
  baseline: MetricBaseline,
  sensitivity: number = 2.5,
  previousRunAnomaly: boolean = false,
): AnomalyResult {
  // Guard: zero stddev means we cannot compute a z-score
  if (baseline.stddev_7d === 0) {
    return {
      detected: false,
      method: 'zscore',
      metric,
      current_value: currentValue,
      baseline_mean: baseline.mean_7d,
      baseline_stddev: baseline.stddev_7d,
      z_score: 0,
      direction: currentValue >= baseline.mean_7d ? 'above' : 'below',
      is_bad_direction: false,
      consecutive_runs: 0,
    };
  }

  const z = (currentValue - baseline.mean_7d) / baseline.stddev_7d;
  const direction: 'above' | 'below' = z > 0 ? 'above' : 'below';
  const isBad = isBadDirection(metric, direction);

  const detected = Math.abs(z) > sensitivity && isBad;

  return {
    detected,
    method: 'zscore',
    metric,
    current_value: currentValue,
    baseline_mean: baseline.mean_7d,
    baseline_stddev: baseline.stddev_7d,
    z_score: z,
    direction,
    is_bad_direction: isBad,
    consecutive_runs: detected && previousRunAnomaly ? 2 : detected ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// IQR anomaly detection
// ---------------------------------------------------------------------------

/**
 * Detects anomalies using the Interquartile Range (IQR) method.
 *
 * Approximates Q1 and Q3 from the baseline median (p50) and standard
 * deviation, then flags values outside the 1.5 * IQR fences:
 *   - Lower fence: Q1 - 1.5 * IQR
 *   - Upper fence: Q3 + 1.5 * IQR
 *
 * An anomaly is flagged when the value is outside the fences AND the
 * direction is "bad" for this metric.
 *
 * @param metric              Metric name
 * @param currentValue        Current observed value
 * @param baseline            Baseline statistics (7d window)
 * @param previousRunAnomaly  Whether an anomaly was detected in the previous run
 * @returns                   Anomaly detection result
 */
export function detectAnomalyIQR(
  metric: string,
  currentValue: number,
  baseline: MetricBaseline,
  previousRunAnomaly: boolean = false,
): AnomalyResult {
  // Approximate Q1 and Q3 from median and stddev
  // For a normal distribution, Q1 ~ median - 0.675 * sigma
  //                           Q3 ~ median + 0.675 * sigma
  const q1 = baseline.p50 - 0.675 * baseline.stddev_7d;
  const q3 = baseline.p50 + 0.675 * baseline.stddev_7d;
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  const isOutside = currentValue < lowerBound || currentValue > upperBound;
  const direction: 'above' | 'below' =
    currentValue > upperBound ? 'above' : 'below';
  const isBad = isBadDirection(metric, direction);

  const detected = isOutside && isBad;

  return {
    detected,
    method: 'iqr',
    metric,
    current_value: currentValue,
    baseline_mean: baseline.mean_7d,
    baseline_stddev: baseline.stddev_7d,
    direction,
    is_bad_direction: isBad,
    consecutive_runs: detected && previousRunAnomaly ? 2 : detected ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Multi-metric anomaly scan
// ---------------------------------------------------------------------------

/**
 * Configuration for the anomaly detection scan.
 */
export interface AnomalyDetectorConfig {
  /** Detection method: 'zscore' or 'iqr'. */
  method: 'zscore' | 'iqr';
  /** Z-score sensitivity threshold (only used with zscore method). */
  sensitivity: number;
  /** Minimum consecutive runs required to generate an observation. */
  consecutive_runs_required: number;
}

/**
 * State tracking for consecutive anomaly runs per metric.
 */
export type AnomalyRunState = Record<string, boolean>;

/**
 * Runs anomaly detection across all metrics for a service.
 *
 * @param currentValues       Current metric values
 * @param baselines           Baseline metrics for the service
 * @param config              Anomaly detection configuration
 * @param previousRunState    Map of metric -> whether anomaly was detected in previous run
 * @param isLearningMode      Whether the service is in learning mode
 * @returns                   Array of anomaly results and updated run state
 */
export function detectAnomalies(
  currentValues: Record<string, number>,
  baselines: Record<string, MetricBaseline>,
  config: AnomalyDetectorConfig,
  previousRunState: AnomalyRunState = {},
  isLearningMode: boolean = false,
): { results: AnomalyResult[]; runState: AnomalyRunState } {
  const results: AnomalyResult[] = [];
  const runState: AnomalyRunState = {};

  for (const [metric, value] of Object.entries(currentValues)) {
    const baseline = baselines[metric];
    if (!baseline) continue;

    const previousRunAnomaly = previousRunState[metric] ?? false;

    let result: AnomalyResult;
    if (config.method === 'zscore') {
      result = detectAnomalyZScore(
        metric,
        value,
        baseline,
        config.sensitivity,
        previousRunAnomaly,
      );
    } else {
      result = detectAnomalyIQR(metric, value, baseline, previousRunAnomaly);
    }

    // Track run state regardless of learning mode
    runState[metric] = result.detected;

    // During learning mode, do not generate anomaly observations
    if (isLearningMode) continue;

    // Only include results that meet the consecutive run requirement
    if (result.detected && result.consecutive_runs >= config.consecutive_runs_required) {
      results.push(result);
    }
  }

  return { results, runState };
}
