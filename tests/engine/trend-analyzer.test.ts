/**
 * Unit tests for trend analysis (SPEC-007-3-4, Task 11).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-4-15 through TC-3-4-19.
 */

import {
  linearRegressionSlope,
  parseWindowToHours,
  analyzeTrend,
  analyzeMetricTrends,
  analyzeAllTrends,
  getThresholdForMetric,
} from '../../src/engine/trend-analyzer';
import type {
  DataPoint,
  TrendResult,
  TrendAnalysisConfig,
  MetricThresholds,
} from '../../src/engine/trend-analyzer';
import type { MetricBaseline } from '../../src/engine/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMetricBaseline(
  overrides: Partial<MetricBaseline> = {},
): MetricBaseline {
  return {
    mean_7d: 0,
    stddev_7d: 0,
    mean_14d: 0,
    stddev_14d: 0,
    mean_30d: 0,
    stddev_30d: 0,
    p50: 0,
    p95: 0,
    p99: 0,
    ...overrides,
  };
}

function buildTrendConfig(
  overrides: Partial<TrendAnalysisConfig> = {},
): TrendAnalysisConfig {
  return {
    windows: ['7d'],
    min_slope_threshold: 5,
    ...overrides,
  };
}

/**
 * Generates data points with a linear trend.
 * y = startValue + slope * x, for x in [0, count).
 */
function generateLinearData(
  count: number,
  startValue: number,
  slope: number,
): DataPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    x: i,
    y: startValue + slope * i,
  }));
}

// ---------------------------------------------------------------------------
// parseWindowToHours
// ---------------------------------------------------------------------------

describe('parseWindowToHours', () => {
  it('parses "7d" to 168 hours', () => {
    expect(parseWindowToHours('7d')).toBe(168);
  });

  it('parses "14d" to 336 hours', () => {
    expect(parseWindowToHours('14d')).toBe(336);
  });

  it('parses "30d" to 720 hours', () => {
    expect(parseWindowToHours('30d')).toBe(720);
  });

  it('parses "1d" to 24 hours', () => {
    expect(parseWindowToHours('1d')).toBe(24);
  });

  it('throws on invalid format', () => {
    expect(() => parseWindowToHours('7h')).toThrow('Invalid window format');
    expect(() => parseWindowToHours('abc')).toThrow('Invalid window format');
    expect(() => parseWindowToHours('')).toThrow('Invalid window format');
  });
});

// ---------------------------------------------------------------------------
// linearRegressionSlope
// ---------------------------------------------------------------------------

describe('linearRegressionSlope', () => {
  it('TC-3-4-19: computes slope = 1.0 for [(0,1),(1,2),(2,3)]', () => {
    const points: DataPoint[] = [
      { x: 0, y: 1 },
      { x: 1, y: 2 },
      { x: 2, y: 3 },
    ];
    expect(linearRegressionSlope(points)).toBeCloseTo(1.0, 10);
  });

  it('returns 0 for fewer than 2 data points', () => {
    expect(linearRegressionSlope([])).toBe(0);
    expect(linearRegressionSlope([{ x: 0, y: 5 }])).toBe(0);
  });

  it('returns 0 when all x values are the same (zero denominator)', () => {
    const points: DataPoint[] = [
      { x: 5, y: 1 },
      { x: 5, y: 2 },
      { x: 5, y: 3 },
    ];
    expect(linearRegressionSlope(points)).toBe(0);
  });

  it('computes negative slope for decreasing data', () => {
    const points: DataPoint[] = [
      { x: 0, y: 10 },
      { x: 1, y: 8 },
      { x: 2, y: 6 },
    ];
    expect(linearRegressionSlope(points)).toBeCloseTo(-2.0, 10);
  });

  it('computes slope 0 for constant data', () => {
    const points: DataPoint[] = [
      { x: 0, y: 5 },
      { x: 1, y: 5 },
      { x: 2, y: 5 },
    ];
    expect(linearRegressionSlope(points)).toBeCloseTo(0, 10);
  });

  it('handles noisy data (best-fit line)', () => {
    // Roughly increasing: y ~ 2*x + noise
    const points: DataPoint[] = [
      { x: 0, y: 1 },
      { x: 1, y: 3 },
      { x: 2, y: 4 },
      { x: 3, y: 7 },
      { x: 4, y: 9 },
    ];
    const slope = linearRegressionSlope(points);
    expect(slope).toBeGreaterThan(1.5);
    expect(slope).toBeLessThan(2.5);
  });
});

// ---------------------------------------------------------------------------
// getThresholdForMetric
// ---------------------------------------------------------------------------

describe('getThresholdForMetric', () => {
  const thresholds: MetricThresholds = {
    error_rate_percent: 5.0,
    p99_latency_ms: 5000,
    availability_percent: 99.9,
  };

  it('maps error_rate to error_rate_percent', () => {
    expect(getThresholdForMetric('error_rate', thresholds)).toBe(5.0);
  });

  it('maps latency_p99_ms to p99_latency_ms', () => {
    expect(getThresholdForMetric('latency_p99_ms', thresholds)).toBe(5000);
  });

  it('maps availability to availability_percent', () => {
    expect(getThresholdForMetric('availability', thresholds)).toBe(99.9);
  });

  it('returns null for unmapped metric', () => {
    expect(getThresholdForMetric('throughput_rps', thresholds)).toBeNull();
  });

  it('supports direct key match', () => {
    const custom: MetricThresholds = { custom_metric: 42 };
    expect(getThresholdForMetric('custom_metric', custom)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// analyzeTrend
// ---------------------------------------------------------------------------

describe('analyzeTrend', () => {
  it('TC-3-4-15: detects degrading trend when error rate rising 8%', () => {
    // Baseline mean = 5.0
    // Slope such that pct_change over 7d = 8%
    // pct_change = (slope * 168) / 5.0 * 100 = 8
    // slope = (8 * 5.0) / (168 * 100) = 0.002381
    const slope = (8 * 5.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 5.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(true);
    expect(result.direction).toBe('degrading');
    expect(Math.abs(result.pct_change)).toBeGreaterThan(5);
  });

  it('TC-3-4-16: does not detect trend when below threshold (3% < 5%)', () => {
    // pct_change = 3%, threshold = 5%
    const slope = (3 * 5.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 5.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(false);
    expect(result.direction).toBe('stable');
  });

  it('TC-3-4-17: does not detect degradation when latency is improving (decreasing)', () => {
    // Latency decreasing by 10% over 7d = improving, not degrading
    const slope = -(10 * 200.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 200.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 200.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('latency_p50_ms', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(false);
    expect(result.direction).toBe('improving');
  });

  it('TC-3-4-18: computes days to breach correctly', () => {
    // Slope = +0.1%/hr of absolute value, current = 3%, threshold = 5%
    // hoursToBreach = (5 - 3) / 0.1 = 20 hours
    // daysToBreach = round(20 / 24) = 1 day
    const slopePerHour = 0.1;
    const dataPoints = generateLinearData(168, 3.0, slopePerHour);
    // last data point value = 3.0 + 0.1 * 167 = 19.7 (too high, adjust)

    // Better: use a shorter window with smaller slope to match the spec
    // Slope = 0.1 per hour, current = 3.0 (last data point)
    // Need current to be 3.0, so generate data ending at 3.0
    // Use just 2 points for simplicity
    const simpleData: DataPoint[] = [
      { x: 0, y: 2.9 },
      { x: 1, y: 3.0 },
    ];
    // slope = (3.0 - 2.9) / (1 - 0) = 0.1 per hour
    const baseline = buildMetricBaseline({ mean_7d: 3.0 });
    const config = buildTrendConfig({ min_slope_threshold: 0.1 });
    const thresholds: MetricThresholds = { error_rate_percent: 5.0 };

    const result = analyzeTrend(
      'error_rate',
      '7d',
      simpleData,
      baseline,
      config,
      thresholds,
    );

    expect(result.detected).toBe(true);
    // hoursToBreach = (5 - 3) / 0.1 = 20 hours
    // daysToBreach = round(20 / 24) = 1
    expect(result.days_to_breach).toBe(1);
  });

  it('returns stable when baseline mean is 0', () => {
    const dataPoints = generateLinearData(10, 0, 1);
    const baseline = buildMetricBaseline({ mean_7d: 0 });
    const config = buildTrendConfig();

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(false);
    expect(result.direction).toBe('stable');
    expect(result.pct_change).toBe(0);
  });

  it('does not compute days_to_breach when no threshold configured', () => {
    const slope = (10 * 5.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 5.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config, {});

    expect(result.detected).toBe(true);
    expect(result.days_to_breach).toBeUndefined();
  });

  it('does not compute days_to_breach when slope would never reach threshold', () => {
    // Negative slope on error_rate with high threshold -> hoursToBreach would be negative
    // Actually this case would be "improving" not "degrading" so detected=false
    const slope = -(10 * 5.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 5.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(false);
    expect(result.days_to_breach).toBeUndefined();
  });

  it('detects throughput degradation (decreasing = bad)', () => {
    // throughput_rps: decreasing = bad direction
    const slope = -(10 * 1000.0) / (168 * 100); // -10% per window
    const dataPoints = generateLinearData(168, 1000, slope);
    const baseline = buildMetricBaseline({ mean_7d: 1000 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('throughput_rps', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(true);
    expect(result.direction).toBe('degrading');
  });
});

// ---------------------------------------------------------------------------
// analyzeMetricTrends
// ---------------------------------------------------------------------------

describe('analyzeMetricTrends', () => {
  it('analyzes across multiple windows', () => {
    const config = buildTrendConfig({
      windows: ['7d', '14d'],
      min_slope_threshold: 5,
    });

    const slope7d = (10 * 5.0) / (168 * 100);
    const slope14d = (8 * 5.0) / (336 * 100);

    const windowDataMap: Record<string, DataPoint[]> = {
      '7d': generateLinearData(168, 5.0, slope7d),
      '14d': generateLinearData(336, 5.0, slope14d),
    };

    const baseline = buildMetricBaseline({ mean_7d: 5.0 });

    const results = analyzeMetricTrends(
      'error_rate',
      windowDataMap,
      baseline,
      config,
    );

    expect(results.length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      expect(r.detected).toBe(true);
      expect(r.direction).toBe('degrading');
    }
  });

  it('suppresses trend observations during learning mode', () => {
    const config = buildTrendConfig({ min_slope_threshold: 1 });
    const slope = (10 * 5.0) / (168 * 100);
    const windowDataMap = {
      '7d': generateLinearData(168, 5.0, slope),
    };
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });

    const results = analyzeMetricTrends(
      'error_rate',
      windowDataMap,
      baseline,
      config,
      {},
      true, // Learning mode
    );

    expect(results).toHaveLength(0);
  });

  it('skips windows with no data', () => {
    const config = buildTrendConfig({ windows: ['7d', '14d'] });
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });

    const results = analyzeMetricTrends(
      'error_rate',
      { '7d': [] }, // 14d missing entirely
      baseline,
      config,
    );

    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// analyzeAllTrends
// ---------------------------------------------------------------------------

describe('analyzeAllTrends', () => {
  it('analyzes multiple metrics across windows', () => {
    const config = buildTrendConfig({
      windows: ['7d'],
      min_slope_threshold: 5,
    });

    const errorSlope = (10 * 5.0) / (168 * 100);
    const latencySlope = (10 * 200.0) / (168 * 100);

    const metricsData: Record<string, Record<string, DataPoint[]>> = {
      error_rate: { '7d': generateLinearData(168, 5.0, errorSlope) },
      latency_p95_ms: { '7d': generateLinearData(168, 200, latencySlope) },
    };

    const baselines: Record<string, MetricBaseline> = {
      error_rate: buildMetricBaseline({ mean_7d: 5.0 }),
      latency_p95_ms: buildMetricBaseline({ mean_7d: 200 }),
    };

    const results = analyzeAllTrends(metricsData, baselines, config);

    expect(results).toHaveLength(2);
    expect(results.map((r) => r.metric).sort()).toEqual([
      'error_rate',
      'latency_p95_ms',
    ]);
  });

  it('skips metrics with no baseline', () => {
    const config = buildTrendConfig();
    const slope = (10 * 5.0) / (168 * 100);

    const metricsData = {
      error_rate: { '7d': generateLinearData(168, 5.0, slope) },
    };

    const results = analyzeAllTrends(metricsData, {}, config);
    expect(results).toHaveLength(0);
  });

  it('suppresses all trends during learning mode', () => {
    const config = buildTrendConfig({ min_slope_threshold: 1 });
    const slope = (20 * 5.0) / (168 * 100);

    const metricsData = {
      error_rate: { '7d': generateLinearData(168, 5.0, slope) },
    };
    const baselines = {
      error_rate: buildMetricBaseline({ mean_7d: 5.0 }),
    };

    const results = analyzeAllTrends(metricsData, baselines, config, {}, true);
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-3-6: Slope computation and extrapolation tests
// ---------------------------------------------------------------------------

describe('Slope computation and extrapolation (SPEC-007-3-6)', () => {
  it('positive slope + degrading direction -> observation detected', () => {
    // error_rate with positive slope = degrading
    const slope = (10 * 5.0) / (168 * 100); // 10% change over 7d
    const dataPoints = generateLinearData(168, 5.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(true);
    expect(result.direction).toBe('degrading');
    expect(result.slope).toBeGreaterThan(0);
    expect(result.pct_change).toBeGreaterThan(5);
  });

  it('slope below threshold -> no observation', () => {
    // 3% change, threshold 5%
    const slope = (3 * 5.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 5.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(false);
    expect(result.direction).toBe('stable');
  });

  it('negative slope on latency = improving, not degrading', () => {
    const slope = -(8 * 200.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 200.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 200.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('latency_p95_ms', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(false);
    expect(result.direction).toBe('improving');
  });

  it('extrapolation: days_to_breach computed correctly for error_rate', () => {
    // current=3%, threshold=5%, slope=0.1%/hr
    // hoursToBreach = (5-3)/0.1 = 20 hours -> round(20/24) = 1 day
    const dataPoints: DataPoint[] = [
      { x: 0, y: 2.9 },
      { x: 1, y: 3.0 },
    ];
    const baseline = buildMetricBaseline({ mean_7d: 3.0 });
    const config = buildTrendConfig({ min_slope_threshold: 0.1 });
    const thresholds: MetricThresholds = { error_rate_percent: 5.0 };

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config, thresholds);

    expect(result.detected).toBe(true);
    expect(result.days_to_breach).toBe(1);
  });

  it('extrapolation: no days_to_breach when threshold is not configured', () => {
    const slope = (10 * 5.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 5.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config, {});

    expect(result.detected).toBe(true);
    expect(result.days_to_breach).toBeUndefined();
  });

  it('slope of exactly 0 produces stable result', () => {
    const dataPoints = generateLinearData(168, 5.0, 0);
    const baseline = buildMetricBaseline({ mean_7d: 5.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('error_rate', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(false);
    expect(result.direction).toBe('stable');
    expect(result.slope).toBe(0);
    expect(result.pct_change).toBe(0);
  });

  it('throughput decreasing = degrading', () => {
    const slope = -(15 * 1000.0) / (168 * 100);
    const dataPoints = generateLinearData(168, 1000.0, slope);
    const baseline = buildMetricBaseline({ mean_7d: 1000.0 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('throughput_rps', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(true);
    expect(result.direction).toBe('degrading');
    expect(result.slope).toBeLessThan(0);
  });

  it('availability decreasing = degrading', () => {
    const slope = -(8 * 99.9) / (168 * 100);
    const dataPoints = generateLinearData(168, 99.9, slope);
    const baseline = buildMetricBaseline({ mean_7d: 99.9 });
    const config = buildTrendConfig({ min_slope_threshold: 5 });

    const result = analyzeTrend('availability', '7d', dataPoints, baseline, config);

    expect(result.detected).toBe(true);
    expect(result.direction).toBe('degrading');
  });

  it('linear regression slope accuracy for large datasets', () => {
    // Generate 720 hourly points (30 days) with known slope=0.5
    const dataPoints = generateLinearData(720, 10.0, 0.5);
    const slope = linearRegressionSlope(dataPoints);

    expect(slope).toBeCloseTo(0.5, 10);
  });
});
