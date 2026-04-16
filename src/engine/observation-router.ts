/**
 * Observation type decision tree (SPEC-007-3-5, Task 14).
 *
 * Routes each service evaluation through the priority chain:
 *   1. Error detection   (always active, even in learning mode)
 *   2. Anomaly detection (Phase 2+, requires baseline, not in learning mode)
 *   3. Trend analysis    (Phase 2+, requires baseline, not in learning mode)
 *   4. Feature adoption  (Phase 2+, not in learning mode)
 *
 * Multiple observation types CAN coexist for the same service in one
 * run. For example, an error observation and a trend observation can
 * both be generated if both conditions are met.
 */

import type { ServiceConfig, IntelligenceConfig } from '../config/intelligence-config.schema';
import type {
  PrometheusResult,
  GrafanaAlertResult,
} from '../adapters/types';
import type { ScrubbedOpenSearchResult } from '../safety/scrub-pipeline';
import type { CandidateObservation, BaselineMetrics, MetricBaseline } from './types';
import type { AdoptionResult } from './adoption-tracker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Result of routing a service evaluation through the decision tree.
 */
export interface RoutingResult {
  /** All candidate observations generated across all phases. */
  observations: CandidateObservation[];

  /** Phases skipped with reasons (e.g., learning mode). */
  skipped_phases: string[];
}

/**
 * Result of an anomaly detection check for a single metric.
 */
export interface AnomalyDetectionResult {
  /** Whether the anomaly was detected. */
  detected: boolean;

  /** Name of the metric. */
  metric: string;

  /** Current value of the metric. */
  current_value: number;

  /** Z-score or IQR deviation. */
  deviation: number;

  /** Number of consecutive runs the anomaly has been flagged. */
  consecutive_runs: number;
}

/**
 * Result of a trend analysis check for a single metric/window.
 */
export interface TrendDetectionResult {
  /** Whether a significant trend was detected. */
  detected: boolean;

  /** Name of the metric. */
  metric: string;

  /** Time window analyzed. */
  window: string;

  /** Direction of the trend. */
  direction: 'increasing' | 'decreasing';

  /** Slope magnitude. */
  slope: number;
}

/**
 * Previous run state for anomaly detection continuity.
 */
export interface PreviousRunState {
  /** Per-metric anomaly flag counts from previous runs. */
  anomalyFlags: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Standard baseline metrics tracked for anomaly detection and trend analysis.
 */
export const BASELINE_METRICS: readonly string[] = [
  'error_rate',
  'latency_p50_ms',
  'latency_p95_ms',
  'latency_p99_ms',
  'throughput',
  'availability',
] as const;

// ---------------------------------------------------------------------------
// Delegate types
// ---------------------------------------------------------------------------

/**
 * Function type for error detection.
 * Injected as a dependency for testability.
 */
export type DetectErrorsFn = (
  metrics: PrometheusResult[],
  logs: ScrubbedOpenSearchResult[],
  thresholds: Record<string, number>,
  service: ServiceConfig,
) => Promise<CandidateObservation[]>;

/**
 * Function type for false positive filtering.
 * Injected as a dependency for testability.
 */
export type FilterFalsePositiveFn = (
  candidate: CandidateObservation,
  config: IntelligenceConfig,
  currentTime: Date,
) => { filtered: boolean; reason?: string };

/**
 * Function type for anomaly detection.
 * Injected as a dependency for testability.
 */
export type DetectAnomalyFn = (
  metric: string,
  currentValue: number,
  baseline: MetricBaseline,
  sensitivity: number,
  previousFlags: number,
) => AnomalyDetectionResult;

/**
 * Function type for trend analysis.
 * Injected as a dependency for testability.
 */
export type AnalyzeTrendFn = (
  metric: string,
  window: string,
  service: ServiceConfig,
  baseline: MetricBaseline,
  config: IntelligenceConfig,
) => Promise<TrendDetectionResult>;

/**
 * Function type for feature adoption tracking.
 * Injected as a dependency for testability.
 */
export type TrackAdoptionFn = (
  service: ServiceConfig,
  config: IntelligenceConfig,
) => Promise<AdoptionResult | null>;

/**
 * Function type for getting effective service thresholds.
 */
export type GetServiceThresholdsFn = (
  config: IntelligenceConfig,
  serviceName: string,
) => Record<string, number>;

// ---------------------------------------------------------------------------
// Helper converters
// ---------------------------------------------------------------------------

/**
 * Converts an AnomalyDetectionResult into a CandidateObservation.
 */
export function anomalyToCandidate(
  anomaly: AnomalyDetectionResult,
  service: ServiceConfig,
): CandidateObservation {
  return {
    type: 'anomaly',
    service: service.name,
    metric_value: anomaly.current_value,
    threshold_value: anomaly.deviation,
    sustained_minutes: 0,
    log_samples: [],
    data_sources_used: ['prometheus'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
  };
}

/**
 * Converts a TrendDetectionResult into a CandidateObservation.
 */
export function trendToCandidate(
  trend: TrendDetectionResult,
  service: ServiceConfig,
): CandidateObservation {
  return {
    type: 'trend',
    service: service.name,
    metric_value: trend.slope,
    threshold_value: 0,
    sustained_minutes: 0,
    log_samples: [],
    data_sources_used: ['prometheus'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
  };
}

/**
 * Converts an AdoptionResult into a CandidateObservation.
 */
export function adoptionToCandidate(
  adoption: AdoptionResult,
  service: ServiceConfig,
): CandidateObservation {
  return {
    type: 'adoption',
    service: service.name,
    metric_value: adoption.endpoints.length,
    threshold_value: 0,
    sustained_minutes: 0,
    endpoint: adoption.endpoints[0]?.endpoint,
    log_samples: [],
    data_sources_used: ['prometheus', 'grafana'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
  };
}

// ---------------------------------------------------------------------------
// Metric value extraction
// ---------------------------------------------------------------------------

/**
 * Extracts the current value for a named metric from Prometheus results.
 *
 * Maps baseline metric names to Prometheus query_name conventions.
 */
export function getCurrentMetricValue(
  metrics: PrometheusResult[],
  metricName: string,
): number | null {
  // Map baseline metric names to Prometheus query names
  const queryNameMap: Record<string, string> = {
    error_rate: 'error_rate',
    latency_p50_ms: 'latency_p50',
    latency_p95_ms: 'latency_p95',
    latency_p99_ms: 'latency_p99',
    throughput: 'throughput',
    availability: 'availability',
  };

  const queryName = queryNameMap[metricName] ?? metricName;
  const result = metrics.find((m) => m.query_name === queryName);
  return result?.value ?? null;
}

// ---------------------------------------------------------------------------
// ObservationRouter
// ---------------------------------------------------------------------------

/**
 * Options for constructing an ObservationRouter.
 */
export interface ObservationRouterOptions {
  /** Error detection function. */
  detectErrors: DetectErrorsFn;

  /** False positive filter function. */
  filterFalsePositive: FilterFalsePositiveFn;

  /** Anomaly detection function. */
  detectAnomaly: DetectAnomalyFn;

  /** Trend analysis function. */
  analyzeTrend: AnalyzeTrendFn;

  /** Feature adoption tracking function. */
  trackAdoption: TrackAdoptionFn;

  /** Get effective thresholds for a service. */
  getServiceThresholds: GetServiceThresholdsFn;
}

/**
 * Routes service evaluations through the observation type decision tree.
 *
 * Applies the priority chain: error -> anomaly -> trend -> adoption.
 * All phases are independent -- multiple observation types can coexist
 * for the same service in one run.
 */
export class ObservationRouter {
  private readonly detectErrors: DetectErrorsFn;
  private readonly filterFalsePositive: FilterFalsePositiveFn;
  private readonly detectAnomaly: DetectAnomalyFn;
  private readonly analyzeTrend: AnalyzeTrendFn;
  private readonly trackAdoption: TrackAdoptionFn;
  private readonly getServiceThresholds: GetServiceThresholdsFn;

  constructor(options: ObservationRouterOptions) {
    this.detectErrors = options.detectErrors;
    this.filterFalsePositive = options.filterFalsePositive;
    this.detectAnomaly = options.detectAnomaly;
    this.analyzeTrend = options.analyzeTrend;
    this.trackAdoption = options.trackAdoption;
    this.getServiceThresholds = options.getServiceThresholds;
  }

  /**
   * Routes a service evaluation through the full observation decision tree.
   *
   * Priority order:
   *   1. Error detection (always active, even in learning mode)
   *   2. Anomaly detection (requires baseline, not in learning mode)
   *   3. Trend analysis (requires baseline, not in learning mode)
   *   4. Feature adoption (not in learning mode)
   *
   * @param service          Service configuration
   * @param metrics          Prometheus metric results
   * @param logs             Scrubbed OpenSearch log results
   * @param alerts           Grafana alert results
   * @param baseline         Baseline metrics for the service
   * @param config           Intelligence configuration
   * @param previousRunState State from previous observation runs
   * @returns Routing result with observations and skipped phases
   */
  async routeObservations(
    service: ServiceConfig,
    metrics: PrometheusResult[],
    logs: ScrubbedOpenSearchResult[],
    _alerts: GrafanaAlertResult,
    baseline: BaselineMetrics,
    config: IntelligenceConfig,
    previousRunState: PreviousRunState,
  ): Promise<RoutingResult> {
    const observations: CandidateObservation[] = [];
    const skipped: string[] = [];

    // Priority 1: Error detection (always active, even in learning mode)
    const thresholds = this.getServiceThresholds(config, service.name);
    const errorCandidates = await this.detectErrors(
      metrics,
      logs,
      thresholds,
      service,
    );
    const filteredErrors = errorCandidates.filter(
      (c) => !this.filterFalsePositive(c, config, new Date()).filtered,
    );
    observations.push(...filteredErrors);

    // Priority 2: Anomaly detection (Phase 2+, requires baseline, not in learning mode)
    if (!baseline.learning_mode) {
      for (const metric of BASELINE_METRICS) {
        const currentValue = getCurrentMetricValue(metrics, metric);
        if (currentValue === null) continue;

        const baselineMetric = baseline.metrics[metric];
        if (!baselineMetric) continue;

        const anomaly = this.detectAnomaly(
          metric,
          currentValue,
          baselineMetric,
          config.anomaly_detection.sensitivity,
          previousRunState.anomalyFlags[metric] ?? 0,
        );

        if (
          anomaly.detected &&
          anomaly.consecutive_runs >= config.anomaly_detection.consecutive_runs_required
        ) {
          observations.push(anomalyToCandidate(anomaly, service));
        }
      }
    } else {
      skipped.push('anomaly_detection (learning_mode)');
    }

    // Priority 3: Trend analysis (Phase 2+, requires baseline, not in learning mode)
    if (!baseline.learning_mode) {
      for (const metric of BASELINE_METRICS) {
        const baselineMetric = baseline.metrics[metric];
        if (!baselineMetric) continue;

        for (const window of config.trend_analysis.windows) {
          const trend = await this.analyzeTrend(
            metric,
            window,
            service,
            baselineMetric,
            config,
          );
          if (trend.detected) {
            observations.push(trendToCandidate(trend, service));
          }
        }
      }
    } else {
      skipped.push('trend_analysis (learning_mode)');
    }

    // Priority 4: Feature adoption (Phase 2+, not in learning mode)
    if (!baseline.learning_mode) {
      const adoption = await this.trackAdoption(service, config);
      if (adoption?.detected) {
        observations.push(adoptionToCandidate(adoption, service));
      }
    } else {
      skipped.push('feature_adoption (learning_mode)');
    }

    return { observations, skipped_phases: skipped };
  }
}
