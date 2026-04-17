# SPEC-005-2-2: Dual-Write MetricsEngine and Aggregate Metrics Computation

## Metadata
- **Parent Plan**: PLAN-005-2
- **Tasks Covered**: Task 4 (Dual-write MetricsEngine), Task 5 (Aggregate metrics computation)
- **Estimated effort**: 18 hours

## Description

Implement the MetricsEngine that orchestrates the JSONL-primary, SQLite-async-secondary dual-write path for every invocation metric, and the aggregator that computes rolling 30-day window statistics, trend analysis via linear regression, and domain breakdown after each new metric is recorded. The MetricsEngine is the single entry point for all metrics operations consumed by the rest of the system.

## Files to Create/Modify

### New Files

**`src/agent-factory/metrics/engine.ts`**
- Exports: `MetricsEngine` class implementing `IMetricsEngine`

**`src/agent-factory/metrics/aggregator.ts`**
- Exports: `MetricsAggregator` class
- Exports: `linearRegression(points: number[]): TrendResult`

### Modified Files

**`src/agent-factory/metrics/types.ts`** (extend)
- Add: `IMetricsEngine`, `TrendResult`, `AggregateMetrics`

## Implementation Details

### MetricsEngine (`metrics/engine.ts`)

```typescript
interface IMetricsEngine {
  record(metric: InvocationMetric): void;
  getInvocations(agentName: string, opts?: QueryOptions): InvocationMetric[];
  getAggregate(agentName: string): AggregateMetrics | null;
  getAlerts(opts?: AlertQueryOptions): AlertRecord[];
  evaluateAnomalies(agentName: string): AlertRecord[];
}

interface QueryOptions {
  since?: string;
  until?: string;
  domain?: string;
  environment?: Environment;
  limit?: number;
}

interface AlertQueryOptions {
  agentName?: string;
  severity?: AlertSeverity;
  activeOnly?: boolean;
}
```

**`record()` flow:**

1. **JSONL write (synchronous, primary):**
   - Call `jsonlWriter.append(metric)`.
   - If this fails, throw -- the metric is lost and the caller should handle it.

2. **SQLite write (asynchronous, secondary):**
   - Call `sqliteStore.insertInvocation(metric)` in a `Promise` (fire-and-forget with error handling).
   - If SQLite write fails:
     - Push metric to in-memory buffer (`pendingBuffer: InvocationMetric[]`).
     - Buffer is bounded to 1000 records (drop oldest if full, log warning).
     - Set `sqliteAvailable = false`.
     - Log warning: "SQLite write failed, metric buffered".
   - On success: if buffer is non-empty, attempt to replay buffered records.

3. **Post-record hooks (asynchronous):**
   - Trigger aggregate recomputation for the agent.
   - Trigger anomaly evaluation for the agent.

**Buffer replay:**
- When a SQLite write succeeds and `pendingBuffer.length > 0`:
  - Attempt to insert each buffered record.
  - Remove successfully inserted records from the buffer.
  - If all replayed: set `sqliteAvailable = true`.

**`getInvocations()`**: Query SQLite store. If SQLite unavailable, fall back to JSONL reader (slower).

**`getAggregate()`**: Query latest aggregate snapshot from SQLite.

**`getAlerts()`**: Query alert table from SQLite.

### Aggregator (`metrics/aggregator.ts`)

Computes `AggregateMetrics` from per-invocation records after each new record.

```typescript
interface AggregateMetrics {
  agent_name: string;
  window_days: number;             // 30
  invocation_count: number;
  approval_rate: number;           // approved / total
  avg_quality_score: number;
  median_quality_score: number;
  stddev_quality_score: number;
  avg_review_iterations: number;
  avg_wall_clock_ms: number;
  avg_turns: number;
  total_tokens: number;
  trend: TrendResult;
  domain_breakdown: Record<string, DomainStats>;
}

interface TrendResult {
  direction: 'improving' | 'stable' | 'declining';
  slope: number;               // linear regression slope
  confidence: number;          // R-squared (0.0 - 1.0)
  sample_size: number;         // number of points used
  low_confidence: boolean;     // true if sample_size < 5
}
```

**Rolling 30-day window computation:**

1. Query all invocations for the agent within the last 30 days.
2. Compute:
   - `invocation_count`: total count
   - `approval_rate`: count where `review_outcome === 'approved'` / total count
   - `avg_quality_score`: mean of `output_quality_score`
   - `median_quality_score`: median of `output_quality_score`
   - `stddev_quality_score`: standard deviation of `output_quality_score`
   - `avg_review_iterations`: mean of `review_iteration_count`
   - `avg_wall_clock_ms`: mean of `wall_clock_ms`
   - `avg_turns`: mean of `turn_count`
   - `total_tokens`: sum of `input_tokens + output_tokens`

**Trend analysis (last 20 invocations):**

1. Take the last 20 invocations ordered by timestamp.
2. Extract `output_quality_score` as the dependent variable, sequential index (0-19) as the independent variable.
3. Compute simple linear regression:

```
slope = (N * sum(x*y) - sum(x) * sum(y)) / (N * sum(x^2) - sum(x)^2)
intercept = (sum(y) - slope * sum(x)) / N
```

4. Compute R-squared:

```
ss_res = sum((y_i - (slope * x_i + intercept))^2)
ss_tot = sum((y_i - mean(y))^2)
r_squared = 1 - (ss_res / ss_tot)
```

5. Classify direction:
   - `improving`: slope > 0.05 and r_squared > 0.3
   - `declining`: slope < -0.05 and r_squared > 0.3
   - `stable`: otherwise

6. If fewer than 5 invocations, set `low_confidence = true` and direction to `stable`.

**Domain breakdown:**

1. Group invocations by `input_domain`.
2. For each domain, compute: `invocation_count`, `approval_rate`, `avg_quality_score`.
3. Include in `domain_breakdown` map.

**Snapshot storage:**

After computing, store the aggregate as an `AggregateSnapshot` in SQLite. Snapshots are retained indefinitely (not subject to pruning).

## Acceptance Criteria

1. `record()` writes to JSONL synchronously first, then SQLite asynchronously.
2. If SQLite write fails, metric is buffered in memory (max 1000 records).
3. Buffer replay occurs automatically on next successful SQLite write.
4. Oldest buffered records dropped when buffer exceeds 1000.
5. `getInvocations()` queries SQLite, falls back to JSONL when SQLite unavailable.
6. Rolling 30-day window aggregation computes all fields correctly.
7. Trend analysis uses linear regression over last 20 invocations.
8. Trend direction classified as improving/stable/declining based on slope and R-squared.
9. Low-confidence flag set when fewer than 5 invocations available.
10. Domain breakdown groups metrics by `input_domain` with per-domain stats.
11. Aggregate snapshots stored in SQLite after each recomputation.

## Test Cases

### MetricsEngine Tests

```
test_record_writes_to_jsonl_first
  Action: record a metric
  Expected: JSONL file contains the record before SQLite is checked

test_record_writes_to_sqlite_async
  Action: record a metric, wait for async
  Expected: SQLite contains the record

test_sqlite_failure_buffers_metric
  Setup: make SQLite unavailable
  Action: record a metric
  Expected: JSONL write succeeds, metric in pendingBuffer

test_buffer_bounded_to_1000
  Setup: SQLite unavailable
  Action: record 1050 metrics
  Expected: buffer contains 1000, oldest 50 dropped, warnings logged

test_buffer_replay_on_recovery
  Setup: buffer 5 metrics while SQLite down
  Action: SQLite recovers, record a new metric
  Expected: all 5 buffered + 1 new metric in SQLite, buffer empty

test_get_invocations_from_sqlite
  Setup: record 10 metrics
  Action: getInvocations(agentName)
  Expected: returns matching records from SQLite

test_get_invocations_fallback_to_jsonl
  Setup: record metrics, then make SQLite unavailable
  Action: getInvocations(agentName)
  Expected: returns records read from JSONL file

test_record_triggers_aggregate_recomputation
  Action: record a metric
  Expected: getAggregate() returns updated snapshot
```

### Aggregator Tests

```
test_approval_rate_all_approved
  Input: 10 invocations, all review_outcome="approved"
  Expected: approval_rate = 1.0

test_approval_rate_mixed
  Input: 7 approved, 3 rejected out of 10
  Expected: approval_rate = 0.7

test_approval_rate_zero_invocations
  Input: no invocations in window
  Expected: null aggregate (cannot compute)

test_avg_quality_score
  Input: scores [3.0, 4.0, 5.0]
  Expected: avg = 4.0

test_median_quality_score_odd
  Input: scores [1.0, 3.0, 5.0]
  Expected: median = 3.0

test_median_quality_score_even
  Input: scores [2.0, 3.0, 4.0, 5.0]
  Expected: median = 3.5

test_stddev_quality_score
  Input: scores [2.0, 4.0, 4.0, 4.0, 5.0, 5.0, 7.0, 9.0]
  Expected: stddev approximately 2.0

test_trend_improving
  Input: 20 invocations with quality scores linearly increasing from 2.0 to 4.0
  Expected: direction = "improving", slope > 0.05, confidence > 0.3

test_trend_declining
  Input: 20 invocations with quality scores linearly decreasing from 4.0 to 2.0
  Expected: direction = "declining", slope < -0.05, confidence > 0.3

test_trend_stable
  Input: 20 invocations with quality scores all ~3.5 (±0.1 random)
  Expected: direction = "stable"

test_trend_low_confidence
  Input: 3 invocations
  Expected: low_confidence = true, direction = "stable"

test_domain_breakdown
  Input: 5 invocations in "typescript" domain, 3 in "python"
  Expected: breakdown has 2 entries with correct per-domain stats

test_30_day_window_excludes_old
  Input: 5 invocations at day -40, 5 at day -10
  Expected: only the recent 5 included in window

test_snapshot_stored_after_computation
  Action: compute aggregate
  Expected: aggregate_snapshots table contains new snapshot
```

### Linear Regression Tests

```
test_perfect_positive_slope
  Input: [1, 2, 3, 4, 5]
  Expected: slope = 1.0, r_squared = 1.0

test_perfect_negative_slope
  Input: [5, 4, 3, 2, 1]
  Expected: slope = -1.0, r_squared = 1.0

test_flat_line
  Input: [3, 3, 3, 3, 3]
  Expected: slope = 0.0, r_squared = undefined/NaN (handle gracefully)

test_noisy_data
  Input: [3.1, 2.9, 3.2, 2.8, 3.0]
  Expected: slope near 0, low r_squared
```
