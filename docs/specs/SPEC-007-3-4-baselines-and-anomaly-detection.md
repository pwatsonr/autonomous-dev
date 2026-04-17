# SPEC-007-3-4: Baseline Management, Anomaly Detection & Trend Analysis

## Metadata
- **Parent Plan**: PLAN-007-3
- **Tasks Covered**: Task 9 (baseline management), Task 10 (anomaly detection), Task 11 (trend analysis)
- **Estimated effort**: 14 hours

## Description

Implement the per-service baseline storage with EWMA update algorithm and learning mode lifecycle, the z-score and IQR anomaly detection methods with configurable sensitivity, and the linear regression trend analysis over 7d/14d/30d windows that extrapolates days-to-threshold-breach. These are Phase 2+ capabilities but their foundation is built in Phase 1.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/engine/baseline.ts` | Create | Baseline storage, EWMA update, learning mode lifecycle |
| `src/engine/anomaly-detector.ts` | Create | Z-score and IQR anomaly detection |
| `src/engine/trend-analyzer.ts` | Create | Linear regression slope over configurable windows |
| `tests/engine/baseline.test.ts` | Create | EWMA convergence and learning mode tests |
| `tests/engine/anomaly-detector.test.ts` | Create | Z-score and IQR method tests |
| `tests/engine/trend-analyzer.test.ts` | Create | Slope computation and extrapolation tests |

## Implementation Details

### Task 9: Baseline Management

**Baseline file schema** (`.autonomous-dev/baselines/<service>.json`):

```typescript
interface BaselineMetrics {
  service: string;
  learning_mode: boolean;
  learning_started: string;        // ISO 8601
  learning_completed: string | null;
  last_updated: string;            // ISO 8601
  observation_run_count: number;   // Tracks runs during learning mode
  metrics: Record<string, MetricBaseline>;
}

interface MetricBaseline {
  mean_7d: number;
  stddev_7d: number;
  mean_14d: number;
  stddev_14d: number;
  mean_30d: number;
  stddev_30d: number;
  p50: number;
  p95: number;
  p99: number;
}

const BASELINE_METRICS = [
  'error_rate',
  'latency_p50_ms',
  'latency_p95_ms',
  'latency_p99_ms',
  'throughput_rps',
  'availability',
];
```

**EWMA update algorithm** (alpha = 0.1):

```typescript
function updateBaseline(baseline: BaselineMetrics, currentValues: Record<string, number>): void {
  const ALPHA = 0.1;

  for (const metric of BASELINE_METRICS) {
    const newValue = currentValues[metric];
    if (newValue === undefined || newValue === null) continue;

    const b = baseline.metrics[metric];
    if (!b) {
      // First observation: initialize directly
      baseline.metrics[metric] = {
        mean_7d: newValue,
        stddev_7d: 0,
        mean_14d: newValue,
        stddev_14d: 0,
        mean_30d: newValue,
        stddev_30d: 0,
        p50: newValue,
        p95: newValue,
        p99: newValue,
      };
      continue;
    }

    // EWMA update for 7d rolling:
    // mean = (1 - alpha) * mean + alpha * new_value
    b.mean_7d = (1 - ALPHA) * b.mean_7d + ALPHA * newValue;

    // Standard deviation update:
    // stddev = sqrt((1 - alpha) * stddev^2 + alpha * (new_value - mean)^2)
    b.stddev_7d = Math.sqrt(
      (1 - ALPHA) * b.stddev_7d ** 2 + ALPHA * (newValue - b.mean_7d) ** 2
    );

    // 14d and 30d: query Prometheus directly (not EWMA)
    // These are updated by separate Prometheus queries:
    //   avg_over_time(...[14d:]) and stddev_over_time(...[14d:])
    //   avg_over_time(...[30d:]) and stddev_over_time(...[30d:])
  }

  baseline.last_updated = new Date().toISOString();
  baseline.observation_run_count++;
}
```

**Learning mode lifecycle**:

```typescript
function checkLearningMode(baseline: BaselineMetrics): boolean {
  if (!baseline.learning_mode) return false;

  const learningStart = new Date(baseline.learning_started);
  const now = new Date();
  const daysSinceLearningStart = (now.getTime() - learningStart.getTime()) / (24 * 60 * 60 * 1000);

  // Exit learning mode when BOTH conditions met:
  // 1. At least 7 days since learning started
  // 2. At least 6 observation runs completed
  if (daysSinceLearningStart >= 7 && baseline.observation_run_count >= 6) {
    baseline.learning_mode = false;
    baseline.learning_completed = now.toISOString();
    return false; // No longer in learning mode
  }

  return true; // Still in learning mode
}
```

During learning mode:
- Metrics ARE collected and baselines ARE updated
- Threshold-based error detection (SPEC-007-3-1) remains active
- Anomaly detection observations are NOT generated
- Trend analysis observations are NOT generated

### Task 10: Anomaly Detection

Two methods, configured via `intelligence.yaml`.

**Z-score method** (default):

```typescript
interface AnomalyResult {
  detected: boolean;
  method: 'zscore' | 'iqr';
  metric: string;
  current_value: number;
  baseline_mean: number;
  baseline_stddev: number;
  z_score?: number;
  direction: 'above' | 'below';
  is_bad_direction: boolean;
  consecutive_runs: number;   // Must be >= 2 to generate observation
}

function detectAnomalyZScore(
  metric: string,
  currentValue: number,
  baseline: MetricBaseline,
  sensitivity: number = 2.5,
  previousRunAnomaly: boolean = false
): AnomalyResult {
  if (baseline.stddev_7d === 0) {
    return { detected: false, /* ... */ };
  }

  const z = (currentValue - baseline.mean_7d) / baseline.stddev_7d;
  const direction = z > 0 ? 'above' : 'below';

  // Determine if this direction is "bad"
  const isBad = isBadDirection(metric, direction);

  const detected = Math.abs(z) > sensitivity && isBad;

  return {
    detected,
    method: 'zscore',
    metric,
    current_value: currentValue,
    baseline_mean: baseline.mean_7d,
    baseline_stddev: baseline.stddev_7d,
    z_score: z,
    direction,
    is_bad_direction: isBad,
    consecutive_runs: detected && previousRunAnomaly ? 2 : detected ? 1 : 0,
  };
}

function isBadDirection(metric: string, direction: string): boolean {
  // Increased error rate = bad
  // Increased latency = bad
  // Decreased throughput = bad
  // Decreased availability = bad
  const badIfAbove = ['error_rate', 'latency_p50_ms', 'latency_p95_ms', 'latency_p99_ms'];
  const badIfBelow = ['throughput_rps', 'availability'];

  if (badIfAbove.includes(metric)) return direction === 'above';
  if (badIfBelow.includes(metric)) return direction === 'below';
  return false;
}
```

**IQR method** (alternative):

```typescript
function detectAnomalyIQR(
  metric: string,
  currentValue: number,
  baseline: MetricBaseline,
  previousRunAnomaly: boolean = false
): AnomalyResult {
  const q1 = baseline.p50 - 0.675 * baseline.stddev_7d; // Approximate Q1
  const q3 = baseline.p50 + 0.675 * baseline.stddev_7d; // Approximate Q3
  // Better: use actual p25 and p75 if available in baseline
  const iqr = q3 - q1;
  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  const isOutside = currentValue < lowerBound || currentValue > upperBound;
  const direction = currentValue > upperBound ? 'above' : 'below';
  const isBad = isBadDirection(metric, direction);

  return {
    detected: isOutside && isBad,
    method: 'iqr',
    metric,
    current_value: currentValue,
    baseline_mean: baseline.mean_7d,
    baseline_stddev: baseline.stddev_7d,
    direction,
    is_bad_direction: isBad,
    consecutive_runs: isOutside && isBad && previousRunAnomaly ? 2 : 1,
  };
}
```

**Anomaly observation generation rules**:
1. Service is NOT in learning mode
2. Anomaly persists across 2 consecutive observation runs
3. Deviation is in a "bad" direction

### Task 11: Trend Analysis

Linear regression slope computation over configurable windows.

```typescript
interface TrendResult {
  detected: boolean;
  metric: string;
  window: string;          // "7d" | "14d" | "30d"
  slope: number;           // Raw slope per hour
  pct_change: number;      // Percentage change per window relative to baseline mean
  direction: 'degrading' | 'improving' | 'stable';
  days_to_breach?: number; // Extrapolated days until threshold is breached
}

function linearRegressionSlope(dataPoints: Array<{ x: number; y: number }>): number {
  const n = dataPoints.length;
  if (n < 2) return 0;

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const { x, y } of dataPoints) {
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumX2 += x * x;
  }

  const denominator = n * sumX2 - sumX * sumX;
  if (denominator === 0) return 0;

  return (n * sumXY - sumX * sumY) / denominator;
}

async function analyzeTrend(
  metric: string,
  window: string,
  prometheusAdapter: PrometheusAdapter,
  service: ServiceConfig,
  baseline: MetricBaseline,
  config: IntelligenceConfig
): Promise<TrendResult> {
  // Query Prometheus for hourly data points over the window
  const windowHours = parseWindowToHours(window); // 7d=168h, 14d=336h, 30d=720h
  const dataPoints = await prometheusAdapter.queryRange(
    service,
    metric,
    windowHours,
    '1h' // step
  );

  // Convert to x,y pairs (x=hour index, y=metric value)
  const xyPoints = dataPoints.map((dp, i) => ({ x: i, y: dp.value }));
  const slope = linearRegressionSlope(xyPoints);

  // Normalize slope as percentage change per window relative to baseline mean
  const baselineMean = baseline.mean_7d;
  if (baselineMean === 0) return { detected: false, metric, window, slope, pct_change: 0, direction: 'stable' };

  const pctChange = (slope * windowHours) / baselineMean * 100;
  const minThreshold = config.trend_analysis.min_slope_threshold; // Default 5%

  // Determine direction
  const isDegrading = isBadDirection(metric, pctChange > 0 ? 'above' : 'below') && Math.abs(pctChange) > minThreshold;

  let daysToBreachEstimate: number | undefined;
  if (isDegrading && slope !== 0) {
    // Extrapolate: how many hours until the metric reaches the threshold?
    const threshold = getThresholdForMetric(metric, config);
    if (threshold !== null) {
      const currentValue = dataPoints[dataPoints.length - 1]?.value ?? baselineMean;
      const hoursToBreach = (threshold - currentValue) / slope;
      daysToBreachEstimate = hoursToBreach > 0 ? Math.round(hoursToBreach / 24) : undefined;
    }
  }

  return {
    detected: isDegrading,
    metric,
    window,
    slope,
    pct_change: pctChange,
    direction: isDegrading ? 'degrading' : Math.abs(pctChange) > minThreshold ? 'improving' : 'stable',
    days_to_breach: daysToBreachEstimate,
  };
}

function parseWindowToHours(window: string): number {
  const match = window.match(/^(\d+)d$/);
  if (match) return parseInt(match[1]) * 24;
  throw new Error(`Invalid window format: ${window}`);
}
```

## Acceptance Criteria

1. Baseline files at `.autonomous-dev/baselines/<service>.json` match the schema from TDD section 4.2.
2. EWMA update uses alpha=0.1: `mean = 0.9 * mean + 0.1 * new_value`.
3. Standard deviation updated: `stddev = sqrt(0.9 * stddev^2 + 0.1 * (new_value - mean)^2)`.
4. 14d and 30d windows query Prometheus `avg_over_time`/`stddev_over_time` directly.
5. Learning mode active for first 7 days AND minimum 6 observation runs.
6. During learning mode, metrics collected but no anomaly/trend observations generated. Threshold-based error detection remains active.
7. Z-score anomaly: `z = (current - mean) / stddev`, flags when `|z| > sensitivity` (default 2.5).
8. IQR anomaly: flags outside `Q1 - 1.5*IQR` to `Q3 + 1.5*IQR` bounds.
9. Anomalies only generated when: not in learning mode, persists across 2 consecutive runs, deviation in bad direction.
10. Linear regression slope computed over hourly data points for each window.
11. Percentage change normalized relative to baseline mean.
12. Trend observation generated when `|pct_change| > min_slope_threshold` (default 5%) and direction is degrading.
13. Days-to-breach estimate computed by extrapolation from current slope.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-3-4-01 | EWMA convergence | 10 updates with constant value=100, initial mean=50 | Mean converges toward 100 |
| TC-3-4-02 | EWMA single update | mean=10.0, new_value=20.0 | new_mean = 0.9*10 + 0.1*20 = 11.0 |
| TC-3-4-03 | Stddev update | stddev=2.0, new_value deviates by 5 | Stddev increases appropriately |
| TC-3-4-04 | Learning mode: 5 days, 8 runs | 5 days, 8 runs | Still learning (< 7 days) |
| TC-3-4-05 | Learning mode: 8 days, 4 runs | 8 days, 4 runs | Still learning (< 6 runs) |
| TC-3-4-06 | Learning mode: 8 days, 7 runs | 8 days, 7 runs | Learning complete, `learning_mode: false` |
| TC-3-4-07 | Z-score anomaly flagged | z=3.2, sensitivity=2.5, bad direction | `detected: true` |
| TC-3-4-08 | Z-score below threshold | z=2.0, sensitivity=2.5 | `detected: false` |
| TC-3-4-09 | Z-score good direction | z=-3.0 on error_rate (below=good) | `detected: false` (improving, not degrading) |
| TC-3-4-10 | Z-score zero stddev | stddev=0.0 | `detected: false` (avoid division by zero) |
| TC-3-4-11 | IQR outside upper bound | current=100, Q3+1.5*IQR=80 | Flagged above upper bound |
| TC-3-4-12 | IQR within bounds | current=50, bounds=[20, 80] | Not flagged |
| TC-3-4-13 | Consecutive run requirement | Anomaly in run 1 only | Not generated (need 2 consecutive) |
| TC-3-4-14 | Consecutive run met | Anomaly in run 1 and run 2 | Generated on run 2 |
| TC-3-4-15 | Trend: positive slope on error | 7d error rate rising 8% | `detected: true`, `direction: 'degrading'` |
| TC-3-4-16 | Trend: below threshold | 7d error rate rising 3% (threshold 5%) | `detected: false`, `direction: 'stable'` |
| TC-3-4-17 | Trend: improving direction | 7d latency decreasing 10% | `detected: false`, `direction: 'improving'` |
| TC-3-4-18 | Days to breach | Slope=+0.1%/hr, current=3%, threshold=5% | ~(2/0.1)/24 = ~0.83 days |
| TC-3-4-19 | Linear regression slope | Points: [(0,1),(1,2),(2,3)] | Slope = 1.0 |
| TC-3-4-20 | Learning mode: no anomaly obs | Service in learning, z=5.0 | No anomaly observation generated |
