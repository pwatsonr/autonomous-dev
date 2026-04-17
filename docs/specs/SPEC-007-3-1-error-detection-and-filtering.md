# SPEC-007-3-1: Error Detection & False Positive Filtering

## Metadata
- **Parent Plan**: PLAN-007-3
- **Tasks Covered**: Task 1 (threshold-based error detection), Task 2 (additional error type detectors), Task 3 (false positive filtering)
- **Estimated effort**: 16 hours

## Description

Build the deterministic error detection layer that compares current metrics against configured thresholds with sustained duration validation, detects five error types (crash, exception, timeout, degraded performance, data inconsistency), and filters candidates through a false-positive chain (maintenance windows, excluded patterns, load test markers) before they reach the LLM classification step.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/error-detector.ts` | Create | Threshold-based detection + 5 error type detectors |
| `src/engine/false-positive-filter.ts` | Create | Maintenance window, excluded pattern, load test marker filters |
| `src/engine/types.ts` | Create | `CandidateObservation`, `ErrorType`, `FilterResult` types |
| `tests/engine/error-detector.test.ts` | Create | Detection tests with boundary conditions |
| `tests/engine/false-positive-filter.test.ts` | Create | Filter chain tests |

## Implementation Details

### Task 1: Threshold-Based Error Detection

The detector compares current error rate against configured thresholds and validates that the elevated rate has been sustained.

```typescript
type ErrorType = 'crash' | 'exception' | 'timeout' | 'degraded_performance' | 'data_inconsistency' | 'error_rate';

interface CandidateObservation {
  type: 'error' | 'anomaly' | 'trend' | 'adoption';
  error_type?: ErrorType;
  service: string;
  metric_value: number;
  threshold_value: number;
  sustained_minutes: number;
  endpoint?: string;
  error_class?: string;
  log_samples: string[];
  request_metadata?: Record<string, any>;
  has_data_loss_indicator: boolean;
  has_data_corruption_indicator: boolean;
  data_sources_used: string[];
}

async function detectErrors(
  metrics: PrometheusResult[],
  logs: ScrubbedOpenSearchResult[],
  thresholds: ThresholdConfig,
  service: ServiceConfig
): Promise<CandidateObservation[]> {
  const candidates: CandidateObservation[] = [];

  // 1. Error rate threshold check
  const errorRateResult = metrics.find(m => m.query_name === 'error_rate');
  if (errorRateResult && errorRateResult.value !== null) {
    const currentRate = errorRateResult.value;
    if (currentRate > thresholds.error_rate_percent) {
      // Sustained duration check: query range data at 1-minute resolution
      const rangeResult = await querySustainedErrorRate(service, thresholds.sustained_duration_minutes);
      const minutesAbove = countMinutesAboveThreshold(
        rangeResult.data_points,
        thresholds.error_rate_percent
      );

      if (minutesAbove >= thresholds.sustained_duration_minutes) {
        candidates.push({
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
        });
      }
    }
  }

  return candidates;
}

function countMinutesAboveThreshold(
  dataPoints: Array<{ timestamp: string; value: number }>,
  threshold: number
): number {
  return dataPoints.filter(dp => dp.value > threshold).length;
  // Each data point represents 1 minute (step=60s in range query)
}
```

### Task 2: Additional Error Type Detectors

Five additional detection methods beyond the primary error rate check:

```typescript
// Crash detection: process termination or restart
async function detectCrash(metrics: PrometheusResult[], service: ServiceConfig): Promise<CandidateObservation | null> {
  // Check 1: up == 0 (currently down)
  // PromQL: up{job="<job>"} == 0
  const upResult = metrics.find(m => m.query_name === 'crash_down');
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
  // PromQL: changes(up{job="<job>"}[1h]) > 0
  const restartResult = metrics.find(m => m.query_name === 'crash_restarts');
  if (restartResult && restartResult.value !== null && restartResult.value > 0) {
    return {
      type: 'error',
      error_type: 'crash',
      service: service.name,
      metric_value: restartResult.value,
      threshold_value: 0,
      sustained_minutes: 60, // 1h window
      log_samples: [],
      data_sources_used: ['prometheus'],
      has_data_loss_indicator: false,
      has_data_corruption_indicator: false,
    };
  }

  return null;
}

// Exception detection: unhandled exceptions in logs
async function detectExceptions(
  logs: ScrubbedOpenSearchResult[],
  service: ServiceConfig
): Promise<CandidateObservation[]> {
  // OpenSearch aggregation: count of level:ERROR grouped by exception class
  const candidates: CandidateObservation[] = [];
  for (const logResult of logs) {
    if (logResult.aggregations?.error_messages) {
      for (const bucket of logResult.aggregations.error_messages) {
        if (bucket.doc_count > 10) { // Configurable threshold
          candidates.push({
            type: 'error',
            error_type: 'exception',
            service: service.name,
            error_class: bucket.key,
            metric_value: bucket.doc_count,
            threshold_value: 10,
            sustained_minutes: 0,
            log_samples: logResult.hits
              .filter(h => h.message.includes(bucket.key) || h.message === bucket.key)
              .slice(0, 3)
              .map(h => h.message),
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

// Timeout detection: p99 latency exceeding SLA
async function detectTimeout(
  metrics: PrometheusResult[],
  thresholds: ThresholdConfig,
  service: ServiceConfig
): Promise<CandidateObservation | null> {
  // histogram_quantile(0.99, ...) > sla_threshold
  const p99 = metrics.find(m => m.query_name === 'latency_p99');
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

// Degraded performance: p95 exceeds 2x baseline
async function detectDegradedPerformance(
  metrics: PrometheusResult[],
  baseline: BaselineMetrics,
  service: ServiceConfig
): Promise<CandidateObservation | null> {
  const p95 = metrics.find(m => m.query_name === 'latency_p95');
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

// Data inconsistency: HTTP 422/400 rate spike
async function detectDataInconsistency(
  metrics: PrometheusResult[],
  baseline: BaselineMetrics,
  service: ServiceConfig
): Promise<CandidateObservation | null> {
  // Query: rate of 4xx (specifically 400, 422) errors
  // Flag if rate is > 3x baseline (configurable)
  // has_data_corruption_indicator = true for 422s
}
```

### Task 3: False Positive Filtering

The filter chain runs BEFORE any LLM classification to save tokens. Each filter returns a reason if the candidate is filtered.

```typescript
interface FilterResult {
  filtered: boolean;
  reason?: string;
}

function isFalsePositive(
  candidate: CandidateObservation,
  config: IntelligenceConfig,
  currentTime: Date
): FilterResult {
  // Check 1: Maintenance windows
  for (const window of config.false_positive_filters.maintenance_windows) {
    // window format: { start: "HH:MM", end: "HH:MM", days: ["SAT", "SUN"], timezone: "UTC" }
    // Or: { start: "2026-04-10T02:00:00Z", end: "2026-04-10T06:00:00Z" } (one-time)
    if (isWithinMaintenanceWindow(currentTime, window)) {
      return { filtered: true, reason: `maintenance_window: ${window.start}-${window.end}` };
    }
  }

  // Check 2: Excluded error patterns (regex match against log samples)
  for (const pattern of config.false_positive_filters.excluded_error_patterns) {
    const regex = new RegExp(pattern);
    if (candidate.log_samples.some(line => regex.test(line))) {
      return { filtered: true, reason: `excluded_pattern: ${pattern}` };
    }
  }

  // Check 3: Load test markers (check request metadata)
  for (const marker of config.false_positive_filters.load_test_markers) {
    // marker format: { header: "X-Load-Test", value: "true" }
    // or: { tag: "load-test" }
    if (candidate.request_metadata && hasLoadTestMarker(candidate.request_metadata, marker)) {
      return { filtered: true, reason: 'load_test_traffic' };
    }
  }

  return { filtered: false };
}
```

**Filtered candidates**: Logged with the filter reason and excluded from further processing. The filter count is included in run metadata as `observations_filtered`.

## Acceptance Criteria

1. Error rate threshold check compares current rate against `config.error_detection.default_thresholds.error_rate_percent` (or per-service override).
2. Sustained duration validated via range query at 1-minute resolution. Only fires when `minutes_above >= sustained_duration_minutes`.
3. Crash detection via `up == 0` (currently down) and `changes(up) > 0` (restarts in last hour).
4. Exception detection via OpenSearch aggregation of `level:ERROR` grouped by exception class with a configurable count threshold.
5. Timeout detection via p99 latency exceeding the SLA threshold (`p99_latency_ms` from config).
6. Degraded performance detection when p95 exceeds 2x the baseline mean.
7. Data inconsistency detection when HTTP 422/400 rate spikes above baseline.
8. Each detector produces a typed `CandidateObservation` with the correct `error_type`.
9. Maintenance window filter supports both recurring (day-of-week + time range) and one-time (ISO 8601 range) windows.
10. Excluded error patterns use regex matching against candidate log samples.
11. Load test marker filter checks request metadata for configured marker tags/headers.
12. Filtered candidates are logged with reason and excluded from further processing.
13. Filters run before any LLM classification to save tokens.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-3-1-01 | Error rate above threshold | Current=12.3%, threshold=5.0% | Candidate generated with `metric_value: 12.3` |
| TC-3-1-02 | Error rate below threshold | Current=3.2%, threshold=5.0% | No candidate generated |
| TC-3-1-03 | Sustained check passes | 15 of 15 minutes above threshold | Candidate with `sustained_minutes: 15` |
| TC-3-1-04 | Sustained check fails | 3 of 10 minutes above threshold | No candidate (3 < 10) |
| TC-3-1-05 | Boundary: exactly at threshold | Current=5.0%, threshold=5.0% | No candidate (must be > threshold, not >=) |
| TC-3-1-06 | Per-service override | api-gateway override=3.0%, current=4.0% | Candidate generated (4.0 > 3.0) |
| TC-3-1-07 | Crash: service down | `up` metric returns 0 | Crash candidate with `error_type: 'crash'` |
| TC-3-1-08 | Crash: restart detected | `changes(up)` returns 2 | Crash candidate with `metric_value: 2` |
| TC-3-1-09 | Exception: high count | OpenSearch agg: `ConnectionPoolExhausted: 150` | Exception candidate with `error_class` |
| TC-3-1-10 | Timeout: p99 exceeds SLA | p99=8200ms, threshold=5000ms | Timeout candidate |
| TC-3-1-11 | Degraded: p95 > 2x baseline | p95=120ms, baseline=45ms | Degraded performance candidate (120 > 90) |
| TC-3-1-12 | Degraded: p95 normal | p95=80ms, baseline=45ms | No candidate (80 < 90) |
| TC-3-1-13 | Filter: maintenance window | Current time within configured window | Filtered with reason `maintenance_window` |
| TC-3-1-14 | Filter: excluded pattern | Log sample matches `HealthCheck.*timeout` | Filtered with reason `excluded_pattern` |
| TC-3-1-15 | Filter: load test marker | Metadata has `X-Load-Test: true` | Filtered with reason `load_test_traffic` |
| TC-3-1-16 | Filter: nothing matches | No maintenance, no excluded, no load test | `filtered: false` |
