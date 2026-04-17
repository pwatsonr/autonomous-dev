/**
 * Unit tests for the error detection engine (SPEC-007-3-1, Tasks 1 & 2).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-1-01 through TC-3-1-12.
 */

import {
  ErrorDetector,
  countMinutesAboveThreshold,
  extractTopLogSamples,
} from '../../src/engine/error-detector';
import type { QuerySustainedErrorRateFn } from '../../src/engine/error-detector';
import type { ServiceConfig, ThresholdConfig } from '../../src/config/intelligence-config.schema';
import type {
  PrometheusResult,
  PrometheusRangeResult,
  OpenSearchResult,
} from '../../src/adapters/types';
import type { BaselineMetrics } from '../../src/engine/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildService(overrides: Partial<ServiceConfig> = {}): ServiceConfig {
  return {
    name: 'api-gateway',
    repo: 'org/api-gateway',
    prometheus_job: 'api-gateway',
    grafana_dashboard_uid: 'abc123',
    opensearch_index: 'logs-api-gateway-*',
    criticality: 'critical',
    ...overrides,
  };
}

function buildThresholds(
  overrides: Partial<ThresholdConfig> = {},
): ThresholdConfig {
  return {
    error_rate_percent: 5.0,
    sustained_duration_minutes: 10,
    p99_latency_ms: 5000,
    availability_percent: 99.9,
    ...overrides,
  };
}

function buildMetric(
  queryName: string,
  value: number | null,
): PrometheusResult {
  return {
    query_name: queryName,
    query: `test_query_${queryName}`,
    value,
    timestamp: new Date().toISOString(),
    raw_response: {},
  };
}

function buildRangeResult(
  dataPoints: Array<{ timestamp: string; value: number }>,
): PrometheusRangeResult {
  return {
    query_name: 'sustained_error_rate',
    query: 'test_range_query',
    value: dataPoints.length > 0 ? dataPoints[dataPoints.length - 1].value : null,
    timestamp: new Date().toISOString(),
    data_points: dataPoints,
    raw_response: {},
  };
}

function buildDataPoints(
  count: number,
  value: number,
): Array<{ timestamp: string; value: number }> {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.now() - (count - i) * 60_000).toISOString(),
    value,
  }));
}

function buildLogResult(
  overrides: Partial<OpenSearchResult> = {},
): OpenSearchResult {
  return {
    query_name: 'error_aggregation',
    hits: [],
    total_hits: 0,
    ...overrides,
  };
}

function buildBaseline(
  metricsOverrides: Record<string, Partial<BaselineMetrics['metrics'][string]>> = {},
): BaselineMetrics {
  const defaultMetric = {
    mean_7d: 0,
    stddev_7d: 0,
    mean_14d: 0,
    stddev_14d: 0,
    mean_30d: 0,
    stddev_30d: 0,
    p50: 0,
    p95: 0,
    p99: 0,
  };

  const metrics: Record<string, BaselineMetrics['metrics'][string]> = {};
  for (const [key, overrides] of Object.entries(metricsOverrides)) {
    metrics[key] = { ...defaultMetric, ...overrides };
  }

  return {
    service: 'api-gateway',
    learning_mode: false,
    learning_started: '2026-01-01T00:00:00Z',
    learning_completed: '2026-01-08T00:00:00Z',
    last_updated: '2026-04-07T00:00:00Z',
    observation_run_count: 100,
    metrics,
  };
}

/** Builds a mock sustained error rate query function. */
function buildSustainedQuery(
  rangeResult: PrometheusRangeResult,
): QuerySustainedErrorRateFn {
  return async () => rangeResult;
}

function buildDetector(
  sustainedResult: PrometheusRangeResult = buildRangeResult([]),
  options: { exceptionCountThreshold?: number; dataInconsistencyMultiplier?: number } = {},
): ErrorDetector {
  return new ErrorDetector({
    querySustainedErrorRate: buildSustainedQuery(sustainedResult),
    ...options,
  });
}

// ---------------------------------------------------------------------------
// countMinutesAboveThreshold
// ---------------------------------------------------------------------------

describe('countMinutesAboveThreshold', () => {
  it('counts data points strictly above threshold', () => {
    const points = [
      { timestamp: '2026-04-08T00:01:00Z', value: 3.0 },
      { timestamp: '2026-04-08T00:02:00Z', value: 5.1 },
      { timestamp: '2026-04-08T00:03:00Z', value: 5.0 },
      { timestamp: '2026-04-08T00:04:00Z', value: 7.0 },
    ];
    expect(countMinutesAboveThreshold(points, 5.0)).toBe(2);
  });

  it('returns 0 for empty data points', () => {
    expect(countMinutesAboveThreshold([], 5.0)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// extractTopLogSamples
// ---------------------------------------------------------------------------

describe('extractTopLogSamples', () => {
  it('extracts unique log messages up to limit', () => {
    const logs: OpenSearchResult[] = [
      buildLogResult({
        hits: [
          { timestamp: '', message: 'Error A' },
          { timestamp: '', message: 'Error A' },
          { timestamp: '', message: 'Error B' },
          { timestamp: '', message: 'Error C' },
        ],
      }),
    ];
    const samples = extractTopLogSamples(logs, 2);
    expect(samples).toEqual(['Error A', 'Error B']);
  });

  it('returns empty array for empty logs', () => {
    expect(extractTopLogSamples([], 5)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task 1: Error rate threshold detection
// ---------------------------------------------------------------------------

describe('ErrorDetector.detectErrors - error rate', () => {
  // TC-3-1-01: Error rate above threshold
  it('TC-3-1-01: generates candidate when error rate exceeds threshold', async () => {
    const sustainedData = buildRangeResult(buildDataPoints(15, 12.3));
    const detector = buildDetector(sustainedData);

    const metrics = [buildMetric('error_rate', 12.3)];
    const thresholds = buildThresholds({ error_rate_percent: 5.0, sustained_duration_minutes: 15 });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0].error_type).toBe('error_rate');
    expect(candidates[0].metric_value).toBe(12.3);
    expect(candidates[0].threshold_value).toBe(5.0);
  });

  // TC-3-1-02: Error rate below threshold
  it('TC-3-1-02: does not generate candidate when error rate is below threshold', async () => {
    const detector = buildDetector();

    const metrics = [buildMetric('error_rate', 3.2)];
    const thresholds = buildThresholds({ error_rate_percent: 5.0 });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    const errorRateCandidates = candidates.filter(
      (c) => c.error_type === 'error_rate',
    );
    expect(errorRateCandidates).toHaveLength(0);
  });

  // TC-3-1-03: Sustained check passes
  it('TC-3-1-03: generates candidate when all minutes are above threshold', async () => {
    const sustainedData = buildRangeResult(buildDataPoints(15, 12.0));
    const detector = buildDetector(sustainedData);

    const metrics = [buildMetric('error_rate', 12.0)];
    const thresholds = buildThresholds({
      error_rate_percent: 5.0,
      sustained_duration_minutes: 15,
    });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    const errorRateCandidate = candidates.find(
      (c) => c.error_type === 'error_rate',
    );
    expect(errorRateCandidate).toBeDefined();
    expect(errorRateCandidate!.sustained_minutes).toBe(15);
  });

  // TC-3-1-04: Sustained check fails
  it('TC-3-1-04: does not generate candidate when sustained duration is insufficient', async () => {
    // Only 3 of 10 minutes above threshold
    const points = [
      ...buildDataPoints(3, 12.0),
      ...buildDataPoints(7, 3.0),
    ];
    const sustainedData = buildRangeResult(points);
    const detector = buildDetector(sustainedData);

    const metrics = [buildMetric('error_rate', 12.0)];
    const thresholds = buildThresholds({
      error_rate_percent: 5.0,
      sustained_duration_minutes: 10,
    });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    const errorRateCandidates = candidates.filter(
      (c) => c.error_type === 'error_rate',
    );
    expect(errorRateCandidates).toHaveLength(0);
  });

  // TC-3-1-05: Boundary - exactly at threshold (must be >, not >=)
  it('TC-3-1-05: does not generate candidate when error rate equals threshold', async () => {
    const detector = buildDetector();

    const metrics = [buildMetric('error_rate', 5.0)];
    const thresholds = buildThresholds({ error_rate_percent: 5.0 });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    const errorRateCandidates = candidates.filter(
      (c) => c.error_type === 'error_rate',
    );
    expect(errorRateCandidates).toHaveLength(0);
  });

  // TC-3-1-06: Per-service override
  it('TC-3-1-06: uses per-service threshold override', async () => {
    const sustainedData = buildRangeResult(buildDataPoints(10, 4.0));
    const detector = buildDetector(sustainedData);

    const metrics = [buildMetric('error_rate', 4.0)];
    // The caller would resolve per-service overrides before calling;
    // here we pass the effective threshold directly.
    const thresholds = buildThresholds({
      error_rate_percent: 3.0,
      sustained_duration_minutes: 10,
    });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    const errorRateCandidate = candidates.find(
      (c) => c.error_type === 'error_rate',
    );
    expect(errorRateCandidate).toBeDefined();
    expect(errorRateCandidate!.metric_value).toBe(4.0);
    expect(errorRateCandidate!.threshold_value).toBe(3.0);
  });

  it('does not generate candidate when error_rate metric is missing', async () => {
    const detector = buildDetector();
    const candidates = await detector.detectErrors(
      [],
      [],
      buildThresholds(),
      buildService(),
    );
    const errorRateCandidates = candidates.filter(
      (c) => c.error_type === 'error_rate',
    );
    expect(errorRateCandidates).toHaveLength(0);
  });

  it('does not generate candidate when error_rate value is null', async () => {
    const detector = buildDetector();
    const metrics = [buildMetric('error_rate', null)];
    const candidates = await detector.detectErrors(
      metrics,
      [],
      buildThresholds(),
      buildService(),
    );
    const errorRateCandidates = candidates.filter(
      (c) => c.error_type === 'error_rate',
    );
    expect(errorRateCandidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 2: Crash detection
// ---------------------------------------------------------------------------

describe('ErrorDetector.detectCrash', () => {
  // TC-3-1-07: Service down
  it('TC-3-1-07: generates crash candidate when up metric is 0', async () => {
    const detector = buildDetector();
    const metrics = [buildMetric('crash_down', 0)];

    const candidates = await detector.detectErrors(
      metrics,
      [],
      buildThresholds(),
      buildService(),
    );

    const crashCandidate = candidates.find((c) => c.error_type === 'crash');
    expect(crashCandidate).toBeDefined();
    expect(crashCandidate!.metric_value).toBe(0);
    expect(crashCandidate!.threshold_value).toBe(1);
  });

  // TC-3-1-08: Restart detected
  it('TC-3-1-08: generates crash candidate when restarts are detected', async () => {
    const detector = buildDetector();
    const metrics = [buildMetric('crash_restarts', 2)];

    const candidates = await detector.detectErrors(
      metrics,
      [],
      buildThresholds(),
      buildService(),
    );

    const crashCandidate = candidates.find((c) => c.error_type === 'crash');
    expect(crashCandidate).toBeDefined();
    expect(crashCandidate!.metric_value).toBe(2);
    expect(crashCandidate!.sustained_minutes).toBe(60);
  });

  it('does not generate crash candidate when up metric is 1', () => {
    const detector = buildDetector();
    const metrics = [buildMetric('crash_down', 1)];
    const result = detector.detectCrash(metrics, buildService());
    expect(result).toBeNull();
  });

  it('does not generate crash candidate when restarts is 0', () => {
    const detector = buildDetector();
    const metrics = [buildMetric('crash_restarts', 0)];
    const result = detector.detectCrash(metrics, buildService());
    expect(result).toBeNull();
  });

  it('prefers crash_down over crash_restarts', () => {
    const detector = buildDetector();
    const metrics = [
      buildMetric('crash_down', 0),
      buildMetric('crash_restarts', 5),
    ];
    const result = detector.detectCrash(metrics, buildService());
    expect(result).toBeDefined();
    expect(result!.metric_value).toBe(0);
    expect(result!.threshold_value).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Task 2: Exception detection
// ---------------------------------------------------------------------------

describe('ErrorDetector.detectExceptions', () => {
  // TC-3-1-09: High exception count
  it('TC-3-1-09: generates exception candidate when count exceeds threshold', async () => {
    const detector = buildDetector();
    const logs: OpenSearchResult[] = [
      buildLogResult({
        aggregations: {
          error_messages: [
            { key: 'ConnectionPoolExhausted', doc_count: 150 },
          ],
        },
        hits: [
          { timestamp: '', message: 'ConnectionPoolExhausted: pool limit reached' },
          { timestamp: '', message: 'ConnectionPoolExhausted: retry failed' },
        ],
      }),
    ];

    const candidates = await detector.detectErrors(
      [],
      logs,
      buildThresholds(),
      buildService(),
    );

    const exceptionCandidate = candidates.find(
      (c) => c.error_type === 'exception',
    );
    expect(exceptionCandidate).toBeDefined();
    expect(exceptionCandidate!.error_class).toBe('ConnectionPoolExhausted');
    expect(exceptionCandidate!.metric_value).toBe(150);
    expect(exceptionCandidate!.log_samples).toHaveLength(2);
  });

  it('does not generate exception candidate when count is at or below threshold', () => {
    const detector = buildDetector();
    const logs: OpenSearchResult[] = [
      buildLogResult({
        aggregations: {
          error_messages: [
            { key: 'MinorError', doc_count: 10 },
          ],
        },
        hits: [],
      }),
    ];
    const result = detector.detectExceptions(logs, buildService());
    expect(result).toHaveLength(0);
  });

  it('generates multiple exception candidates for different error classes', () => {
    const detector = buildDetector();
    const logs: OpenSearchResult[] = [
      buildLogResult({
        aggregations: {
          error_messages: [
            { key: 'ErrorA', doc_count: 50 },
            { key: 'ErrorB', doc_count: 30 },
            { key: 'ErrorC', doc_count: 5 },
          ],
        },
        hits: [],
      }),
    ];
    const result = detector.detectExceptions(logs, buildService());
    expect(result).toHaveLength(2); // ErrorA and ErrorB, not ErrorC
  });

  it('respects custom exception count threshold', () => {
    const detector = buildDetector(buildRangeResult([]), {
      exceptionCountThreshold: 5,
    });
    const logs: OpenSearchResult[] = [
      buildLogResult({
        aggregations: {
          error_messages: [
            { key: 'SomeError', doc_count: 6 },
          ],
        },
        hits: [],
      }),
    ];
    const result = detector.detectExceptions(logs, buildService());
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Task 2: Timeout detection
// ---------------------------------------------------------------------------

describe('ErrorDetector.detectTimeout', () => {
  // TC-3-1-10: p99 exceeds SLA
  it('TC-3-1-10: generates timeout candidate when p99 exceeds threshold', async () => {
    const detector = buildDetector();
    const metrics = [buildMetric('latency_p99', 8200)];
    const thresholds = buildThresholds({ p99_latency_ms: 5000 });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    const timeoutCandidate = candidates.find(
      (c) => c.error_type === 'timeout',
    );
    expect(timeoutCandidate).toBeDefined();
    expect(timeoutCandidate!.metric_value).toBe(8200);
    expect(timeoutCandidate!.threshold_value).toBe(5000);
  });

  it('does not generate timeout candidate when p99 is within SLA', () => {
    const detector = buildDetector();
    const metrics = [buildMetric('latency_p99', 3000)];
    const thresholds = buildThresholds({ p99_latency_ms: 5000 });
    const result = detector.detectTimeout(metrics, thresholds, buildService());
    expect(result).toBeNull();
  });

  it('does not generate timeout candidate when p99 is null', () => {
    const detector = buildDetector();
    const metrics = [buildMetric('latency_p99', null)];
    const thresholds = buildThresholds({ p99_latency_ms: 5000 });
    const result = detector.detectTimeout(metrics, thresholds, buildService());
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 2: Degraded performance detection
// ---------------------------------------------------------------------------

describe('ErrorDetector.detectDegradedPerformance', () => {
  // TC-3-1-11: p95 > 2x baseline
  it('TC-3-1-11: generates degraded candidate when p95 exceeds 2x baseline', async () => {
    const detector = buildDetector();
    const metrics = [buildMetric('latency_p95', 120)];
    const baseline = buildBaseline({
      latency_p95_ms: { mean_7d: 45 },
    });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      buildThresholds(),
      buildService(),
      baseline,
    );

    const degradedCandidate = candidates.find(
      (c) => c.error_type === 'degraded_performance',
    );
    expect(degradedCandidate).toBeDefined();
    expect(degradedCandidate!.metric_value).toBe(120);
    expect(degradedCandidate!.threshold_value).toBe(90); // 2 * 45
  });

  // TC-3-1-12: p95 normal
  it('TC-3-1-12: does not generate degraded candidate when p95 is within 2x baseline', async () => {
    const detector = buildDetector();
    const metrics = [buildMetric('latency_p95', 80)];
    const baseline = buildBaseline({
      latency_p95_ms: { mean_7d: 45 },
    });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      buildThresholds(),
      buildService(),
      baseline,
    );

    const degradedCandidates = candidates.filter(
      (c) => c.error_type === 'degraded_performance',
    );
    expect(degradedCandidates).toHaveLength(0);
  });

  it('does not generate degraded candidate without baseline', async () => {
    const detector = buildDetector();
    const metrics = [buildMetric('latency_p95', 120)];

    const candidates = await detector.detectErrors(
      metrics,
      [],
      buildThresholds(),
      buildService(),
      // no baseline
    );

    const degradedCandidates = candidates.filter(
      (c) => c.error_type === 'degraded_performance',
    );
    expect(degradedCandidates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Task 2: Data inconsistency detection
// ---------------------------------------------------------------------------

describe('ErrorDetector.detectDataInconsistency', () => {
  it('generates data inconsistency candidate when 4xx rate exceeds 3x baseline', () => {
    const detector = buildDetector();
    const metrics = [
      buildMetric('client_error_rate_4xx', 15.0),
      buildMetric('client_error_rate_422', 5.0),
    ];
    const baseline = buildBaseline({
      client_error_rate: { mean_7d: 4.0 },
    });

    const result = detector.detectDataInconsistency(
      metrics,
      baseline,
      buildService(),
    );
    expect(result).toBeDefined();
    expect(result!.error_type).toBe('data_inconsistency');
    expect(result!.metric_value).toBe(15.0);
    expect(result!.threshold_value).toBe(12.0); // 3 * 4.0
    expect(result!.has_data_corruption_indicator).toBe(true);
  });

  it('does not flag corruption when no 422 metric is present', () => {
    const detector = buildDetector();
    const metrics = [
      buildMetric('client_error_rate_4xx', 15.0),
    ];
    const baseline = buildBaseline({
      client_error_rate: { mean_7d: 4.0 },
    });

    const result = detector.detectDataInconsistency(
      metrics,
      baseline,
      buildService(),
    );
    expect(result).toBeDefined();
    expect(result!.has_data_corruption_indicator).toBe(false);
  });

  it('does not generate candidate when 4xx rate is within baseline', () => {
    const detector = buildDetector();
    const metrics = [buildMetric('client_error_rate_4xx', 10.0)];
    const baseline = buildBaseline({
      client_error_rate: { mean_7d: 4.0 },
    });

    const result = detector.detectDataInconsistency(
      metrics,
      baseline,
      buildService(),
    );
    expect(result).toBeNull();
  });

  it('respects custom data inconsistency multiplier', () => {
    const detector = buildDetector(buildRangeResult([]), {
      dataInconsistencyMultiplier: 2,
    });
    const metrics = [buildMetric('client_error_rate_4xx', 9.0)];
    const baseline = buildBaseline({
      client_error_rate: { mean_7d: 4.0 },
    });

    const result = detector.detectDataInconsistency(
      metrics,
      baseline,
      buildService(),
    );
    expect(result).toBeDefined();
    expect(result!.threshold_value).toBe(8.0); // 2 * 4.0
  });
});

// ---------------------------------------------------------------------------
// Integration: multiple detections in one call
// ---------------------------------------------------------------------------

describe('ErrorDetector.detectErrors - multiple detections', () => {
  it('returns multiple candidates from different detectors in a single call', async () => {
    const sustainedData = buildRangeResult(buildDataPoints(10, 12.0));
    const detector = buildDetector(sustainedData);

    const metrics = [
      buildMetric('error_rate', 12.0),
      buildMetric('crash_down', 0),
      buildMetric('latency_p99', 8000),
    ];
    const thresholds = buildThresholds({
      error_rate_percent: 5.0,
      sustained_duration_minutes: 10,
      p99_latency_ms: 5000,
    });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    const types = candidates.map((c) => c.error_type);
    expect(types).toContain('error_rate');
    expect(types).toContain('crash');
    expect(types).toContain('timeout');
    expect(candidates.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-3-6 additional edge case and boundary tests
// ---------------------------------------------------------------------------

describe('ErrorDetector - edge cases (SPEC-007-3-6)', () => {
  it('handles all metrics being null without errors', async () => {
    const detector = buildDetector();
    const metrics = [
      buildMetric('error_rate', null),
      buildMetric('crash_down', null),
      buildMetric('crash_restarts', null),
      buildMetric('latency_p99', null),
    ];

    const candidates = await detector.detectErrors(
      metrics,
      [],
      buildThresholds(),
      buildService(),
    );

    expect(candidates).toHaveLength(0);
  });

  it('handles empty metrics array without errors', async () => {
    const detector = buildDetector();
    const candidates = await detector.detectErrors(
      [],
      [],
      buildThresholds(),
      buildService(),
    );

    expect(candidates).toHaveLength(0);
  });

  it('generates both error_rate and exception candidates simultaneously', async () => {
    const sustainedData = buildRangeResult(buildDataPoints(10, 12.0));
    const detector = buildDetector(sustainedData);

    const metrics = [buildMetric('error_rate', 12.0)];
    const logs: OpenSearchResult[] = [
      buildLogResult({
        aggregations: {
          error_messages: [
            { key: 'NullPointerException', doc_count: 500 },
          ],
        },
        hits: [
          { timestamp: '', message: 'NullPointerException at line 42' },
        ],
      }),
    ];
    const thresholds = buildThresholds({
      error_rate_percent: 5.0,
      sustained_duration_minutes: 10,
    });

    const candidates = await detector.detectErrors(
      metrics,
      logs,
      thresholds,
      buildService(),
    );

    const types = candidates.map((c) => c.error_type);
    expect(types).toContain('error_rate');
    expect(types).toContain('exception');
  });

  it('error rate exactly 0.001 above threshold triggers detection', async () => {
    const threshold = 5.0;
    const value = 5.001;
    const sustainedData = buildRangeResult(buildDataPoints(10, value));
    const detector = buildDetector(sustainedData);

    const metrics = [buildMetric('error_rate', value)];
    const thresholds = buildThresholds({
      error_rate_percent: threshold,
      sustained_duration_minutes: 10,
    });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    const errorRateCandidate = candidates.find((c) => c.error_type === 'error_rate');
    expect(errorRateCandidate).toBeDefined();
  });

  it('handles very large metric values without errors', async () => {
    const sustainedData = buildRangeResult(buildDataPoints(10, 99999));
    const detector = buildDetector(sustainedData);

    const metrics = [
      buildMetric('error_rate', 99999),
      buildMetric('latency_p99', 99999999),
    ];
    const thresholds = buildThresholds({
      error_rate_percent: 5.0,
      sustained_duration_minutes: 10,
      p99_latency_ms: 5000,
    });

    const candidates = await detector.detectErrors(
      metrics,
      [],
      thresholds,
      buildService(),
    );

    expect(candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('log samples are capped at 5 for error_rate detection', async () => {
    const sustainedData = buildRangeResult(buildDataPoints(10, 12.0));
    const detector = buildDetector(sustainedData);

    const metrics = [buildMetric('error_rate', 12.0)];
    const logs: OpenSearchResult[] = [
      buildLogResult({
        hits: Array.from({ length: 20 }, (_, i) => ({
          timestamp: '',
          message: `Error message ${i}`,
        })),
      }),
    ];

    const candidates = await detector.detectErrors(
      metrics,
      logs,
      buildThresholds({ error_rate_percent: 5.0, sustained_duration_minutes: 10 }),
      buildService(),
    );

    const errorRateCandidate = candidates.find((c) => c.error_type === 'error_rate');
    expect(errorRateCandidate).toBeDefined();
    expect(errorRateCandidate!.log_samples.length).toBeLessThanOrEqual(5);
  });
});
