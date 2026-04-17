# SPEC-004-4-2: Metrics Collector (Per-Gate & Per-Reviewer) & Pipeline Aggregator

## Metadata
- **Parent Plan**: PLAN-004-4
- **Tasks Covered**: Task 5, Task 6, Task 7
- **Estimated effort**: 11 hours

## Description

Build the MetricsCollector that records per-gate and per-reviewer metrics for every review gate execution, and the PipelineAggregator that computes cross-gate statistics over configurable time windows. These components provide the observability layer for understanding review gate effectiveness, reviewer calibration, and pipeline health.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/metrics/metrics-types.ts` | Create | Type definitions for metrics records |
| `src/review-gate/metrics/metrics-collector.ts` | Create | Per-gate and per-reviewer metrics recording |
| `src/review-gate/metrics/pipeline-aggregator.ts` | Create | Cross-gate aggregate statistics |
| `src/review-gate/metrics/metrics-store.ts` | Create | Abstract storage interface and filesystem implementation |

## Implementation Details

### 1. Metrics Types (`metrics/metrics-types.ts`)

```typescript
interface ReviewMetricsRecord {
  gate_id: string;
  document_id: string;
  document_type: DocumentType;
  pipeline_id: string;
  timestamp: string;               // ISO 8601

  // Gate-level metrics
  outcome: "approved" | "changes_requested" | "rejected";
  aggregate_score: number;
  iteration_count: number;
  review_duration_ms: number;
  reviewer_count: number;
  disagreement_count: number;
  stagnation_detected: boolean;
  quality_regression_detected: boolean;
  human_escalation: boolean;

  // Per-category scores
  category_scores: Record<string, number>;

  // Finding counts
  finding_counts: {
    critical: number;
    major: number;
    minor: number;
    suggestion: number;
  };

  // Per-reviewer data
  reviewer_metrics: ReviewerMetric[];
}

interface ReviewerMetric {
  reviewer_id: string;
  reviewer_role: string;
  weighted_score: number;
  score_vs_aggregate_delta: number;
  finding_count: number;
  critical_finding_count: number;
  is_outlier: boolean;               // true if deviation > 1.5x std dev from panel mean
}

interface PipelineAggregates {
  computed_at: string;                // ISO 8601
  window_start: string;
  window_end: string;
  by_document_type: Record<DocumentType, DocumentTypeAggregates>;
  overall: OverallAggregates;
}

interface DocumentTypeAggregates {
  document_type: DocumentType;
  total_gates: number;
  first_pass_rate: number;            // 0-100%
  mean_iterations_to_approval: number;
  escalation_rate: number;            // 0-100%
  mean_aggregate_score: number;
  stagnation_rate: number;            // 0-100%
  smoke_test_pass_rate: number;       // 0-100%
  backward_cascade_rate: number;      // 0-100%
  category_score_distributions: Record<string, ScoreDistribution>;
}

interface ScoreDistribution {
  category_id: string;
  min: number;
  max: number;
  mean: number;
  median: number;
  p25: number;
  p75: number;
  sample_count: number;
}

interface OverallAggregates {
  total_gates: number;
  total_approved: number;
  total_rejected: number;
  total_escalated: number;
  mean_review_duration_ms: number;
  mean_iterations: number;
}
```

### 2. Metrics Store (`metrics/metrics-store.ts`)

**Abstract interface:**
```typescript
interface MetricsStore {
  write(record: ReviewMetricsRecord): Promise<void>;
  query(filter: MetricsFilter): Promise<ReviewMetricsRecord[]>;
  count(filter: MetricsFilter): Promise<number>;
}

interface MetricsFilter {
  document_type?: DocumentType;
  pipeline_id?: string;
  from_timestamp?: string;
  to_timestamp?: string;
  outcome?: string;
  reviewer_id?: string;
}
```

**Filesystem implementation (Phase 2):**
```typescript
class FileSystemMetricsStore implements MetricsStore {
  constructor(private basePath: string)

  // Writes each record as a JSON file: {basePath}/{gate_id}.json
  // Query reads all files and filters in memory
  // Suitable for development and small deployments
}
```

**Retry logic for write failures:**
```typescript
async writeWithRetry(record: ReviewMetricsRecord, maxRetries: number = 3): Promise<void> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await this.store.write(record);
      return;
    } catch (error) {
      if (attempt === maxRetries) {
        // Log error for reconciliation, do NOT throw
        logger.error(`Metrics write failed after ${maxRetries} attempts for gate ${record.gate_id}`, error);
        return;
      }
      // Exponential backoff: 100ms, 200ms, 400ms
      await sleep(100 * Math.pow(2, attempt - 1));
    }
  }
}
```

### 3. MetricsCollector (`metrics/metrics-collector.ts`)

**Class: `MetricsCollector`**

**Constructor:**
```typescript
constructor(private store: MetricsStore)
```

**Primary method (per-gate):**
```typescript
async recordGateMetrics(
  gateRecord: ReviewGateRecord,
  executionTimeMs: number
): Promise<void>
```

**Metrics assembly:**
```typescript
function buildMetricsRecord(
  gateRecord: ReviewGateRecord,
  executionTimeMs: number
): ReviewMetricsRecord {
  return {
    gate_id: gateRecord.gate_id,
    document_id: gateRecord.document_id,
    document_type: gateRecord.document_type,
    pipeline_id: gateRecord.pipeline_id,
    timestamp: new Date().toISOString(),

    outcome: gateRecord.outcome,
    aggregate_score: gateRecord.aggregate_score,
    iteration_count: gateRecord.iteration,
    review_duration_ms: executionTimeMs,
    reviewer_count: gateRecord.reviewer_outputs.length,
    disagreement_count: gateRecord.disagreements.length,
    stagnation_detected: gateRecord.stagnation_warning,
    quality_regression_detected: gateRecord.quality_regression !== null,
    human_escalation: gateRecord.human_escalation,

    category_scores: buildCategoryScoreMap(gateRecord.category_aggregates),
    finding_counts: countFindingsBySeverity(gateRecord.merged_findings),
    reviewer_metrics: buildReviewerMetrics(
      gateRecord.reviewer_outputs,
      gateRecord.aggregate_score
    ),
  };
}
```

**Per-reviewer metrics assembly:**
```typescript
function buildReviewerMetrics(
  reviewerOutputs: ReviewOutput[],
  aggregateScore: number
): ReviewerMetric[] {
  const weightedScores = reviewerOutputs.map(r => computeWeightedScore(r));
  const mean = weightedScores.reduce((a, b) => a + b, 0) / weightedScores.length;
  const stdDev = Math.sqrt(
    weightedScores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / weightedScores.length
  );

  return reviewerOutputs.map((output, i) => {
    const weightedScore = weightedScores[i];
    const delta = weightedScore - aggregateScore;
    const deviation = stdDev > 0 ? Math.abs(weightedScore - mean) / stdDev : 0;

    return {
      reviewer_id: output.reviewer_id,
      reviewer_role: output.reviewer_role,
      weighted_score: Math.round(weightedScore * 100) / 100,
      score_vs_aggregate_delta: Math.round(delta * 100) / 100,
      finding_count: output.findings.length,
      critical_finding_count: output.findings.filter(f => f.severity === "critical").length,
      is_outlier: deviation > 1.5,
    };
  });
}
```

**Outlier detection (TDD OQ-6):**
A reviewer is flagged as an outlier if their weighted score deviates more than 1.5 standard deviations from the panel mean. With 2 reviewers, both will always be equidistant from the mean, so outlier detection is only meaningful with 3+ reviewers. With 2 reviewers, `is_outlier` is always `false` unless one reviewer scored much higher/lower than the other (the standard deviation threshold still applies).

**Observer pattern integration:**
```typescript
interface ReviewGateEventListener {
  onGateCompleted(gateRecord: ReviewGateRecord, executionTimeMs: number): void;
}
```
The MetricsCollector implements `ReviewGateEventListener`. The ReviewGateService calls `onGateCompleted` after each gate execution.

### 4. PipelineAggregator (`metrics/pipeline-aggregator.ts`)

**Class: `PipelineAggregator`**

**Constructor:**
```typescript
constructor(private store: MetricsStore)
```

**Primary method:**
```typescript
async computeAggregates(
  windowDays: number = 30
): Promise<PipelineAggregates>
```

**Computation:**
```typescript
async computeAggregates(windowDays: number = 30): Promise<PipelineAggregates> {
  const windowEnd = new Date().toISOString();
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const records = await this.store.query({ from_timestamp: windowStart, to_timestamp: windowEnd });

  // Group by document type
  const byType = new Map<DocumentType, ReviewMetricsRecord[]>();
  for (const record of records) {
    if (!byType.has(record.document_type)) byType.set(record.document_type, []);
    byType.get(record.document_type)!.push(record);
  }

  const byDocumentType: Record<DocumentType, DocumentTypeAggregates> = {};
  for (const [docType, typeRecords] of byType) {
    byDocumentType[docType] = this.computeTypeAggregates(docType, typeRecords);
  }

  return {
    computed_at: new Date().toISOString(),
    window_start: windowStart,
    window_end: windowEnd,
    by_document_type: byDocumentType,
    overall: this.computeOverallAggregates(records),
  };
}
```

**Per-document-type aggregates:**

| Metric | Formula |
|--------|---------|
| `first_pass_rate` | `records.filter(r => r.iteration_count === 1 && r.outcome === "approved").length / records.length * 100` |
| `mean_iterations_to_approval` | `mean(approved_records.map(r => r.iteration_count))` or 0 if no approvals |
| `escalation_rate` | `records.filter(r => r.human_escalation).length / records.length * 100` |
| `mean_aggregate_score` | `mean(records.map(r => r.aggregate_score))` |
| `stagnation_rate` | `records.filter(r => r.stagnation_detected).length / records.length * 100` |
| `smoke_test_pass_rate` | Requires separate smoke test metrics (recorded when smoke tests run). Default: 0 if no data. |
| `backward_cascade_rate` | Requires external backward cascade event data. Default: 0 if no data. |

**Category score distribution:**
For each rubric category that appears in any record:
```typescript
function computeDistribution(scores: number[]): ScoreDistribution {
  const sorted = [...scores].sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: mean(sorted),
    median: median(sorted),
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    sample_count: sorted.length,
  };
}
```

## Acceptance Criteria

1. MetricsCollector records all per-gate metrics from TDD section 3.11.1.
2. `ReviewMetricsRecord` includes gate_id, document_id, document_type, pipeline_id, outcome, aggregate_score, iteration_count, review_duration_ms, reviewer_count, disagreement_count, stagnation_detected, quality_regression_detected, human_escalation.
3. Finding counts broken down by severity (critical, major, minor, suggestion).
4. Per-reviewer metrics include reviewer_id, role, weighted_score, score_vs_aggregate_delta, finding_count, critical_finding_count.
5. `score_vs_aggregate_delta` = reviewer's weighted score - aggregate score.
6. Outlier detection flags reviewers whose score deviates > 1.5x standard deviation from panel mean.
7. Metrics write failures handled gracefully: retry 3x with exponential backoff; on total failure, proceed without blocking pipeline.
8. MetricsCollector implements observer pattern (event listener).
9. PipelineAggregator computes `first_pass_rate` correctly.
10. PipelineAggregator computes `mean_iterations_to_approval` correctly.
11. PipelineAggregator computes `escalation_rate` correctly.
12. PipelineAggregator computes `mean_aggregate_score` correctly.
13. Category score distributions include min, max, mean, median, p25, p75.
14. Aggregates computed over configurable time window (default 30 days).
15. Aggregates broken down by document type.
16. FileSystemMetricsStore writes and reads JSON files correctly.

## Test Cases

### `tests/review-gate/metrics/metrics-collector.test.ts`

1. **Record complete gate metrics**: Provide a full `ReviewGateRecord`. Verify all fields are correctly mapped to `ReviewMetricsRecord`.
2. **Finding counts by severity**: Gate with 2 critical, 3 major, 1 minor, 4 suggestion findings. Verify counts: `{critical: 2, major: 3, minor: 1, suggestion: 4}`.
3. **Per-reviewer weighted score delta**: Reviewer weighted 88, aggregate 85. `score_vs_aggregate_delta: 3`.
4. **Per-reviewer negative delta**: Reviewer weighted 80, aggregate 85. `score_vs_aggregate_delta: -5`.
5. **Outlier detection -- 3 reviewers**: Scores [90, 85, 60]. Mean 78.33, stdDev ~13.2. Reviewer at 60 deviates 1.39x stdDev (not outlier). Reviewer at 90 deviates 0.88x (not outlier). Adjust: Scores [95, 85, 60]. Mean 80, stdDev ~14.7. Reviewer at 60 deviates 1.36x (not outlier). Test with [100, 85, 55]: Mean 80, stdDev ~18.7. 55 deviates 1.34x (not outlier). Need scores [100, 80, 40]: mean 73.3, stdDev ~24.9. 40 deviates 1.34x (not outlier). Use scores [100, 90, 30]: Mean 73.3, stdDev ~30.5. 30 deviates 1.42x (not outlier). Use [100, 90, 20]: Mean 70, stdDev ~35.6. 20 deviates 1.40x. Let's just verify the formula: if one reviewer is 2+ std devs from mean, outlier. Test: [90, 90, 50]. Mean 76.7, stdDev 18.9. 50 deviates 1.41x (not). Test: [90, 90, 40]. Mean 73.3, stdDev 23.6. 40 deviates 1.41x. So with 3 reviewers it's hard to exceed 1.5x. Document: with 3 reviewers, outlier needs extreme divergence (~2 std devs). Test with [100, 100, 30]: Mean 76.7, stdDev 33.0. 30 deviates 1.41x. Actually, for 3 equal-weight reviewers, math limits max z-score to sqrt(2) ~1.41. Adjust: use `is_outlier: deviation > 1.3` for 3-reviewer panels or test with 4+ reviewers. For test purposes, **use 4 reviewers**: [95, 90, 85, 40]. Mean 77.5, stdDev ~21.0. 40 deviates 1.79x. `is_outlier: true`.
6. **Outlier with 2 reviewers**: Scores [90, 60]. Both are equidistant from mean (75). StdDev is 15. Each deviates 1.0x. Neither is outlier.
7. **Write failure retry**: Mock store throws on first 2 writes, succeeds on third. Verify record is written.
8. **Write failure -- all retries exhausted**: Mock store throws 3 times. Verify no exception thrown (graceful failure). Log captured.
9. **Observer integration**: Register MetricsCollector as listener. Fire `onGateCompleted`. Verify store.write was called.
10. **Empty findings**: Gate with 0 findings. `finding_counts: {critical: 0, major: 0, minor: 0, suggestion: 0}`.

### `tests/review-gate/metrics/pipeline-aggregator.test.ts`

11. **First pass rate**: 10 PRD records. 4 approved on iteration 1. `first_pass_rate: 40`.
12. **Mean iterations to approval**: 5 approved PRDs with iteration_counts [1, 2, 2, 3, 2]. Mean: 2.0.
13. **Escalation rate**: 10 records, 2 with `human_escalation: true`. `escalation_rate: 20`.
14. **Mean aggregate score**: Scores [80, 85, 90, 75]. Mean: 82.5.
15. **Stagnation rate**: 10 records, 3 with `stagnation_detected: true`. `stagnation_rate: 30`.
16. **Category score distribution**: 5 records with `problem_clarity` scores [60, 70, 80, 90, 100]. Min: 60, max: 100, mean: 80, median: 80, p25: 70, p75: 90.
17. **By document type breakdown**: 5 PRD records and 3 TDD records. Verify `by_document_type` has both types with correct counts.
18. **Custom time window**: Set window to 7 days. Only records within 7 days included.
19. **Empty data**: No records in window. All rates 0, all means 0.
20. **Overall aggregates**: Total gates, approved, rejected, escalated counts are correct sums across all types.
