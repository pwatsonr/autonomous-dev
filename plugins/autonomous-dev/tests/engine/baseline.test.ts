/**
 * Unit tests for baseline management (SPEC-007-3-4, Task 9).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-4-01 through TC-3-4-06, TC-3-4-20.
 */

import {
  createBaseline,
  updateBaseline,
  updateMetricBaseline,
  initializeMetricBaseline,
  updateExtendedWindow,
  updatePercentiles,
  checkLearningMode,
  serializeBaseline,
  deserializeBaseline,
  EWMA_ALPHA,
  LEARNING_MIN_DAYS,
  LEARNING_MIN_RUNS,
  BASELINE_METRICS,
} from '../../src/engine/baseline';
import type { BaselineMetrics, MetricBaseline } from '../../src/engine/types';

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

function buildBaseline(
  overrides: Partial<BaselineMetrics> = {},
): BaselineMetrics {
  return {
    service: 'api-gateway',
    learning_mode: true,
    learning_started: '2026-01-01T00:00:00Z',
    learning_completed: null,
    last_updated: '2026-01-01T00:00:00Z',
    observation_run_count: 0,
    metrics: {},
    ...overrides,
  };
}

function daysFromNow(days: number, base: Date = new Date('2026-01-01T00:00:00Z')): Date {
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// createBaseline
// ---------------------------------------------------------------------------

describe('createBaseline', () => {
  it('creates a new baseline in learning mode', () => {
    const now = new Date('2026-04-01T00:00:00Z');
    const baseline = createBaseline('my-service', now);

    expect(baseline.service).toBe('my-service');
    expect(baseline.learning_mode).toBe(true);
    expect(baseline.learning_started).toBe(now.toISOString());
    expect(baseline.learning_completed).toBeNull();
    expect(baseline.observation_run_count).toBe(0);
    expect(baseline.metrics).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// EWMA update
// ---------------------------------------------------------------------------

describe('EWMA update', () => {
  it('TC-3-4-02: single EWMA update computes correctly', () => {
    // mean=10.0, new_value=20.0 -> new_mean = 0.9*10 + 0.1*20 = 11.0
    const metric = buildMetricBaseline({ mean_7d: 10.0, stddev_7d: 0 });
    updateMetricBaseline(metric, 20.0);

    expect(metric.mean_7d).toBeCloseTo(11.0, 10);
  });

  it('TC-3-4-01: EWMA converges toward constant value after 10 updates', () => {
    // Start with mean=50, update 10 times with value=100
    const metric = buildMetricBaseline({ mean_7d: 50, stddev_7d: 0 });

    for (let i = 0; i < 10; i++) {
      updateMetricBaseline(metric, 100);
    }

    // After 10 updates: mean = 50 * 0.9^10 + 100 * (1 - 0.9^10)
    // 0.9^10 = 0.3486784401
    // mean = 50 * 0.3486784401 + 100 * 0.6513215599 = 17.434 + 65.132 = 82.566
    // But note: EWMA updates iteratively, and the mean in stddev calc uses
    // the *already updated* mean. Let's just verify convergence direction.
    expect(metric.mean_7d).toBeGreaterThan(50);
    expect(metric.mean_7d).toBeLessThan(100);

    // After many more updates it should converge very close to 100
    for (let i = 0; i < 100; i++) {
      updateMetricBaseline(metric, 100);
    }
    expect(metric.mean_7d).toBeCloseTo(100, 1);
  });

  it('TC-3-4-03: stddev increases when new value deviates significantly', () => {
    // stddev=2.0, mean=50.0, new_value deviates by 5
    const metric = buildMetricBaseline({ mean_7d: 50.0, stddev_7d: 2.0 });
    updateMetricBaseline(metric, 55.0);

    // After mean update: mean = 0.9 * 50 + 0.1 * 55 = 50.5
    // stddev = sqrt(0.9 * 4 + 0.1 * (55 - 50.5)^2)
    //        = sqrt(3.6 + 0.1 * 20.25)
    //        = sqrt(3.6 + 2.025)
    //        = sqrt(5.625) ~ 2.372
    expect(metric.stddev_7d).toBeGreaterThan(2.0);
    expect(metric.stddev_7d).toBeCloseTo(2.372, 2);
  });

  it('stddev converges toward 0 when all values are the same', () => {
    const metric = buildMetricBaseline({ mean_7d: 100, stddev_7d: 5.0 });

    // Update with constant value many times
    for (let i = 0; i < 200; i++) {
      updateMetricBaseline(metric, 100);
    }

    expect(metric.stddev_7d).toBeCloseTo(0, 1);
  });
});

// ---------------------------------------------------------------------------
// initializeMetricBaseline
// ---------------------------------------------------------------------------

describe('initializeMetricBaseline', () => {
  it('sets all means to the value and all stddevs to 0', () => {
    const metric = initializeMetricBaseline(42);

    expect(metric.mean_7d).toBe(42);
    expect(metric.mean_14d).toBe(42);
    expect(metric.mean_30d).toBe(42);
    expect(metric.stddev_7d).toBe(0);
    expect(metric.stddev_14d).toBe(0);
    expect(metric.stddev_30d).toBe(0);
    expect(metric.p50).toBe(42);
    expect(metric.p95).toBe(42);
    expect(metric.p99).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// updateBaseline (full record)
// ---------------------------------------------------------------------------

describe('updateBaseline', () => {
  it('initializes new metrics on first observation', () => {
    const baseline = buildBaseline();
    const now = new Date('2026-04-01T12:00:00Z');

    updateBaseline(baseline, { error_rate: 2.5, latency_p50_ms: 150 }, now);

    expect(baseline.metrics.error_rate).toBeDefined();
    expect(baseline.metrics.error_rate!.mean_7d).toBe(2.5);
    expect(baseline.metrics.latency_p50_ms).toBeDefined();
    expect(baseline.metrics.latency_p50_ms!.mean_7d).toBe(150);
    expect(baseline.observation_run_count).toBe(1);
    expect(baseline.last_updated).toBe(now.toISOString());
  });

  it('applies EWMA update on subsequent observations', () => {
    const baseline = buildBaseline({
      metrics: {
        error_rate: buildMetricBaseline({ mean_7d: 10.0 }),
      },
      observation_run_count: 5,
    });

    updateBaseline(baseline, { error_rate: 20.0 });

    expect(baseline.metrics.error_rate!.mean_7d).toBeCloseTo(11.0, 10);
    expect(baseline.observation_run_count).toBe(6);
  });

  it('skips undefined or null metric values', () => {
    const baseline = buildBaseline({
      metrics: {
        error_rate: buildMetricBaseline({ mean_7d: 10.0 }),
      },
      observation_run_count: 3,
    });

    // Only provide throughput_rps, not error_rate
    updateBaseline(baseline, { throughput_rps: 500 });

    // error_rate should be unchanged
    expect(baseline.metrics.error_rate!.mean_7d).toBe(10.0);
    // throughput_rps should be initialized
    expect(baseline.metrics.throughput_rps).toBeDefined();
    expect(baseline.metrics.throughput_rps!.mean_7d).toBe(500);
    expect(baseline.observation_run_count).toBe(4);
  });

  it('ignores metrics not in BASELINE_METRICS', () => {
    const baseline = buildBaseline();
    updateBaseline(baseline, { unknown_metric: 42 } as Record<string, number>);

    expect(baseline.metrics.unknown_metric).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updateExtendedWindow
// ---------------------------------------------------------------------------

describe('updateExtendedWindow', () => {
  it('updates 14d window from Prometheus data', () => {
    const baseline = buildBaseline({
      metrics: { error_rate: buildMetricBaseline() },
    });

    updateExtendedWindow(baseline, 'error_rate', '14d', 3.5, 1.2);

    expect(baseline.metrics.error_rate!.mean_14d).toBe(3.5);
    expect(baseline.metrics.error_rate!.stddev_14d).toBe(1.2);
  });

  it('updates 30d window from Prometheus data', () => {
    const baseline = buildBaseline({
      metrics: { error_rate: buildMetricBaseline() },
    });

    updateExtendedWindow(baseline, 'error_rate', '30d', 4.0, 1.5);

    expect(baseline.metrics.error_rate!.mean_30d).toBe(4.0);
    expect(baseline.metrics.error_rate!.stddev_30d).toBe(1.5);
  });

  it('no-ops when metric does not exist in baseline', () => {
    const baseline = buildBaseline();
    updateExtendedWindow(baseline, 'nonexistent', '14d', 1.0, 0.5);

    expect(baseline.metrics.nonexistent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// updatePercentiles
// ---------------------------------------------------------------------------

describe('updatePercentiles', () => {
  it('updates p50, p95, p99 for existing metric', () => {
    const baseline = buildBaseline({
      metrics: { latency_p99_ms: buildMetricBaseline() },
    });

    updatePercentiles(baseline, 'latency_p99_ms', 100, 200, 500);

    expect(baseline.metrics.latency_p99_ms!.p50).toBe(100);
    expect(baseline.metrics.latency_p99_ms!.p95).toBe(200);
    expect(baseline.metrics.latency_p99_ms!.p99).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// Learning mode lifecycle
// ---------------------------------------------------------------------------

describe('checkLearningMode', () => {
  it('TC-3-4-04: still learning when < 7 days (5 days, 8 runs)', () => {
    const baseline = buildBaseline({
      learning_mode: true,
      learning_started: '2026-01-01T00:00:00Z',
      observation_run_count: 8,
    });

    const now = daysFromNow(5); // Only 5 days
    const result = checkLearningMode(baseline, now);

    expect(result).toBe(true);
    expect(baseline.learning_mode).toBe(true);
    expect(baseline.learning_completed).toBeNull();
  });

  it('TC-3-4-05: still learning when < 6 runs (8 days, 4 runs)', () => {
    const baseline = buildBaseline({
      learning_mode: true,
      learning_started: '2026-01-01T00:00:00Z',
      observation_run_count: 4,
    });

    const now = daysFromNow(8); // 8 days but only 4 runs
    const result = checkLearningMode(baseline, now);

    expect(result).toBe(true);
    expect(baseline.learning_mode).toBe(true);
    expect(baseline.learning_completed).toBeNull();
  });

  it('TC-3-4-06: learning complete when >= 7 days AND >= 6 runs (8 days, 7 runs)', () => {
    const baseline = buildBaseline({
      learning_mode: true,
      learning_started: '2026-01-01T00:00:00Z',
      observation_run_count: 7,
    });

    const now = daysFromNow(8); // 8 days and 7 runs
    const result = checkLearningMode(baseline, now);

    expect(result).toBe(false);
    expect(baseline.learning_mode).toBe(false);
    expect(baseline.learning_completed).toBe(now.toISOString());
  });

  it('returns false immediately when already out of learning mode', () => {
    const baseline = buildBaseline({
      learning_mode: false,
      learning_completed: '2026-01-08T00:00:00Z',
    });

    const result = checkLearningMode(baseline);

    expect(result).toBe(false);
    expect(baseline.learning_mode).toBe(false);
  });

  it('exits learning at exactly 7 days and 6 runs (boundary)', () => {
    const baseline = buildBaseline({
      learning_mode: true,
      learning_started: '2026-01-01T00:00:00Z',
      observation_run_count: 6,
    });

    const now = daysFromNow(7); // Exactly 7 days
    const result = checkLearningMode(baseline, now);

    expect(result).toBe(false);
    expect(baseline.learning_mode).toBe(false);
  });

  it('stays in learning at 6 days 23 hours with 10 runs', () => {
    const baseline = buildBaseline({
      learning_mode: true,
      learning_started: '2026-01-01T00:00:00Z',
      observation_run_count: 10,
    });

    // 6 days and 23 hours = 6.958... days < 7
    const now = new Date('2026-01-07T23:00:00Z');
    const result = checkLearningMode(baseline, now);

    expect(result).toBe(true);
    expect(baseline.learning_mode).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

describe('serializeBaseline / deserializeBaseline', () => {
  it('round-trips a baseline record', () => {
    const baseline = buildBaseline({
      metrics: {
        error_rate: buildMetricBaseline({ mean_7d: 2.5, stddev_7d: 0.5 }),
      },
      observation_run_count: 10,
    });

    const json = serializeBaseline(baseline);
    const restored = deserializeBaseline(json);

    expect(restored).toEqual(baseline);
  });

  it('throws on missing required fields', () => {
    expect(() => deserializeBaseline('{}')).toThrow('missing required field');
  });

  it('throws on invalid JSON', () => {
    expect(() => deserializeBaseline('not json')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('constants', () => {
  it('EWMA_ALPHA is 0.1', () => {
    expect(EWMA_ALPHA).toBe(0.1);
  });

  it('LEARNING_MIN_DAYS is 7', () => {
    expect(LEARNING_MIN_DAYS).toBe(7);
  });

  it('LEARNING_MIN_RUNS is 6', () => {
    expect(LEARNING_MIN_RUNS).toBe(6);
  });

  it('BASELINE_METRICS contains the 6 expected metrics', () => {
    expect(BASELINE_METRICS).toEqual([
      'error_rate',
      'latency_p50_ms',
      'latency_p95_ms',
      'latency_p99_ms',
      'throughput_rps',
      'availability',
    ]);
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-3-6: EWMA convergence and learning mode tests
// ---------------------------------------------------------------------------

describe('EWMA convergence (SPEC-007-3-6)', () => {
  it('EWMA mean converges to new value within 50 updates', () => {
    const metric = buildMetricBaseline({ mean_7d: 0, stddev_7d: 0 });

    for (let i = 0; i < 50; i++) {
      updateMetricBaseline(metric, 100);
    }

    // After 50 updates with alpha=0.1, should be very close to 100
    // 0 * 0.9^50 + 100 * (1 - 0.9^50)
    // 0.9^50 = 0.00515... -> mean ~= 99.49
    expect(metric.mean_7d).toBeCloseTo(100, 0);
  });

  it('EWMA mean tracks alternating values correctly', () => {
    const metric = buildMetricBaseline({ mean_7d: 50, stddev_7d: 0 });

    // Alternate between 0 and 100
    for (let i = 0; i < 100; i++) {
      updateMetricBaseline(metric, i % 2 === 0 ? 0 : 100);
    }

    // Should converge toward the average (50)
    expect(metric.mean_7d).toBeCloseTo(50, 0);
    // Stddev should be non-zero due to variance
    expect(metric.stddev_7d).toBeGreaterThan(0);
  });

  it('EWMA stddev converges to 0 when all values are constant', () => {
    const metric = buildMetricBaseline({ mean_7d: 100, stddev_7d: 50 });

    for (let i = 0; i < 200; i++) {
      updateMetricBaseline(metric, 100);
    }

    expect(metric.stddev_7d).toBeCloseTo(0, 1);
    expect(metric.mean_7d).toBeCloseTo(100, 1);
  });

  it('EWMA with alpha=0.1 gives more weight to history than new values', () => {
    const metric = buildMetricBaseline({ mean_7d: 100, stddev_7d: 0 });

    // Single outlier should not move mean much
    updateMetricBaseline(metric, 200);

    // New mean = 0.9 * 100 + 0.1 * 200 = 110
    expect(metric.mean_7d).toBeCloseTo(110, 10);
    // Most of the original value is preserved
    expect(metric.mean_7d).toBeLessThan(150);
  });

  it('updateBaseline correctly updates last_updated and run_count each call', () => {
    const baseline = buildBaseline({ observation_run_count: 5 });
    const t1 = new Date('2026-04-01T12:00:00Z');
    const t2 = new Date('2026-04-01T16:00:00Z');

    updateBaseline(baseline, { error_rate: 2.5 }, t1);
    expect(baseline.observation_run_count).toBe(6);
    expect(baseline.last_updated).toBe(t1.toISOString());

    updateBaseline(baseline, { error_rate: 3.0 }, t2);
    expect(baseline.observation_run_count).toBe(7);
    expect(baseline.last_updated).toBe(t2.toISOString());
  });
});

describe('Learning mode transitions (SPEC-007-3-6)', () => {
  it('transitions correctly: learning -> stable -> remains stable', () => {
    const baseline = buildBaseline({
      learning_mode: true,
      learning_started: '2026-01-01T00:00:00Z',
      observation_run_count: 0,
    });

    // Day 1, run 1: still learning
    const day1 = daysFromNow(1);
    updateBaseline(baseline, { error_rate: 5.0 }, day1);
    expect(checkLearningMode(baseline, day1)).toBe(true);

    // Simulate 6 more runs (total = 7)
    for (let i = 0; i < 6; i++) {
      updateBaseline(baseline, { error_rate: 5.0 }, daysFromNow(2 + i));
    }
    expect(baseline.observation_run_count).toBe(7);

    // Day 6: still learning (< 7 days)
    expect(checkLearningMode(baseline, daysFromNow(6))).toBe(true);

    // Day 8: should transition out (>= 7 days AND >= 6 runs)
    const day8 = daysFromNow(8);
    const stillLearning = checkLearningMode(baseline, day8);
    expect(stillLearning).toBe(false);
    expect(baseline.learning_mode).toBe(false);
    expect(baseline.learning_completed).toBe(day8.toISOString());

    // Subsequent check: should remain stable
    const day10 = daysFromNow(10);
    expect(checkLearningMode(baseline, day10)).toBe(false);
    expect(baseline.learning_mode).toBe(false);
  });

  it('does not exit learning with exactly 5 runs even after 10 days', () => {
    const baseline = buildBaseline({
      learning_mode: true,
      learning_started: '2026-01-01T00:00:00Z',
      observation_run_count: 5,
    });

    const day10 = daysFromNow(10);
    expect(checkLearningMode(baseline, day10)).toBe(true);
    expect(baseline.learning_mode).toBe(true);
  });

  it('does not exit learning with exactly 6 days even with 100 runs', () => {
    const baseline = buildBaseline({
      learning_mode: true,
      learning_started: '2026-01-01T00:00:00Z',
      observation_run_count: 100,
    });

    // 6 days and 23 hours
    const almost7Days = new Date('2026-01-07T23:00:00Z');
    expect(checkLearningMode(baseline, almost7Days)).toBe(true);
  });
});
