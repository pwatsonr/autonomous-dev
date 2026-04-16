/**
 * Metrics aggregator (SPEC-005-2-2, Task 5).
 *
 * Computes rolling 30-day window statistics, trend analysis via linear
 * regression, and per-domain breakdown from per-invocation records.
 *
 * Exports:
 *   - `MetricsAggregator` class
 *   - `linearRegression(points: number[]): TrendResult` (pure function)
 */

import type {
  InvocationMetric,
  AggregateMetrics,
  TrendResult,
  DomainStats,
} from './types';

// ---------------------------------------------------------------------------
// Linear regression (exported, pure)
// ---------------------------------------------------------------------------

/**
 * Compute a simple linear regression over a sequence of values.
 *
 * The independent variable is the zero-based index (0, 1, 2, ...).
 * The dependent variable is `points[i]`.
 *
 * Returns a `TrendResult` with slope, R-squared, direction classification,
 * sample size, and a low-confidence flag when fewer than 5 points are given.
 */
export function linearRegression(points: number[]): TrendResult {
  const n = points.length;

  // Fewer than 2 points: regression is undefined
  if (n < 2) {
    return {
      direction: 'stable',
      slope: 0,
      confidence: 0,
      sample_size: n,
      low_confidence: true,
    };
  }

  // Low confidence when fewer than 5 data points
  const lowConfidence = n < 5;

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;

  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += points[i];
    sumXY += i * points[i];
    sumX2 += i * i;
  }

  const denominator = n * sumX2 - sumX * sumX;

  // All x values are the same (impossible for sequential indices unless n=1,
  // already handled above). Guard against numeric edge cases.
  if (denominator === 0) {
    return {
      direction: 'stable',
      slope: 0,
      confidence: 0,
      sample_size: n,
      low_confidence: lowConfidence,
    };
  }

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  // Compute R-squared
  const meanY = sumY / n;
  let ssRes = 0;
  let ssTot = 0;

  for (let i = 0; i < n; i++) {
    const predicted = slope * i + intercept;
    ssRes += (points[i] - predicted) ** 2;
    ssTot += (points[i] - meanY) ** 2;
  }

  // Handle flat line: ssTot = 0 means all y values are identical.
  // R-squared is undefined; treat as perfect fit with stable direction.
  let rSquared: number;
  if (ssTot === 0) {
    rSquared = 0;
  } else {
    rSquared = 1 - ssRes / ssTot;
  }

  // Classify direction
  let direction: TrendResult['direction'];
  if (lowConfidence) {
    direction = 'stable';
  } else if (slope > 0.05 && rSquared > 0.3) {
    direction = 'improving';
  } else if (slope < -0.05 && rSquared > 0.3) {
    direction = 'declining';
  } else {
    direction = 'stable';
  }

  return {
    direction,
    slope,
    confidence: rSquared,
    sample_size: n,
    low_confidence: lowConfidence,
  };
}

// ---------------------------------------------------------------------------
// MetricsAggregator
// ---------------------------------------------------------------------------

/** Default rolling window size in days. */
const DEFAULT_WINDOW_DAYS = 30;

/** Maximum number of invocations used for trend analysis. */
const TREND_SAMPLE_SIZE = 20;

/**
 * Computes aggregate metrics from per-invocation records.
 *
 * This class is stateless -- it operates on arrays of `InvocationMetric`
 * records supplied by the caller (typically the `MetricsEngine`).
 */
export class MetricsAggregator {
  private readonly windowDays: number;

  constructor(windowDays: number = DEFAULT_WINDOW_DAYS) {
    this.windowDays = windowDays;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Compute `AggregateMetrics` for a specific agent from a collection of
   * invocations.
   *
   * @param agentName  The agent whose metrics are being aggregated.
   * @param allInvocations  All available invocations (will be filtered to
   *                        the rolling window internally).
   * @returns  The aggregate metrics, or `null` if no invocations fall
   *           within the window.
   */
  compute(
    agentName: string,
    allInvocations: InvocationMetric[],
  ): AggregateMetrics | null {
    const windowStart = this.getWindowStart();
    const invocations = allInvocations.filter(
      (m) =>
        m.agent_name === agentName && m.timestamp >= windowStart,
    );

    if (invocations.length === 0) {
      return null;
    }

    // Sort by timestamp ascending for trend analysis
    invocations.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    const count = invocations.length;

    // Basic aggregate statistics
    const approvedCount = invocations.filter(
      (m) => m.review_outcome === 'approved',
    ).length;
    const approvalRate = approvedCount / count;

    const qualityScores = invocations.map((m) => m.output_quality_score);
    const avgQualityScore = mean(qualityScores);
    const medianQualityScore = median(qualityScores);
    const stddevQualityScore = stddev(qualityScores);

    const avgReviewIterations = mean(
      invocations.map((m) => m.review_iteration_count),
    );
    const avgWallClockMs = mean(invocations.map((m) => m.wall_clock_ms));
    const avgTurns = mean(invocations.map((m) => m.turn_count));
    const totalTokens = invocations.reduce(
      (sum, m) => sum + m.input_tokens + m.output_tokens,
      0,
    );

    // Trend analysis (last 20 invocations)
    const trendInvocations = invocations.slice(-TREND_SAMPLE_SIZE);
    const trendScores = trendInvocations.map((m) => m.output_quality_score);
    const trend = linearRegression(trendScores);

    // Domain breakdown
    const domainBreakdown = this.computeDomainBreakdown(invocations);

    return {
      agent_name: agentName,
      window_days: this.windowDays,
      invocation_count: count,
      approval_rate: approvalRate,
      avg_quality_score: avgQualityScore,
      median_quality_score: medianQualityScore,
      stddev_quality_score: stddevQualityScore,
      avg_review_iterations: avgReviewIterations,
      avg_wall_clock_ms: avgWallClockMs,
      avg_turns: avgTurns,
      total_tokens: totalTokens,
      trend,
      domain_breakdown: domainBreakdown,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Compute the ISO 8601 timestamp for the start of the rolling window
   * (windowDays ago from now).
   */
  private getWindowStart(): string {
    const now = new Date();
    now.setDate(now.getDate() - this.windowDays);
    return now.toISOString();
  }

  /**
   * Group invocations by `input_domain` and compute per-domain stats.
   */
  private computeDomainBreakdown(
    invocations: InvocationMetric[],
  ): Record<string, DomainStats> {
    const groups = new Map<string, InvocationMetric[]>();

    for (const m of invocations) {
      const existing = groups.get(m.input_domain);
      if (existing) {
        existing.push(m);
      } else {
        groups.set(m.input_domain, [m]);
      }
    }

    const breakdown: Record<string, DomainStats> = {};

    for (const [domain, metrics] of groups) {
      const count = metrics.length;
      const approved = metrics.filter(
        (m) => m.review_outcome === 'approved',
      ).length;

      breakdown[domain] = {
        invocation_count: count,
        approval_rate: approved / count,
        avg_quality_score: mean(metrics.map((m) => m.output_quality_score)),
      };
    }

    return breakdown;
  }
}

// ---------------------------------------------------------------------------
// Statistical helper functions (module-private)
// ---------------------------------------------------------------------------

/** Arithmetic mean of an array of numbers. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Median of an array of numbers. */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/** Population standard deviation of an array of numbers. */
function stddev(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => (v - avg) ** 2);
  return Math.sqrt(mean(squaredDiffs));
}
