/**
 * Unit tests for anomaly detection (SPEC-007-3-4, Task 10).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-4-07 through TC-3-4-14, TC-3-4-20.
 */

import {
  detectAnomalyZScore,
  detectAnomalyIQR,
  detectAnomalies,
  isBadDirection,
} from '../../src/engine/anomaly-detector';
import type { AnomalyResult, AnomalyDetectorConfig } from '../../src/engine/anomaly-detector';
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

// ---------------------------------------------------------------------------
// isBadDirection
// ---------------------------------------------------------------------------

describe('isBadDirection', () => {
  it('error_rate above is bad', () => {
    expect(isBadDirection('error_rate', 'above')).toBe(true);
  });

  it('error_rate below is not bad (improving)', () => {
    expect(isBadDirection('error_rate', 'below')).toBe(false);
  });

  it('latency metrics above are bad', () => {
    expect(isBadDirection('latency_p50_ms', 'above')).toBe(true);
    expect(isBadDirection('latency_p95_ms', 'above')).toBe(true);
    expect(isBadDirection('latency_p99_ms', 'above')).toBe(true);
  });

  it('throughput_rps below is bad', () => {
    expect(isBadDirection('throughput_rps', 'below')).toBe(true);
  });

  it('throughput_rps above is not bad (improving)', () => {
    expect(isBadDirection('throughput_rps', 'above')).toBe(false);
  });

  it('availability below is bad', () => {
    expect(isBadDirection('availability', 'below')).toBe(true);
  });

  it('availability above is not bad (improving)', () => {
    expect(isBadDirection('availability', 'above')).toBe(false);
  });

  it('unknown metric returns false for any direction', () => {
    expect(isBadDirection('unknown_metric', 'above')).toBe(false);
    expect(isBadDirection('unknown_metric', 'below')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Z-score detection
// ---------------------------------------------------------------------------

describe('detectAnomalyZScore', () => {
  it('TC-3-4-07: flags anomaly when z=3.2, sensitivity=2.5, bad direction', () => {
    // error_rate: mean=5, stddev=1, current=8.2 -> z = (8.2-5)/1 = 3.2
    const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
    const result = detectAnomalyZScore('error_rate', 8.2, baseline, 2.5);

    expect(result.detected).toBe(true);
    expect(result.z_score).toBeCloseTo(3.2, 5);
    expect(result.direction).toBe('above');
    expect(result.is_bad_direction).toBe(true);
    expect(result.method).toBe('zscore');
  });

  it('TC-3-4-08: does not flag when z=2.0, sensitivity=2.5', () => {
    // error_rate: mean=5, stddev=1, current=7 -> z = (7-5)/1 = 2.0
    const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
    const result = detectAnomalyZScore('error_rate', 7.0, baseline, 2.5);

    expect(result.detected).toBe(false);
    expect(result.z_score).toBeCloseTo(2.0, 5);
  });

  it('TC-3-4-09: does not flag good direction (z=-3.0 on error_rate = below = good)', () => {
    // error_rate: mean=5, stddev=1, current=2 -> z = (2-5)/1 = -3.0
    const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
    const result = detectAnomalyZScore('error_rate', 2.0, baseline, 2.5);

    expect(result.detected).toBe(false);
    expect(result.z_score).toBeCloseTo(-3.0, 5);
    expect(result.direction).toBe('below');
    expect(result.is_bad_direction).toBe(false);
  });

  it('TC-3-4-10: handles zero stddev gracefully', () => {
    const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 0 });
    const result = detectAnomalyZScore('error_rate', 100, baseline, 2.5);

    expect(result.detected).toBe(false);
    expect(result.z_score).toBe(0);
  });

  it('flags throughput_rps anomaly when value drops (below = bad)', () => {
    // throughput: mean=1000, stddev=100, current=650 -> z = (650-1000)/100 = -3.5
    const baseline = buildMetricBaseline({ mean_7d: 1000, stddev_7d: 100 });
    const result = detectAnomalyZScore('throughput_rps', 650, baseline, 2.5);

    expect(result.detected).toBe(true);
    expect(result.direction).toBe('below');
    expect(result.is_bad_direction).toBe(true);
  });

  it('does not flag throughput_rps when value increases (above = good)', () => {
    const baseline = buildMetricBaseline({ mean_7d: 1000, stddev_7d: 100 });
    const result = detectAnomalyZScore('throughput_rps', 1400, baseline, 2.5);

    expect(result.detected).toBe(false);
    expect(result.direction).toBe('above');
    expect(result.is_bad_direction).toBe(false);
  });

  it('TC-3-4-13: consecutive_runs = 1 on first detection (no previous anomaly)', () => {
    const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
    const result = detectAnomalyZScore('error_rate', 8.5, baseline, 2.5, false);

    expect(result.detected).toBe(true);
    expect(result.consecutive_runs).toBe(1);
  });

  it('TC-3-4-14: consecutive_runs = 2 when previous run also had anomaly', () => {
    const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
    const result = detectAnomalyZScore('error_rate', 8.5, baseline, 2.5, true);

    expect(result.detected).toBe(true);
    expect(result.consecutive_runs).toBe(2);
  });

  it('consecutive_runs = 0 when not detected', () => {
    const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
    const result = detectAnomalyZScore('error_rate', 5.5, baseline, 2.5, true);

    expect(result.detected).toBe(false);
    expect(result.consecutive_runs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// IQR detection
// ---------------------------------------------------------------------------

describe('detectAnomalyIQR', () => {
  it('TC-3-4-11: flags when current is outside upper bound', () => {
    // p50=50, stddev=10 -> Q1=50-6.75=43.25, Q3=50+6.75=56.75
    // IQR=13.5, upperBound=56.75+20.25=77.0
    // current=100 > 77.0 => outside
    const baseline = buildMetricBaseline({
      mean_7d: 50,
      stddev_7d: 10,
      p50: 50,
    });
    const result = detectAnomalyIQR('error_rate', 100, baseline);

    expect(result.detected).toBe(true);
    expect(result.direction).toBe('above');
    expect(result.is_bad_direction).toBe(true);
    expect(result.method).toBe('iqr');
  });

  it('TC-3-4-12: does not flag when current is within bounds', () => {
    // p50=50, stddev=10 -> Q1=43.25, Q3=56.75
    // IQR=13.5, lowerBound=43.25-20.25=23.0, upperBound=77.0
    // current=50 => within bounds
    const baseline = buildMetricBaseline({
      mean_7d: 50,
      stddev_7d: 10,
      p50: 50,
    });
    const result = detectAnomalyIQR('error_rate', 50, baseline);

    expect(result.detected).toBe(false);
  });

  it('flags throughput_rps below lower bound', () => {
    // p50=1000, stddev=100 -> Q1=932.5, Q3=1067.5
    // IQR=135, lowerBound=932.5-202.5=730, upperBound=1067.5+202.5=1270
    // current=700 < 730 => outside, direction=below, bad for throughput
    const baseline = buildMetricBaseline({
      mean_7d: 1000,
      stddev_7d: 100,
      p50: 1000,
    });
    const result = detectAnomalyIQR('throughput_rps', 700, baseline);

    expect(result.detected).toBe(true);
    expect(result.direction).toBe('below');
    expect(result.is_bad_direction).toBe(true);
  });

  it('does not flag error_rate below lower bound (improving)', () => {
    // error_rate below lower bound = improving, not bad
    const baseline = buildMetricBaseline({
      mean_7d: 50,
      stddev_7d: 10,
      p50: 50,
    });
    // lowerBound = 43.25 - 20.25 = 23.0
    const result = detectAnomalyIQR('error_rate', 10, baseline);

    expect(result.detected).toBe(false);
    expect(result.direction).toBe('below');
    expect(result.is_bad_direction).toBe(false);
  });

  it('tracks consecutive runs with previousRunAnomaly', () => {
    const baseline = buildMetricBaseline({
      mean_7d: 50,
      stddev_7d: 10,
      p50: 50,
    });

    const result1 = detectAnomalyIQR('error_rate', 100, baseline, false);
    expect(result1.consecutive_runs).toBe(1);

    const result2 = detectAnomalyIQR('error_rate', 100, baseline, true);
    expect(result2.consecutive_runs).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Multi-metric anomaly scan (detectAnomalies)
// ---------------------------------------------------------------------------

describe('detectAnomalies', () => {
  const defaultConfig: AnomalyDetectorConfig = {
    method: 'zscore',
    sensitivity: 2.5,
    consecutive_runs_required: 2,
  };

  it('returns results only when consecutive run requirement is met', () => {
    const baselines: Record<string, MetricBaseline> = {
      error_rate: buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 }),
    };

    // First run: anomaly detected but consecutive_runs = 1
    const { results: results1, runState: state1 } = detectAnomalies(
      { error_rate: 8.5 },
      baselines,
      defaultConfig,
      {},
    );
    expect(results1).toHaveLength(0); // Need 2 consecutive runs
    expect(state1.error_rate).toBe(true);

    // Second run: anomaly persists, consecutive_runs = 2
    const { results: results2 } = detectAnomalies(
      { error_rate: 8.5 },
      baselines,
      defaultConfig,
      state1,
    );
    expect(results2).toHaveLength(1);
    expect(results2[0].consecutive_runs).toBe(2);
  });

  it('TC-3-4-20: suppresses anomaly observations during learning mode', () => {
    const baselines: Record<string, MetricBaseline> = {
      error_rate: buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 }),
    };

    // Even with z=5.0 and consecutive runs, no observation during learning
    const { results, runState } = detectAnomalies(
      { error_rate: 10.0 }, // z = 5.0
      baselines,
      defaultConfig,
      { error_rate: true }, // Previous run also anomalous
      true, // Learning mode
    );

    expect(results).toHaveLength(0);
    // But run state IS tracked even during learning
    expect(runState.error_rate).toBe(true);
  });

  it('uses IQR method when configured', () => {
    const iqrConfig: AnomalyDetectorConfig = {
      method: 'iqr',
      sensitivity: 2.5,
      consecutive_runs_required: 2,
    };

    const baselines: Record<string, MetricBaseline> = {
      error_rate: buildMetricBaseline({ mean_7d: 50, stddev_7d: 10, p50: 50 }),
    };

    const { results } = detectAnomalies(
      { error_rate: 100 },
      baselines,
      iqrConfig,
      { error_rate: true },
    );

    expect(results).toHaveLength(1);
    expect(results[0].method).toBe('iqr');
  });

  it('skips metrics with no baseline', () => {
    const { results, runState } = detectAnomalies(
      { error_rate: 100, unknown_metric: 999 },
      { error_rate: buildMetricBaseline({ mean_7d: 5, stddev_7d: 1 }) },
      defaultConfig,
      { error_rate: true },
    );

    // error_rate should be detected
    expect(results).toHaveLength(1);
    // unknown_metric has no baseline, should not appear in state
    expect(runState.unknown_metric).toBeUndefined();
  });

  it('allows with consecutive_runs_required = 1', () => {
    const singleRunConfig: AnomalyDetectorConfig = {
      method: 'zscore',
      sensitivity: 2.5,
      consecutive_runs_required: 1,
    };

    const baselines: Record<string, MetricBaseline> = {
      error_rate: buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 }),
    };

    const { results } = detectAnomalies(
      { error_rate: 8.5 },
      baselines,
      singleRunConfig,
      {},
    );

    expect(results).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-3-6: Both methods, boundary conditions
// ---------------------------------------------------------------------------

describe('Anomaly detection boundary conditions (SPEC-007-3-6)', () => {
  describe('Z-score boundary conditions', () => {
    it('z exactly equal to sensitivity is NOT flagged (requires strictly greater)', () => {
      // mean=5, stddev=1, current=7.5 -> z = 2.5, sensitivity=2.5
      // |z| > sensitivity means 2.5 > 2.5 => false
      const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
      const result = detectAnomalyZScore('error_rate', 7.5, baseline, 2.5);

      expect(result.detected).toBe(false);
      expect(result.z_score).toBeCloseTo(2.5, 5);
    });

    it('z just above sensitivity is flagged', () => {
      // mean=5, stddev=1, current=7.51 -> z = 2.51, sensitivity=2.5
      const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
      const result = detectAnomalyZScore('error_rate', 7.51, baseline, 2.5);

      expect(result.detected).toBe(true);
      expect(result.z_score!).toBeGreaterThan(2.5);
    });

    it('very large z-score is flagged', () => {
      const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 });
      const result = detectAnomalyZScore('error_rate', 100, baseline, 2.5);

      expect(result.detected).toBe(true);
      expect(result.z_score).toBeCloseTo(95, 5);
    });

    it('negative z-score for latency (below baseline) is not flagged (good direction)', () => {
      // latency below baseline = improving, not degrading
      const baseline = buildMetricBaseline({ mean_7d: 200, stddev_7d: 20 });
      const result = detectAnomalyZScore('latency_p99_ms', 100, baseline, 2.5);

      expect(result.detected).toBe(false);
      expect(result.direction).toBe('below');
      expect(result.is_bad_direction).toBe(false);
    });

    it('handles very small stddev correctly', () => {
      const baseline = buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 0.001 });
      const result = detectAnomalyZScore('error_rate', 5.01, baseline, 2.5);

      // z = (5.01 - 5.0) / 0.001 = 10.0
      expect(result.detected).toBe(true);
      expect(result.z_score).toBeCloseTo(10.0, 1);
    });
  });

  describe('IQR boundary conditions', () => {
    it('value exactly at upper bound is NOT flagged (requires strictly outside)', () => {
      // p50=50, stddev=10 -> Q1=43.25, Q3=56.75, IQR=13.5
      // upperBound = 56.75 + 20.25 = 77.0
      // current=77.0 is NOT > 77.0 but is equal => not outside
      const baseline = buildMetricBaseline({
        mean_7d: 50,
        stddev_7d: 10,
        p50: 50,
      });

      const result = detectAnomalyIQR('error_rate', 77.0, baseline);

      // 77 is not < lowerBound (23) and not > upperBound (77) => isOutside = false
      expect(result.detected).toBe(false);
    });

    it('value just above upper bound IS flagged', () => {
      const baseline = buildMetricBaseline({
        mean_7d: 50,
        stddev_7d: 10,
        p50: 50,
      });

      // upperBound = 77.0, current=77.01 -> outside
      const result = detectAnomalyIQR('error_rate', 77.01, baseline);

      expect(result.detected).toBe(true);
      expect(result.direction).toBe('above');
    });

    it('value at lower bound is NOT flagged', () => {
      // lowerBound = 43.25 - 20.25 = 23.0
      const baseline = buildMetricBaseline({
        mean_7d: 50,
        stddev_7d: 10,
        p50: 50,
      });

      const result = detectAnomalyIQR('throughput_rps', 23.0, baseline);

      // 23 is not < 23 => not outside
      expect(result.detected).toBe(false);
    });

    it('value just below lower bound IS flagged for throughput (bad direction)', () => {
      const baseline = buildMetricBaseline({
        mean_7d: 1000,
        stddev_7d: 100,
        p50: 1000,
      });

      // Q1=932.5, Q3=1067.5, IQR=135
      // lowerBound = 932.5 - 202.5 = 730
      const result = detectAnomalyIQR('throughput_rps', 729, baseline);

      expect(result.detected).toBe(true);
      expect(result.direction).toBe('below');
      expect(result.is_bad_direction).toBe(true);
    });

    it('zero stddev results in Q1=Q3=p50, IQR=0', () => {
      const baseline = buildMetricBaseline({
        mean_7d: 50,
        stddev_7d: 0,
        p50: 50,
      });

      // Q1=50, Q3=50, IQR=0, lowerBound=50, upperBound=50
      // Any value != 50 should be outside
      const resultAbove = detectAnomalyIQR('error_rate', 51, baseline);
      expect(resultAbove.detected).toBe(true);

      const resultBelow = detectAnomalyIQR('throughput_rps', 49, baseline);
      expect(resultBelow.detected).toBe(true);

      // Exact value should NOT be outside
      const resultExact = detectAnomalyIQR('error_rate', 50, baseline);
      expect(resultExact.detected).toBe(false);
    });
  });

  describe('Multi-metric boundary conditions', () => {
    it('multiple metrics: some anomalous, some normal', () => {
      const baselines: Record<string, MetricBaseline> = {
        error_rate: buildMetricBaseline({ mean_7d: 5.0, stddev_7d: 1.0 }),
        latency_p99_ms: buildMetricBaseline({ mean_7d: 500, stddev_7d: 50 }),
        throughput_rps: buildMetricBaseline({ mean_7d: 1000, stddev_7d: 100 }),
      };

      const config: AnomalyDetectorConfig = {
        method: 'zscore',
        sensitivity: 2.5,
        consecutive_runs_required: 1,
      };

      const { results, runState } = detectAnomalies(
        {
          error_rate: 8.5, // z=3.5, anomalous + bad direction
          latency_p99_ms: 550, // z=1.0, not anomalous
          throughput_rps: 1050, // z=0.5, not anomalous
        },
        baselines,
        config,
      );

      expect(results).toHaveLength(1);
      expect(results[0].metric).toBe('error_rate');
      expect(runState.error_rate).toBe(true);
      expect(runState.latency_p99_ms).toBe(false);
      expect(runState.throughput_rps).toBe(false);
    });
  });
});
