/**
 * Unit tests for the observation type decision tree (SPEC-007-3-5, Task 14).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-5-13: Routing: error only (learning mode)
 *   TC-3-5-14: Routing: all types (not learning)
 *   TC-3-5-15: Routing: learning mode skips
 */

import {
  ObservationRouter,
  anomalyToCandidate,
  trendToCandidate,
  adoptionToCandidate,
  getCurrentMetricValue,
  BASELINE_METRICS,
} from '../../src/engine/observation-router';
import type {
  ObservationRouterOptions,
  AnomalyDetectionResult,
  TrendDetectionResult,
  PreviousRunState,
} from '../../src/engine/observation-router';
import type { CandidateObservation, BaselineMetrics, MetricBaseline } from '../../src/engine/types';
import type { ServiceConfig, IntelligenceConfig } from '../../src/config/intelligence-config.schema';
import type { PrometheusResult, GrafanaAlertResult } from '../../src/adapters/types';
import type { AdoptionResult } from '../../src/engine/adoption-tracker';

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

function buildConfig(overrides: Partial<IntelligenceConfig> = {}): IntelligenceConfig {
  return {
    schedule: { type: 'cron', expression: '0 */4 * * *' },
    services: [buildService()],
    default_thresholds: {
      error_rate_percent: 5.0,
      sustained_duration_minutes: 10,
      p99_latency_ms: 5000,
      availability_percent: 99.9,
    },
    per_service_overrides: {},
    query_budgets: {
      prometheus: { max_queries_per_service: 20, timeout_seconds: 30 },
      grafana: { max_queries_per_service: 10, timeout_seconds: 30 },
      opensearch: { max_queries_per_service: 15, timeout_seconds: 60 },
      sentry: { max_queries_per_service: 10, timeout_seconds: 30 },
    },
    anomaly_detection: { method: 'zscore', sensitivity: 2.5, consecutive_runs_required: 2 },
    trend_analysis: { windows: ['24h', '7d'], min_slope_threshold: 0.01 },
    false_positive_filters: {
      maintenance_windows: [],
      excluded_error_patterns: [],
      load_test_markers: [],
    },
    governance: {
      cooldown_days: 7,
      oscillation_window_days: 30,
      oscillation_threshold: 3,
      effectiveness_comparison_days: 14,
      effectiveness_improvement_threshold: 0.1,
    },
    retention: { observation_days: 90, archive_days: 365 },
    custom_pii_patterns: [],
    custom_secret_patterns: [],
    auto_promote: { enabled: false, override_hours: 0 },
    notifications: { enabled: false, webhook_url: null, severity_filter: ['P0', 'P1'] },
    ...overrides,
  } as IntelligenceConfig;
}

function buildMetric(queryName: string, value: number | null): PrometheusResult {
  return {
    query_name: queryName,
    query: `test_query_${queryName}`,
    value,
    timestamp: new Date().toISOString(),
    raw_response: {},
  };
}

const defaultMetricBaseline: MetricBaseline = {
  mean_7d: 100,
  stddev_7d: 10,
  mean_14d: 100,
  stddev_14d: 10,
  mean_30d: 100,
  stddev_30d: 10,
  p50: 90,
  p95: 120,
  p99: 150,
};

function buildBaseline(
  overrides: Partial<BaselineMetrics> = {},
): BaselineMetrics {
  const metrics: Record<string, MetricBaseline> = {};
  for (const m of BASELINE_METRICS) {
    metrics[m] = { ...defaultMetricBaseline };
  }
  return {
    service: 'api-gateway',
    learning_mode: false,
    learning_started: '2026-01-01T00:00:00Z',
    learning_completed: '2026-01-08T00:00:00Z',
    last_updated: '2026-04-07T00:00:00Z',
    observation_run_count: 100,
    metrics,
    ...overrides,
  };
}

function buildPreviousRunState(
  overrides: Partial<PreviousRunState> = {},
): PreviousRunState {
  return {
    anomalyFlags: {},
    ...overrides,
  };
}

function buildErrorCandidate(service: string = 'api-gateway'): CandidateObservation {
  return {
    type: 'error',
    error_type: 'error_rate',
    service,
    metric_value: 10.0,
    threshold_value: 5.0,
    sustained_minutes: 15,
    log_samples: ['Error: timeout'],
    data_sources_used: ['prometheus', 'opensearch'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
  };
}

const emptyAlerts: GrafanaAlertResult = { alerts: [] };

// ---------------------------------------------------------------------------
// Default router options (all phases produce nothing by default)
// ---------------------------------------------------------------------------

function buildRouterOptions(
  overrides: Partial<ObservationRouterOptions> = {},
): ObservationRouterOptions {
  return {
    detectErrors: async () => [],
    filterFalsePositive: () => ({ filtered: false }),
    detectAnomaly: () => ({
      detected: false,
      metric: 'error_rate',
      current_value: 0,
      deviation: 0,
      consecutive_runs: 0,
    }),
    analyzeTrend: async () => ({
      detected: false,
      metric: 'error_rate',
      window: '24h',
      direction: 'increasing' as const,
      slope: 0,
    }),
    trackAdoption: async () => null,
    getServiceThresholds: () => ({ error_rate_percent: 5.0 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getCurrentMetricValue
// ---------------------------------------------------------------------------

describe('getCurrentMetricValue', () => {
  it('returns value for matching metric', () => {
    const metrics = [buildMetric('error_rate', 7.5)];
    expect(getCurrentMetricValue(metrics, 'error_rate')).toBe(7.5);
  });

  it('returns null for missing metric', () => {
    const metrics = [buildMetric('error_rate', 7.5)];
    expect(getCurrentMetricValue(metrics, 'latency_p99_ms')).toBeNull();
  });

  it('maps baseline metric names to query names', () => {
    const metrics = [buildMetric('latency_p95', 250)];
    expect(getCurrentMetricValue(metrics, 'latency_p95_ms')).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// Converter functions
// ---------------------------------------------------------------------------

describe('anomalyToCandidate', () => {
  it('produces anomaly-typed candidate', () => {
    const anomaly: AnomalyDetectionResult = {
      detected: true,
      metric: 'error_rate',
      current_value: 15.0,
      deviation: 3.5,
      consecutive_runs: 3,
    };
    const service = buildService();
    const candidate = anomalyToCandidate(anomaly, service);

    expect(candidate.type).toBe('anomaly');
    expect(candidate.service).toBe('api-gateway');
    expect(candidate.metric_value).toBe(15.0);
    expect(candidate.data_sources_used).toContain('prometheus');
  });
});

describe('trendToCandidate', () => {
  it('produces trend-typed candidate', () => {
    const trend: TrendDetectionResult = {
      detected: true,
      metric: 'latency_p95_ms',
      window: '7d',
      direction: 'increasing',
      slope: 0.5,
    };
    const service = buildService();
    const candidate = trendToCandidate(trend, service);

    expect(candidate.type).toBe('trend');
    expect(candidate.service).toBe('api-gateway');
    expect(candidate.metric_value).toBe(0.5);
  });
});

describe('adoptionToCandidate', () => {
  it('produces adoption-typed candidate', () => {
    const adoption: AdoptionResult = {
      detected: true,
      deploy_info: {
        commit: 'abc123',
        deployed_at: '2026-04-07T00:00:00Z',
        days_since_deploy: 1,
      },
      endpoints: [
        {
          endpoint: '/api/v2/orders',
          first_traffic_at: '2026-04-07T01:00:00Z',
          current_rps: 50,
          error_rate: 0.1,
        },
      ],
    };
    const service = buildService();
    const candidate = adoptionToCandidate(adoption, service);

    expect(candidate.type).toBe('adoption');
    expect(candidate.service).toBe('api-gateway');
    expect(candidate.endpoint).toBe('/api/v2/orders');
    expect(candidate.data_sources_used).toContain('prometheus');
    expect(candidate.data_sources_used).toContain('grafana');
  });
});

// ---------------------------------------------------------------------------
// ObservationRouter.routeObservations
// ---------------------------------------------------------------------------

describe('ObservationRouter', () => {
  const service = buildService();
  const config = buildConfig();

  // TC-3-5-13: Error only (learning mode)
  it('TC-3-5-13: only runs error detection in learning mode', async () => {
    const errorCandidate = buildErrorCandidate();
    const options = buildRouterOptions({
      detectErrors: async () => [errorCandidate],
    });
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: true });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [buildMetric('error_rate', 10.0)],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    // Error detection should produce the observation
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].type).toBe('error');

    // Anomaly, trend, and adoption should be skipped
    expect(result.skipped_phases).toContain('anomaly_detection (learning_mode)');
    expect(result.skipped_phases).toContain('trend_analysis (learning_mode)');
    expect(result.skipped_phases).toContain('feature_adoption (learning_mode)');
  });

  // TC-3-5-14: All types (not learning)
  it('TC-3-5-14: generates observations from all phases when not learning', async () => {
    const errorCandidate = buildErrorCandidate();
    const anomalyResult: AnomalyDetectionResult = {
      detected: true,
      metric: 'error_rate',
      current_value: 15.0,
      deviation: 3.5,
      consecutive_runs: 3,
    };
    const trendResult: TrendDetectionResult = {
      detected: true,
      metric: 'latency_p95_ms',
      window: '24h',
      direction: 'increasing',
      slope: 0.5,
    };
    const adoptionResult: AdoptionResult = {
      detected: true,
      deploy_info: {
        commit: 'abc123',
        deployed_at: '2026-04-07T00:00:00Z',
        days_since_deploy: 1,
      },
      endpoints: [
        {
          endpoint: '/api/v2/orders',
          first_traffic_at: '2026-04-07T01:00:00Z',
          current_rps: 50,
          error_rate: 0.1,
        },
      ],
    };

    const options = buildRouterOptions({
      detectErrors: async () => [errorCandidate],
      detectAnomaly: () => anomalyResult,
      analyzeTrend: async () => trendResult,
      trackAdoption: async () => adoptionResult,
    });
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: false });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [
        buildMetric('error_rate', 15.0),
        buildMetric('latency_p95', 250),
        buildMetric('latency_p99', 300),
        buildMetric('latency_p50', 100),
        buildMetric('throughput', 1000),
        buildMetric('availability', 99.0),
      ],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    // Should have error + anomaly(s) + trend(s) + adoption
    const types = result.observations.map((o) => o.type);
    expect(types).toContain('error');
    expect(types).toContain('anomaly');
    expect(types).toContain('trend');
    expect(types).toContain('adoption');

    // No phases should be skipped
    expect(result.skipped_phases).toHaveLength(0);
  });

  // TC-3-5-15: Learning mode skips anomaly, trend, adoption
  it('TC-3-5-15: skips anomaly, trend, and adoption in learning mode with reasons', async () => {
    const options = buildRouterOptions();
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: true });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    expect(result.skipped_phases).toEqual([
      'anomaly_detection (learning_mode)',
      'trend_analysis (learning_mode)',
      'feature_adoption (learning_mode)',
    ]);
  });

  it('filters false positive errors from output', async () => {
    const errorCandidate = buildErrorCandidate();
    const options = buildRouterOptions({
      detectErrors: async () => [errorCandidate],
      filterFalsePositive: () => ({ filtered: true, reason: 'maintenance_window' }),
    });
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: true });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    // Error candidate should be filtered out
    expect(result.observations.filter((o) => o.type === 'error')).toHaveLength(0);
  });

  it('requires consecutive_runs_required before adding anomaly', async () => {
    const anomalyNotEnough: AnomalyDetectionResult = {
      detected: true,
      metric: 'error_rate',
      current_value: 15.0,
      deviation: 3.5,
      consecutive_runs: 1, // Less than the required 2
    };
    const options = buildRouterOptions({
      detectAnomaly: () => anomalyNotEnough,
    });
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: false });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [buildMetric('error_rate', 15.0)],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    // Anomaly should NOT be included because consecutive_runs < consecutive_runs_required
    expect(result.observations.filter((o) => o.type === 'anomaly')).toHaveLength(0);
  });

  it('does not add anomaly when not detected', async () => {
    const options = buildRouterOptions({
      detectAnomaly: () => ({
        detected: false,
        metric: 'error_rate',
        current_value: 5.0,
        deviation: 0.5,
        consecutive_runs: 0,
      }),
    });
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: false });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [buildMetric('error_rate', 5.0)],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    expect(result.observations.filter((o) => o.type === 'anomaly')).toHaveLength(0);
  });

  it('does not add trend when not detected', async () => {
    const options = buildRouterOptions({
      analyzeTrend: async () => ({
        detected: false,
        metric: 'error_rate',
        window: '24h',
        direction: 'increasing' as const,
        slope: 0.001,
      }),
    });
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: false });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [buildMetric('error_rate', 5.0)],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    expect(result.observations.filter((o) => o.type === 'trend')).toHaveLength(0);
  });

  it('does not add adoption when trackAdoption returns null', async () => {
    const options = buildRouterOptions({
      trackAdoption: async () => null,
    });
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: false });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    expect(result.observations.filter((o) => o.type === 'adoption')).toHaveLength(0);
  });

  it('multiple observation types coexist in one run', async () => {
    const errorCandidate = buildErrorCandidate();
    const trendResult: TrendDetectionResult = {
      detected: true,
      metric: 'error_rate',
      window: '24h',
      direction: 'increasing',
      slope: 0.5,
    };

    const options = buildRouterOptions({
      detectErrors: async () => [errorCandidate],
      analyzeTrend: async () => trendResult,
    });
    const router = new ObservationRouter(options);

    const baseline = buildBaseline({ learning_mode: false });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [buildMetric('error_rate', 10.0)],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    const types = new Set(result.observations.map((o) => o.type));
    expect(types.has('error')).toBe(true);
    expect(types.has('trend')).toBe(true);
  });

  it('skips metrics with no baseline data', async () => {
    const anomalyResult: AnomalyDetectionResult = {
      detected: true,
      metric: 'error_rate',
      current_value: 15.0,
      deviation: 3.5,
      consecutive_runs: 3,
    };
    const options = buildRouterOptions({
      detectAnomaly: () => anomalyResult,
    });
    const router = new ObservationRouter(options);

    // Baseline with empty metrics -- no baseline data for any metric
    const baseline = buildBaseline({
      learning_mode: false,
      metrics: {},
    });
    const previousRunState = buildPreviousRunState();

    const result = await router.routeObservations(
      service,
      [buildMetric('error_rate', 15.0)],
      [],
      emptyAlerts,
      baseline,
      config,
      previousRunState,
    );

    // No anomaly should be generated because no baseline metrics exist
    expect(result.observations.filter((o) => o.type === 'anomaly')).toHaveLength(0);
  });
});
