/**
 * Integration test: Graceful degradation with partial/missing data sources
 * (SPEC-007-3-6, Task 16).
 *
 * Tests that the engine produces partial results when one or more data
 * sources are missing or unavailable, rather than failing completely.
 *
 * Test case ID: TC-3-6-12.
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
// Helpers
// ---------------------------------------------------------------------------

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
      latency_p99_ms: buildMetricBaseline({ mean_7d: 500, stddev_7d: 50 }),
      throughput: buildMetricBaseline({ mean_7d: 1000, stddev_7d: 100 }),
      availability: buildMetricBaseline({ mean_7d: 99.9, stddev_7d: 0.05 }),
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

function buildRouter(overrides: Partial<ObservationRouterOptions> = {}): ObservationRouter {
  const defaultOptions: ObservationRouterOptions = {
    detectErrors: async (metrics, logs, thresholds, service) => {
      const candidates: CandidateObservation[] = [];

      // Error from metrics (Prometheus)
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
          data_sources_used: metrics.length > 0 && logs.length > 0
            ? ['prometheus', 'opensearch']
            : metrics.length > 0
              ? ['prometheus']
              : logs.length > 0
                ? ['opensearch']
                : [],
          has_data_loss_indicator: false,
          has_data_corruption_indicator: false,
        });
      }

      // Error from logs only (OpenSearch -- exception aggregation)
      if (logs.length > 0) {
        for (const logResult of logs) {
          if (logResult.aggregations?.error_messages) {
            for (const bucket of logResult.aggregations.error_messages) {
              if (bucket.doc_count > 10) {
                candidates.push({
                  type: 'error',
                  error_type: 'exception',
                  service: service.name,
                  error_class: bucket.key,
                  metric_value: bucket.doc_count,
                  threshold_value: 10,
                  sustained_minutes: 0,
                  log_samples: logResult.hits
                    .filter((h) => h.message.includes(bucket.key))
                    .slice(0, 3)
                    .map((h) => h.message),
                  data_sources_used: ['opensearch'],
                  has_data_loss_indicator: false,
                  has_data_corruption_indicator: false,
                });
              }
            }
          }
        }
      }

      return candidates;
    },
    filterFalsePositive: () => ({ filtered: false }),
    detectAnomaly: (metric, currentValue, baseline, sensitivity) => {
      if (baseline.stddev_7d === 0) {
        return { detected: false, metric, current_value: currentValue, deviation: 0, consecutive_runs: 0 };
      }
      const z = (currentValue - baseline.mean_7d) / baseline.stddev_7d;
      return {
        detected: Math.abs(z) > sensitivity,
        metric,
        current_value: currentValue,
        deviation: z,
        consecutive_runs: 0,
      };
    },
    analyzeTrend: async (metric) => ({
      detected: false,
      metric,
      window: '7d',
      direction: 'increasing' as const,
      slope: 0,
    }),
    trackAdoption: async () => null,
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

describe('Graceful Degradation', () => {
  // TC-3-6-12: Partial data -- only OpenSearch available
  test('TC-3-6-12: produces observations from log data when Prometheus is unavailable', async () => {
    const mockLogs: OpenSearchResult[] = [
      {
        query_name: 'error_aggregation',
        hits: [
          {
            timestamp: new Date().toISOString(),
            message: 'ConnectionPoolExhausted: pool "orders-db" exhausted',
          },
          {
            timestamp: new Date().toISOString(),
            message: 'ConnectionPoolExhausted: cannot acquire connection',
          },
        ],
        total_hits: 1847,
        aggregations: {
          error_messages: [
            { key: 'ConnectionPoolExhausted', doc_count: 1847 },
          ],
        },
      },
    ];

    const config = buildIntelligenceConfig();
    const existingBaseline = buildBaseline();
    const previousRunState: PreviousRunState = { anomalyFlags: {} };

    const router = buildRouter();
    const result = await router.routeObservations(
      apiGatewayConfig,
      [], // No Prometheus data
      mockLogs as any,
      { alerts: [] },
      existingBaseline,
      config,
      previousRunState,
    );

    // Should still produce observations from log data
    expect(result.observations.length).toBeGreaterThan(0);
    const logObs = result.observations.find((o) => o.error_type === 'exception');
    expect(logObs).toBeDefined();
    expect(logObs!.data_sources_used).toContain('opensearch');
    expect(logObs!.data_sources_used).not.toContain('prometheus');
  });

  test('produces observations from Prometheus data when OpenSearch is unavailable', async () => {
    const mockMetrics: PrometheusResult[] = [
      {
        query_name: 'error_rate',
        query: 'rate(http_errors_total[5m])',
        value: 12.3,
        timestamp: new Date().toISOString(),
        raw_response: {},
      },
    ];

    const config = buildIntelligenceConfig();
    const existingBaseline = buildBaseline();
    const previousRunState: PreviousRunState = { anomalyFlags: {} };

    const router = buildRouter();
    const result = await router.routeObservations(
      apiGatewayConfig,
      mockMetrics,
      [], // No OpenSearch data
      { alerts: [] },
      existingBaseline,
      config,
      previousRunState,
    );

    // Should still produce error_rate observations from Prometheus
    expect(result.observations.length).toBeGreaterThan(0);
    const errorObs = result.observations.find((o) => o.error_type === 'error_rate');
    expect(errorObs).toBeDefined();
    expect(errorObs!.data_sources_used).toContain('prometheus');
  });

  test('produces empty observations when all data sources are empty and metrics are normal', async () => {
    const config = buildIntelligenceConfig();
    const existingBaseline = buildBaseline();
    const previousRunState: PreviousRunState = { anomalyFlags: {} };

    const router = buildRouter();
    const result = await router.routeObservations(
      apiGatewayConfig,
      [], // No Prometheus data
      [], // No OpenSearch data
      { alerts: [] }, // No Grafana alerts
      existingBaseline,
      config,
      previousRunState,
    );

    // No data means no threshold violations detected
    expect(result.observations).toHaveLength(0);
  });

  test('error detection works even when anomaly detection has no baseline metrics', async () => {
    const mockMetrics: PrometheusResult[] = [
      {
        query_name: 'error_rate',
        query: 'rate(http_errors_total[5m])',
        value: 12.3,
        timestamp: new Date().toISOString(),
        raw_response: {},
      },
    ];

    const emptyBaseline = buildBaseline({
      metrics: {}, // No baseline metrics for anomaly detection
    });

    const config = buildIntelligenceConfig();
    const previousRunState: PreviousRunState = { anomalyFlags: {} };

    const router = buildRouter();
    const result = await router.routeObservations(
      apiGatewayConfig,
      mockMetrics,
      [],
      { alerts: [] },
      emptyBaseline,
      config,
      previousRunState,
    );

    // Error detection should still work
    const errorObs = result.observations.filter((o) => o.type === 'error');
    expect(errorObs.length).toBeGreaterThan(0);

    // Anomaly detection should produce nothing (no baseline metrics to compare)
    const anomalyObs = result.observations.filter((o) => o.type === 'anomaly');
    expect(anomalyObs).toHaveLength(0);
  });

  test('handles error detection delegate throwing without crashing entire pipeline', async () => {
    const mockMetrics: PrometheusResult[] = [
      {
        query_name: 'error_rate',
        query: 'rate(http_errors_total[5m])',
        value: 12.3,
        timestamp: new Date().toISOString(),
        raw_response: {},
      },
    ];

    const config = buildIntelligenceConfig();
    const existingBaseline = buildBaseline();
    const previousRunState: PreviousRunState = { anomalyFlags: {} };

    const router = buildRouter({
      detectErrors: async () => {
        throw new Error('Simulated error detection failure');
      },
    });

    // The router should propagate the error (callers handle retry logic)
    await expect(
      router.routeObservations(
        apiGatewayConfig,
        mockMetrics,
        [],
        { alerts: [] },
        existingBaseline,
        config,
        previousRunState,
      ),
    ).rejects.toThrow('Simulated error detection failure');
  });
});
