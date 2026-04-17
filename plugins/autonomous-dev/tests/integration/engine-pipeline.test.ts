/**
 * Integration test: Full engine pipeline with mock data
 * (SPEC-007-3-6, Task 16).
 *
 * Tests the complete observation routing pipeline from scrubbed data
 * through error detection, false positive filtering, anomaly detection,
 * trend analysis, and feature adoption -- all wired together.
 *
 * Test case IDs: TC-3-6-11 through TC-3-6-14.
 */

import { ObservationRouter } from '../../src/engine/observation-router';
import type {
  ObservationRouterOptions,
  PreviousRunState,
} from '../../src/engine/observation-router';
import type { ServiceConfig, IntelligenceConfig } from '../../src/config/intelligence-config.schema';
import type {
  PrometheusResult,
  GrafanaAlertResult,
  OpenSearchResult,
} from '../../src/adapters/types';
import type { CandidateObservation, BaselineMetrics, MetricBaseline } from '../../src/engine/types';

// ---------------------------------------------------------------------------
// Mock data factories
// ---------------------------------------------------------------------------

function createMockPrometheusResults(overrides: {
  error_rate?: number;
  latency_p99?: number;
  latency_p95?: number;
  latency_p50?: number;
  throughput?: number;
  availability?: number;
}): PrometheusResult[] {
  const results: PrometheusResult[] = [];
  const now = new Date().toISOString();

  if (overrides.error_rate !== undefined) {
    results.push({
      query_name: 'error_rate',
      query: 'rate(http_errors_total[5m])',
      value: overrides.error_rate,
      timestamp: now,
      raw_response: {},
    });
  }

  if (overrides.latency_p99 !== undefined) {
    results.push({
      query_name: 'latency_p99',
      query: 'histogram_quantile(0.99, ...)',
      value: overrides.latency_p99,
      timestamp: now,
      raw_response: {},
    });
  }

  if (overrides.latency_p95 !== undefined) {
    results.push({
      query_name: 'latency_p95',
      query: 'histogram_quantile(0.95, ...)',
      value: overrides.latency_p95,
      timestamp: now,
      raw_response: {},
    });
  }

  if (overrides.latency_p50 !== undefined) {
    results.push({
      query_name: 'latency_p50',
      query: 'histogram_quantile(0.50, ...)',
      value: overrides.latency_p50,
      timestamp: now,
      raw_response: {},
    });
  }

  if (overrides.throughput !== undefined) {
    results.push({
      query_name: 'throughput',
      query: 'sum(rate(http_requests_total[5m]))',
      value: overrides.throughput,
      timestamp: now,
      raw_response: {},
    });
  }

  if (overrides.availability !== undefined) {
    results.push({
      query_name: 'availability',
      query: '(1 - rate(http_errors_total[5m])) * 100',
      value: overrides.availability,
      timestamp: now,
      raw_response: {},
    });
  }

  return results;
}

function createMockOpenSearchResults(
  entries: Array<{ message: string; count: number }>,
): OpenSearchResult[] {
  if (entries.length === 0) return [];

  return [
    {
      query_name: 'error_aggregation',
      hits: entries.map((e) => ({
        timestamp: new Date().toISOString(),
        message: e.message,
      })),
      total_hits: entries.reduce((sum, e) => sum + e.count, 0),
      aggregations: {
        error_messages: entries.map((e) => ({
          key: e.message.split(':')[0].trim(),
          doc_count: e.count,
        })),
      },
    },
  ];
}

function createMockGrafanaAlerts(
  alerts: Array<{ name: string; state: 'alerting' | 'pending' | 'ok' | 'no_data' }>,
): GrafanaAlertResult {
  return {
    alerts: alerts.map((a) => ({
      name: a.name,
      state: a.state,
      dashboard_uid: 'abc123',
      since: new Date().toISOString(),
    })),
  };
}

function buildMetricBaseline(overrides: Partial<MetricBaseline> = {}): MetricBaseline {
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

function buildBaseline(overrides: Partial<BaselineMetrics> = {}): BaselineMetrics {
  return {
    service: 'api-gateway',
    learning_mode: false,
    learning_started: '2026-01-01T00:00:00Z',
    learning_completed: '2026-01-08T00:00:00Z',
    last_updated: '2026-04-07T00:00:00Z',
    observation_run_count: 100,
    metrics: {
      error_rate: buildMetricBaseline({ mean_7d: 2.0, stddev_7d: 0.5 }),
      latency_p50_ms: buildMetricBaseline({ mean_7d: 100, stddev_7d: 10, p50: 100 }),
      latency_p95_ms: buildMetricBaseline({ mean_7d: 200, stddev_7d: 20, p50: 200 }),
      latency_p99_ms: buildMetricBaseline({ mean_7d: 500, stddev_7d: 50, p50: 500 }),
      throughput: buildMetricBaseline({ mean_7d: 1000, stddev_7d: 100, p50: 1000 }),
      availability: buildMetricBaseline({ mean_7d: 99.9, stddev_7d: 0.05, p50: 99.9 }),
    },
    ...overrides,
  };
}

const apiGatewayConfig: ServiceConfig = {
  name: 'api-gateway',
  repo: 'org/api-gateway',
  prometheus_job: 'api-gateway',
  grafana_dashboard_uid: 'abc123',
  opensearch_index: 'logs-api-gateway-*',
  criticality: 'critical',
};

function buildIntelligenceConfig(): IntelligenceConfig {
  return {
    schedule: { type: 'cron', expression: '0 * * * *' },
    services: [apiGatewayConfig],
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
    anomaly_detection: {
      method: 'zscore',
      sensitivity: 2.5,
      consecutive_runs_required: 2,
    },
    trend_analysis: {
      windows: ['7d'],
      min_slope_threshold: 5,
    },
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
      effectiveness_improvement_threshold: 10,
    },
    retention: {
      observation_days: 90,
      archive_days: 365,
    },
    custom_pii_patterns: [],
    custom_secret_patterns: [],
    auto_promote: {
      enabled: false,
      override_hours: 24,
    },
    notifications: {
      enabled: false,
      webhook_url: null,
      severity_filter: ['P0', 'P1'],
    },
  };
}

// ---------------------------------------------------------------------------
// Router factory with mock delegates
// ---------------------------------------------------------------------------

function buildRouter(overrides: Partial<ObservationRouterOptions> = {}): ObservationRouter {
  const defaultOptions: ObservationRouterOptions = {
    // Error detection: returns candidates based on error_rate metric
    detectErrors: async (metrics, logs, thresholds, service) => {
      const candidates: CandidateObservation[] = [];

      const errorRate = metrics.find((m) => m.query_name === 'error_rate');
      if (errorRate && errorRate.value !== null && errorRate.value > (thresholds.error_rate_percent ?? 5)) {
        candidates.push({
          type: 'error',
          error_type: 'error_rate',
          service: service.name,
          metric_value: errorRate.value,
          threshold_value: thresholds.error_rate_percent ?? 5,
          sustained_minutes: 15,
          log_samples: logs.length > 0
            ? logs[0].hits.map((h) => h.message).slice(0, 5)
            : [],
          data_sources_used: ['prometheus', 'opensearch'],
          has_data_loss_indicator: false,
          has_data_corruption_indicator: false,
        });
      }

      return candidates;
    },

    // False positive filter: no filtering
    filterFalsePositive: () => ({ filtered: false }),

    // Anomaly detection: uses z-score method
    detectAnomaly: (metric, currentValue, baseline, sensitivity, previousFlags) => {
      if (baseline.stddev_7d === 0) {
        return {
          detected: false,
          metric,
          current_value: currentValue,
          deviation: 0,
          consecutive_runs: 0,
        };
      }
      const z = (currentValue - baseline.mean_7d) / baseline.stddev_7d;
      const detected = Math.abs(z) > sensitivity;
      return {
        detected,
        metric,
        current_value: currentValue,
        deviation: z,
        consecutive_runs: detected && previousFlags >= 1 ? previousFlags + 1 : detected ? 1 : 0,
      };
    },

    // Trend analysis: no trends detected
    analyzeTrend: async (metric) => ({
      detected: false,
      metric,
      window: '7d',
      direction: 'increasing' as const,
      slope: 0,
    }),

    // Adoption tracking: no adoption detected
    trackAdoption: async () => null,

    // Thresholds: returns default thresholds
    getServiceThresholds: (config) => ({
      error_rate_percent: config.default_thresholds.error_rate_percent,
      p99_latency_ms: config.default_thresholds.p99_latency_ms,
      sustained_duration_minutes: config.default_thresholds.sustained_duration_minutes,
      availability_percent: config.default_thresholds.availability_percent,
    }),
  };

  return new ObservationRouter({ ...defaultOptions, ...overrides });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Full Engine Pipeline', () => {
  // TC-3-6-11: TDD example with mock data
  test('TC-3-6-11: produces correct candidate observations from mock scrubbed data', async () => {
    const mockMetrics = createMockPrometheusResults({
      error_rate: 12.3,
      latency_p99: 8200,
      throughput: 53,
      availability: 87.7,
    });
    const mockLogs = createMockOpenSearchResults([
      { message: 'ConnectionPoolExhausted: pool "orders-db"', count: 1847 },
    ]);
    const mockAlerts = createMockGrafanaAlerts([
      { name: 'API Gateway 5xx Rate', state: 'alerting' },
    ]);
    const existingBaseline = buildBaseline();
    const config = buildIntelligenceConfig();
    const previousRunState: PreviousRunState = { anomalyFlags: {} };

    const router = buildRouter();
    const result = await router.routeObservations(
      apiGatewayConfig,
      mockMetrics,
      mockLogs as any,
      mockAlerts,
      existingBaseline,
      config,
      previousRunState,
    );

    // Verify: at least one error observation generated
    expect(result.observations.length).toBeGreaterThan(0);
    const errorObs = result.observations.find((o) => o.type === 'error');
    expect(errorObs).toBeDefined();
    expect(errorObs!.metric_value).toBe(12.3);
    expect(errorObs!.service).toBe('api-gateway');
  });

  // TC-3-6-13: No issues detected
  test('TC-3-6-13: no observations when all metrics are normal', async () => {
    const mockMetrics = createMockPrometheusResults({
      error_rate: 1.0,
      latency_p99: 300,
      throughput: 1000,
      availability: 99.95,
    });
    const mockAlerts = createMockGrafanaAlerts([]);
    const existingBaseline = buildBaseline();
    const config = buildIntelligenceConfig();
    const previousRunState: PreviousRunState = { anomalyFlags: {} };

    const router = buildRouter();
    const result = await router.routeObservations(
      apiGatewayConfig,
      mockMetrics,
      [],
      mockAlerts,
      existingBaseline,
      config,
      previousRunState,
    );

    expect(result.observations).toHaveLength(0);
  });

  // TC-3-6-14: Multiple observation types for one service
  test('TC-3-6-14: produces error, anomaly, and trend observations for one service', async () => {
    const mockMetrics = createMockPrometheusResults({
      error_rate: 12.3,
      latency_p99: 8200,
      throughput: 53,
      availability: 87.7,
    });
    const mockLogs = createMockOpenSearchResults([
      { message: 'ConnectionPoolExhausted: pool "orders-db"', count: 1847 },
    ]);
    const mockAlerts = createMockGrafanaAlerts([
      { name: 'API Gateway 5xx Rate', state: 'alerting' },
    ]);

    // Baseline with tight stddev so anomaly detection fires
    const existingBaseline = buildBaseline({
      metrics: {
        error_rate: buildMetricBaseline({ mean_7d: 2.0, stddev_7d: 0.5 }),
        latency_p50_ms: buildMetricBaseline({ mean_7d: 100, stddev_7d: 10, p50: 100 }),
        latency_p95_ms: buildMetricBaseline({ mean_7d: 200, stddev_7d: 20, p50: 200 }),
        latency_p99_ms: buildMetricBaseline({ mean_7d: 500, stddev_7d: 50, p50: 500 }),
        throughput: buildMetricBaseline({ mean_7d: 1000, stddev_7d: 100, p50: 1000 }),
        availability: buildMetricBaseline({ mean_7d: 99.9, stddev_7d: 0.05, p50: 99.9 }),
      },
    });
    const config = buildIntelligenceConfig();

    // Previous run state: anomalies were already flagged (need consecutive_runs >= 2)
    const previousRunState: PreviousRunState = {
      anomalyFlags: {
        error_rate: 1,
        throughput: 1,
        availability: 1,
      },
    };

    const router = buildRouter({
      // Override anomaly detection to return detected=true with consecutive_runs >= 2
      detectAnomaly: (metric, currentValue, baseline, sensitivity, previousFlags) => {
        if (baseline.stddev_7d === 0) {
          return { detected: false, metric, current_value: currentValue, deviation: 0, consecutive_runs: 0 };
        }
        const z = (currentValue - baseline.mean_7d) / baseline.stddev_7d;
        const detected = Math.abs(z) > sensitivity;
        return {
          detected,
          metric,
          current_value: currentValue,
          deviation: z,
          consecutive_runs: detected && previousFlags >= 1 ? 2 : detected ? 1 : 0,
        };
      },
      // Override trend analysis to detect a degrading trend on error_rate
      analyzeTrend: async (metric, window) => {
        if (metric === 'error_rate') {
          return {
            detected: true,
            metric,
            window,
            direction: 'increasing' as const,
            slope: 0.5,
          };
        }
        return {
          detected: false,
          metric,
          window,
          direction: 'increasing' as const,
          slope: 0,
        };
      },
    });

    const result = await router.routeObservations(
      apiGatewayConfig,
      mockMetrics,
      mockLogs as any,
      mockAlerts,
      existingBaseline,
      config,
      previousRunState,
    );

    // Should have observations of multiple types
    const errorObs = result.observations.filter((o) => o.type === 'error');
    const anomalyObs = result.observations.filter((o) => o.type === 'anomaly');
    const trendObs = result.observations.filter((o) => o.type === 'trend');

    expect(errorObs.length).toBeGreaterThanOrEqual(1);
    expect(anomalyObs.length).toBeGreaterThanOrEqual(1);
    expect(trendObs.length).toBeGreaterThanOrEqual(1);
  });

  test('skips anomaly, trend, and adoption phases during learning mode', async () => {
    const mockMetrics = createMockPrometheusResults({
      error_rate: 12.3,
    });
    const learningBaseline = buildBaseline({ learning_mode: true });
    const config = buildIntelligenceConfig();
    const previousRunState: PreviousRunState = { anomalyFlags: {} };

    const router = buildRouter();
    const result = await router.routeObservations(
      apiGatewayConfig,
      mockMetrics,
      [],
      { alerts: [] },
      learningBaseline,
      config,
      previousRunState,
    );

    // Error detection still active in learning mode
    expect(result.observations.filter((o) => o.type === 'error')).toHaveLength(1);

    // Other phases skipped
    expect(result.skipped_phases).toContain('anomaly_detection (learning_mode)');
    expect(result.skipped_phases).toContain('trend_analysis (learning_mode)');
    expect(result.skipped_phases).toContain('feature_adoption (learning_mode)');
  });
});
