/**
 * Threshold-based error detection engine (SPEC-007-3-1, Tasks 1 & 2).
 *
 * Compares current metrics against configured thresholds with sustained
 * duration validation and detects five error types:
 *   1. Crash (process down / restarts)
 *   2. Exception (unhandled exceptions in logs)
 *   3. Timeout (p99 latency exceeding SLA)
 *   4. Degraded performance (p95 > 2x baseline)
 *   5. Data inconsistency (HTTP 422/400 rate spike)
 *
 * Plus the primary error rate threshold check with sustained duration.
 */

import type { ServiceConfig, ThresholdConfig } from '../config/intelligence-config.schema';
import type {
  PrometheusResult,
  PrometheusRangeResult,
  OpenSearchResult,
} from '../adapters/types';
import type {
  CandidateObservation,
  BaselineMetrics,
} from './types';

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

/** Default exception count threshold if not configured. */
const DEFAULT_EXCEPTION_COUNT_THRESHOLD = 10;

/** Default multiplier for data inconsistency baseline comparison. */
const DEFAULT_DATA_INCONSISTENCY_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Counts the number of data points whose value strictly exceeds the
 * threshold. Each data point represents 1 minute (step=60s).
 */
export function countMinutesAboveThreshold(
  dataPoints: Array<{ timestamp: string; value: number }>,
  threshold: number,
): number {
  return dataPoints.filter((dp) => dp.value > threshold).length;
}

/**
 * Extracts the top N log sample messages from OpenSearch results.
 * Deduplicates by message content and returns up to `limit` unique samples.
 */
export function extractTopLogSamples(
  logs: OpenSearchResult[],
  limit: number = 5,
): string[] {
  const seen = new Set<string>();
  const samples: string[] = [];

  for (const logResult of logs) {
    for (const hit of logResult.hits) {
      if (hit.message && !seen.has(hit.message)) {
        seen.add(hit.message);
        samples.push(hit.message);
        if (samples.length >= limit) return samples;
      }
    }
  }

  return samples;
}

// ---------------------------------------------------------------------------
// Sustained error rate query delegate
// ---------------------------------------------------------------------------

/**
 * Function type for querying sustained error rate range data.
 * Injected as a dependency so the detector does not directly call MCP.
 */
export type QuerySustainedErrorRateFn = (
  service: ServiceConfig,
  durationMinutes: number,
) => Promise<PrometheusRangeResult>;

// ---------------------------------------------------------------------------
// Error Detector
// ---------------------------------------------------------------------------

export interface ErrorDetectorOptions {
  /** Function to query sustained error rate range data from Prometheus. */
  querySustainedErrorRate: QuerySustainedErrorRateFn;

  /** Exception count threshold (default 10). */
  exceptionCountThreshold?: number;

  /** Multiplier for data inconsistency baseline comparison (default 3). */
  dataInconsistencyMultiplier?: number;
}

/**
 * Deterministic error detection engine.
 *
 * Compares metrics/logs against thresholds and baselines to produce
 * candidate observations. No LLM calls -- purely threshold-based.
 */
export class ErrorDetector {
  private readonly querySustainedErrorRate: QuerySustainedErrorRateFn;
  private readonly exceptionCountThreshold: number;
  private readonly dataInconsistencyMultiplier: number;

  constructor(options: ErrorDetectorOptions) {
    this.querySustainedErrorRate = options.querySustainedErrorRate;
    this.exceptionCountThreshold =
      options.exceptionCountThreshold ?? DEFAULT_EXCEPTION_COUNT_THRESHOLD;
    this.dataInconsistencyMultiplier =
      options.dataInconsistencyMultiplier ?? DEFAULT_DATA_INCONSISTENCY_MULTIPLIER;
  }

  // -------------------------------------------------------------------------
  // Main entry point
  // -------------------------------------------------------------------------

  /**
   * Runs all detection checks and returns candidate observations.
   *
   * @param metrics    Prometheus instant query results for the service
   * @param logs       OpenSearch log query results (scrubbed)
   * @param thresholds Effective thresholds for this service
   * @param service    Service configuration
   * @param baseline   Optional baseline metrics for degraded/data-inconsistency checks
   * @returns Array of candidate observations
   */
  async detectErrors(
    metrics: PrometheusResult[],
    logs: OpenSearchResult[],
    thresholds: ThresholdConfig,
    service: ServiceConfig,
    baseline?: BaselineMetrics,
  ): Promise<CandidateObservation[]> {
    const candidates: CandidateObservation[] = [];

    // 1. Error rate threshold check (with sustained duration)
    const errorRateCandidate = await this.detectErrorRate(
      metrics,
      logs,
      thresholds,
      service,
    );
    if (errorRateCandidate) {
      candidates.push(errorRateCandidate);
    }

    // 2. Crash detection
    const crashCandidate = this.detectCrash(metrics, service);
    if (crashCandidate) {
      candidates.push(crashCandidate);
    }

    // 3. Exception detection
    const exceptionCandidates = this.detectExceptions(logs, service);
    candidates.push(...exceptionCandidates);

    // 4. Timeout detection
    const timeoutCandidate = this.detectTimeout(metrics, thresholds, service);
    if (timeoutCandidate) {
      candidates.push(timeoutCandidate);
    }

    // 5. Degraded performance detection
    if (baseline) {
      const degradedCandidate = this.detectDegradedPerformance(
        metrics,
        baseline,
        service,
      );
      if (degradedCandidate) {
        candidates.push(degradedCandidate);
      }

      // 6. Data inconsistency detection
      const dataCandidate = this.detectDataInconsistency(
        metrics,
        baseline,
        service,
      );
      if (dataCandidate) {
        candidates.push(dataCandidate);
      }
    }

    return candidates;
  }

  // -------------------------------------------------------------------------
  // Task 1: Error rate threshold check
  // -------------------------------------------------------------------------

  /**
   * Checks if the current error rate exceeds the configured threshold
   * and validates that the elevated rate has been sustained.
   *
   * Uses strict greater-than comparison (> threshold, not >=).
   */
  private async detectErrorRate(
    metrics: PrometheusResult[],
    logs: OpenSearchResult[],
    thresholds: ThresholdConfig,
    service: ServiceConfig,
  ): Promise<CandidateObservation | null> {
    const errorRateResult = metrics.find((m) => m.query_name === 'error_rate');
    if (!errorRateResult || errorRateResult.value === null) {
      return null;
    }

    const currentRate = errorRateResult.value;
    if (currentRate <= thresholds.error_rate_percent) {
      return null;
    }

    // Sustained duration check
    const rangeResult = await this.querySustainedErrorRate(
      service,
      thresholds.sustained_duration_minutes,
    );
    const minutesAbove = countMinutesAboveThreshold(
      rangeResult.data_points,
      thresholds.error_rate_percent,
    );

    if (minutesAbove < thresholds.sustained_duration_minutes) {
      return null;
    }

    return {
      type: 'error',
      error_type: 'error_rate',
      service: service.name,
      metric_value: currentRate,
      threshold_value: thresholds.error_rate_percent,
      sustained_minutes: minutesAbove,
      log_samples: extractTopLogSamples(logs, 5),
      data_sources_used: ['prometheus', 'opensearch'],
      has_data_loss_indicator: false,
      has_data_corruption_indicator: false,
    };
  }

  // -------------------------------------------------------------------------
  // Task 2: Additional error type detectors
  // -------------------------------------------------------------------------

  /**
   * Crash detection: checks for service down (up == 0) or restarts
   * (changes(up) > 0).
   */
  detectCrash(
    metrics: PrometheusResult[],
    service: ServiceConfig,
  ): CandidateObservation | null {
    // Check 1: up == 0 (currently down)
    const upResult = metrics.find((m) => m.query_name === 'crash_down');
    if (upResult && upResult.value === 0) {
      return {
        type: 'error',
        error_type: 'crash',
        service: service.name,
        metric_value: 0,
        threshold_value: 1,
        sustained_minutes: 0,
        log_samples: [],
        data_sources_used: ['prometheus'],
        has_data_loss_indicator: false,
        has_data_corruption_indicator: false,
      };
    }

    // Check 2: changes(up) > 0 (restarts detected)
    const restartResult = metrics.find((m) => m.query_name === 'crash_restarts');
    if (restartResult && restartResult.value !== null && restartResult.value > 0) {
      return {
        type: 'error',
        error_type: 'crash',
        service: service.name,
        metric_value: restartResult.value,
        threshold_value: 0,
        sustained_minutes: 60,
        log_samples: [],
        data_sources_used: ['prometheus'],
        has_data_loss_indicator: false,
        has_data_corruption_indicator: false,
      };
    }

    return null;
  }

  /**
   * Exception detection: finds unhandled exceptions in OpenSearch logs
   * grouped by exception class with a configurable count threshold.
   */
  detectExceptions(
    logs: OpenSearchResult[],
    service: ServiceConfig,
  ): CandidateObservation[] {
    const candidates: CandidateObservation[] = [];

    for (const logResult of logs) {
      if (logResult.aggregations?.error_messages) {
        for (const bucket of logResult.aggregations.error_messages) {
          if (bucket.doc_count > this.exceptionCountThreshold) {
            candidates.push({
              type: 'error',
              error_type: 'exception',
              service: service.name,
              error_class: bucket.key,
              metric_value: bucket.doc_count,
              threshold_value: this.exceptionCountThreshold,
              sustained_minutes: 0,
              log_samples: logResult.hits
                .filter(
                  (h) =>
                    h.message.includes(bucket.key) ||
                    h.message === bucket.key,
                )
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

    return candidates;
  }

  /**
   * Timeout detection: checks if p99 latency exceeds the SLA threshold.
   */
  detectTimeout(
    metrics: PrometheusResult[],
    thresholds: ThresholdConfig,
    service: ServiceConfig,
  ): CandidateObservation | null {
    const p99 = metrics.find((m) => m.query_name === 'latency_p99');
    if (p99 && p99.value !== null && p99.value > thresholds.p99_latency_ms) {
      return {
        type: 'error',
        error_type: 'timeout',
        service: service.name,
        metric_value: p99.value,
        threshold_value: thresholds.p99_latency_ms,
        sustained_minutes: 0,
        log_samples: [],
        data_sources_used: ['prometheus'],
        has_data_loss_indicator: false,
        has_data_corruption_indicator: false,
      };
    }
    return null;
  }

  /**
   * Degraded performance detection: checks if p95 latency exceeds
   * 2x the baseline mean (7-day window).
   */
  detectDegradedPerformance(
    metrics: PrometheusResult[],
    baseline: BaselineMetrics,
    service: ServiceConfig,
  ): CandidateObservation | null {
    const p95 = metrics.find((m) => m.query_name === 'latency_p95');
    if (p95 && p95.value !== null && baseline.metrics.latency_p95_ms) {
      const baselineP95 = baseline.metrics.latency_p95_ms.mean_7d;
      if (p95.value > 2 * baselineP95) {
        return {
          type: 'error',
          error_type: 'degraded_performance',
          service: service.name,
          metric_value: p95.value,
          threshold_value: 2 * baselineP95,
          sustained_minutes: 0,
          log_samples: [],
          data_sources_used: ['prometheus'],
          has_data_loss_indicator: false,
          has_data_corruption_indicator: false,
        };
      }
    }
    return null;
  }

  /**
   * Data inconsistency detection: checks if HTTP 422/400 error rate
   * exceeds N times the baseline (configurable multiplier, default 3x).
   *
   * Sets `has_data_corruption_indicator = true` for HTTP 422 errors.
   */
  detectDataInconsistency(
    metrics: PrometheusResult[],
    baseline: BaselineMetrics,
    service: ServiceConfig,
  ): CandidateObservation | null {
    const clientErrorRate = metrics.find(
      (m) => m.query_name === 'client_error_rate_4xx',
    );
    if (
      clientErrorRate &&
      clientErrorRate.value !== null &&
      baseline.metrics.client_error_rate
    ) {
      const baselineRate = baseline.metrics.client_error_rate.mean_7d;
      const threshold = this.dataInconsistencyMultiplier * baselineRate;

      if (clientErrorRate.value > threshold) {
        // Check for 422-specific metric to flag data corruption
        const http422 = metrics.find(
          (m) => m.query_name === 'client_error_rate_422',
        );
        const hasCorruption =
          http422 !== undefined &&
          http422.value !== null &&
          http422.value > 0;

        return {
          type: 'error',
          error_type: 'data_inconsistency',
          service: service.name,
          metric_value: clientErrorRate.value,
          threshold_value: threshold,
          sustained_minutes: 0,
          log_samples: [],
          data_sources_used: ['prometheus'],
          has_data_loss_indicator: false,
          has_data_corruption_indicator: hasCorruption,
        };
      }
    }
    return null;
  }
}
