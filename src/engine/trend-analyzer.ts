/**
 * Linear regression trend analysis over configurable time windows
 * (SPEC-007-3-4, Task 11).
 *
 * Computes slope over hourly data points for 7d/14d/30d windows,
 * normalizes as percentage change relative to baseline mean, and
 * extrapolates days-to-threshold-breach.
 */

import type { MetricBaseline } from './types';
import { isBadDirection } from './anomaly-detector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single time-series data point used for regression.
 */
export interface DataPoint {
  /** X-axis value (typically hour index). */
  x: number;
  /** Y-axis value (metric value). */
  y: number;
}

/**
 * Result of a trend analysis for one metric over one time window.
 */
export interface TrendResult {
  /** Whether a degrading trend was detected. */
  detected: boolean;
  /** Metric name. */
  metric: string;
  /** Time window analyzed. */
  window: string;
  /** Raw slope per hour from linear regression. */
  slope: number;
  /** Percentage change per window relative to baseline mean. */
  pct_change: number;
  /** Trend direction classification. */
  direction: 'degrading' | 'improving' | 'stable';
  /** Extrapolated days until threshold breach (undefined if not applicable). */
  days_to_breach?: number;
}

/**
 * Configuration for trend analysis.
 */
export interface TrendAnalysisConfig {
  /** Time windows to analyze (e.g., ["7d", "14d", "30d"]). */
  windows: string[];
  /** Minimum absolute percentage change to consider a trend significant. Default 5%. */
  min_slope_threshold: number;
}

/**
 * Metric threshold configuration for breach extrapolation.
 */
export interface MetricThresholds {
  error_rate_percent?: number;
  p99_latency_ms?: number;
  availability_percent?: number;
  [key: string]: number | undefined;
}

// ---------------------------------------------------------------------------
// Window parsing
// ---------------------------------------------------------------------------

/**
 * Parses a window string (e.g., "7d", "14d", "30d") into hours.
 *
 * @param window  Window string in the format "<n>d"
 * @returns       Number of hours
 * @throws {Error} If the window format is invalid
 */
export function parseWindowToHours(window: string): number {
  const match = window.match(/^(\d+)d$/);
  if (match) return parseInt(match[1], 10) * 24;
  throw new Error(`Invalid window format: ${window}`);
}

// ---------------------------------------------------------------------------
// Linear regression
// ---------------------------------------------------------------------------

/**
 * Computes the slope of the best-fit line through the given data points
 * using ordinary least squares linear regression.
 *
 * Formula: slope = (n * sum(xy) - sum(x) * sum(y)) / (n * sum(x^2) - sum(x)^2)
 *
 * Returns 0 for fewer than 2 data points or zero denominator.
 *
 * @param dataPoints  Array of (x, y) pairs
 * @returns           Slope of the regression line
 */
export function linearRegressionSlope(dataPoints: DataPoint[]): number {
  const n = dataPoints.length;
  if (n < 2) return 0;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (const { x, y } of dataPoints) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

// ---------------------------------------------------------------------------
// Threshold mapping
// ---------------------------------------------------------------------------

/**
 * Maps a metric name to the appropriate threshold value for breach
 * extrapolation.
 *
 * @param metric      Metric name
 * @param thresholds  Configured thresholds
 * @returns           Threshold value or null if not mapped
 */
export function getThresholdForMetric(
  metric: string,
  thresholds: MetricThresholds,
): number | null {
  const mapping: Record<string, string> = {
    error_rate: 'error_rate_percent',
    latency_p99_ms: 'p99_latency_ms',
    availability: 'availability_percent',
  };

  const key = mapping[metric];
  if (key && thresholds[key] !== undefined) {
    return thresholds[key]!;
  }

  // Check direct match
  if (thresholds[metric] !== undefined) {
    return thresholds[metric]!;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Single metric trend analysis
// ---------------------------------------------------------------------------

/**
 * Analyzes the trend for a single metric over a given window.
 *
 * Steps:
 *   1. Compute linear regression slope from hourly data points
 *   2. Normalize slope as percentage change per window relative to baseline mean
 *   3. Classify direction as degrading, improving, or stable
 *   4. If degrading, extrapolate days to threshold breach
 *
 * @param metric      Metric name
 * @param window      Time window (e.g., "7d")
 * @param dataPoints  Hourly data points from Prometheus (x=hour index, y=value)
 * @param baseline    Baseline statistics for comparison
 * @param config      Trend analysis configuration
 * @param thresholds  Metric thresholds for breach extrapolation
 * @returns           Trend analysis result
 */
export function analyzeTrend(
  metric: string,
  window: string,
  dataPoints: DataPoint[],
  baseline: MetricBaseline,
  config: TrendAnalysisConfig,
  thresholds: MetricThresholds = {},
): TrendResult {
  const windowHours = parseWindowToHours(window);
  const slope = linearRegressionSlope(dataPoints);

  // Normalize slope as percentage change per window relative to baseline mean
  const baselineMean = baseline.mean_7d;
  if (baselineMean === 0) {
    return {
      detected: false,
      metric,
      window,
      slope,
      pct_change: 0,
      direction: 'stable',
    };
  }

  const pctChange = ((slope * windowHours) / baselineMean) * 100;

  // Determine if this direction is degrading
  const slopeDirection: 'above' | 'below' = pctChange > 0 ? 'above' : 'below';
  const isDegrading =
    isBadDirection(metric, slopeDirection) &&
    Math.abs(pctChange) > config.min_slope_threshold;

  // Classify direction
  let direction: 'degrading' | 'improving' | 'stable';
  if (isDegrading) {
    direction = 'degrading';
  } else if (Math.abs(pctChange) > config.min_slope_threshold) {
    direction = 'improving';
  } else {
    direction = 'stable';
  }

  // Extrapolate days to breach
  let daysToBreachEstimate: number | undefined;
  if (isDegrading && slope !== 0) {
    const threshold = getThresholdForMetric(metric, thresholds);
    if (threshold !== null) {
      const currentValue =
        dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].y : baselineMean;
      const hoursToBreach = (threshold - currentValue) / slope;
      daysToBreachEstimate =
        hoursToBreach > 0 ? Math.round(hoursToBreach / 24) : undefined;
    }
  }

  return {
    detected: isDegrading,
    metric,
    window,
    slope,
    pct_change: pctChange,
    direction,
    days_to_breach: daysToBreachEstimate,
  };
}

// ---------------------------------------------------------------------------
// Multi-window trend analysis
// ---------------------------------------------------------------------------

/**
 * Runs trend analysis for a single metric across all configured windows.
 *
 * @param metric          Metric name
 * @param windowDataMap   Map of window string to hourly data points
 * @param baseline        Baseline statistics
 * @param config          Trend analysis configuration
 * @param thresholds      Metric thresholds for breach extrapolation
 * @param isLearningMode  Whether the service is in learning mode
 * @returns               Array of trend results (only degrading trends if not learning)
 */
export function analyzeMetricTrends(
  metric: string,
  windowDataMap: Record<string, DataPoint[]>,
  baseline: MetricBaseline,
  config: TrendAnalysisConfig,
  thresholds: MetricThresholds = {},
  isLearningMode: boolean = false,
): TrendResult[] {
  const results: TrendResult[] = [];

  for (const window of config.windows) {
    const dataPoints = windowDataMap[window];
    if (!dataPoints || dataPoints.length === 0) continue;

    const result = analyzeTrend(
      metric,
      window,
      dataPoints,
      baseline,
      config,
      thresholds,
    );

    // During learning mode, trend observations are NOT generated
    if (isLearningMode) continue;

    // Only report detected (degrading) trends
    if (result.detected) {
      results.push(result);
    }
  }

  return results;
}

/**
 * Runs trend analysis for all metrics across all configured windows.
 *
 * @param metricsData     Map of metric -> window -> data points
 * @param baselines       Map of metric -> baseline
 * @param config          Trend analysis configuration
 * @param thresholds      Metric thresholds for breach extrapolation
 * @param isLearningMode  Whether the service is in learning mode
 * @returns               Array of all degrading trend results
 */
export function analyzeAllTrends(
  metricsData: Record<string, Record<string, DataPoint[]>>,
  baselines: Record<string, MetricBaseline>,
  config: TrendAnalysisConfig,
  thresholds: MetricThresholds = {},
  isLearningMode: boolean = false,
): TrendResult[] {
  const allResults: TrendResult[] = [];

  for (const [metric, windowDataMap] of Object.entries(metricsData)) {
    const baseline = baselines[metric];
    if (!baseline) continue;

    const results = analyzeMetricTrends(
      metric,
      windowDataMap,
      baseline,
      config,
      thresholds,
      isLearningMode,
    );

    allResults.push(...results);
  }

  return allResults;
}
