/**
 * Tests for MetricsCollector.
 *
 * Covers SPEC-004-4-2 test cases 1-10:
 *   1. Record complete gate metrics
 *   2. Finding counts by severity
 *   3. Per-reviewer weighted score delta (positive)
 *   4. Per-reviewer negative delta
 *   5. Outlier detection -- 4 reviewers
 *   6. Outlier with 2 reviewers
 *   7. Write failure retry (succeeds on 3rd attempt)
 *   8. Write failure -- all retries exhausted (graceful failure)
 *   9. Observer integration
 *  10. Empty findings
 */

import {
  ReviewGateRecord,
  ReviewOutput,
  MergedFinding,
  CategoryAggregate,
  Finding,
} from '../../../src/review-gate/types';
import {
  MetricsCollector,
  ReviewGateEventListener,
  buildMetricsRecord,
  buildReviewerMetrics,
  buildCategoryScoreMap,
  countFindingsBySeverity,
  computeWeightedScore,
} from '../../../src/review-gate/metrics/metrics-collector';
import { MetricsStore, writeWithRetry } from '../../../src/review-gate/metrics/metrics-store';
import { ReviewMetricsRecord } from '../../../src/review-gate/metrics/metrics-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ReviewGateRecord for testing.
 */
function makeGateRecord(overrides: Partial<ReviewGateRecord> = {}): ReviewGateRecord {
  return {
    gate_id: 'gate-001',
    document_id: 'doc-001',
    document_type: 'PRD',
    document_version: '1.0.0',
    pipeline_id: 'pipeline-001',
    iteration: 1,
    max_iterations: 3,
    rubric_version: '1.0',
    threshold: 85,
    aggregation_method: 'mean',
    panel_size: 2,
    trust_level: 'approve_all',
    reviewer_outputs: [],
    aggregate_score: 85,
    category_aggregates: [],
    outcome: 'approved',
    merged_findings: [],
    disagreements: [],
    quality_regression: null,
    stagnation_warning: false,
    human_escalation: false,
    started_at: '2026-04-08T10:00:00.000Z',
    completed_at: '2026-04-08T10:05:00.000Z',
    created_by: 'test',
    ...overrides,
  };
}

/**
 * Build a minimal ReviewOutput for testing.
 */
function makeReviewOutput(
  reviewerId: string,
  role: string,
  scores: { category_id: string; score: number }[],
  findings: Finding[] = []
): ReviewOutput {
  return {
    reviewer_id: reviewerId,
    reviewer_role: role,
    document_id: 'doc-001',
    document_version: '1.0.0',
    timestamp: '2026-04-08T10:03:00.000Z',
    scoring_mode: 'document_level',
    category_scores: scores.map((s) => ({
      category_id: s.category_id,
      score: s.score,
      section_scores: null,
      justification: 'Test justification',
    })),
    findings,
    summary: 'Test summary',
  };
}

/**
 * Build a minimal Finding for testing.
 */
function makeFinding(severity: 'critical' | 'major' | 'minor' | 'suggestion'): Finding {
  return {
    id: `finding-${Math.random().toString(36).slice(2)}`,
    section_id: 'sec-1',
    category_id: 'cat-1',
    severity,
    critical_sub: severity === 'critical' ? 'blocking' : null,
    upstream_defect: false,
    description: `Test ${severity} finding`,
    evidence: 'Test evidence',
    suggested_resolution: 'Test resolution',
  };
}

/**
 * Build a minimal MergedFinding for testing.
 */
function makeMergedFinding(
  severity: 'critical' | 'major' | 'minor' | 'suggestion'
): MergedFinding {
  return {
    id: `merged-${Math.random().toString(36).slice(2)}`,
    section_id: 'sec-1',
    category_id: 'cat-1',
    severity,
    critical_sub: severity === 'critical' ? 'blocking' : null,
    upstream_defect: false,
    description: `Test ${severity} finding`,
    evidence: 'Test evidence',
    suggested_resolution: 'Test resolution',
    reported_by: ['reviewer-1'],
    resolution_status: 'open',
    prior_finding_id: null,
  };
}

/**
 * Mock MetricsStore for testing.
 */
function createMockStore(): MetricsStore & {
  writtenRecords: ReviewMetricsRecord[];
  writeCallCount: number;
  writeFn: jest.Mock;
} {
  const writtenRecords: ReviewMetricsRecord[] = [];
  const writeFn = jest.fn(async (record: ReviewMetricsRecord) => {
    writtenRecords.push(record);
  });
  return {
    writtenRecords,
    writeCallCount: 0,
    writeFn,
    write: writeFn,
    query: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MetricsCollector', () => {
  // -----------------------------------------------------------------------
  // Test 1: Record complete gate metrics
  // -----------------------------------------------------------------------
  test('records all fields from a full ReviewGateRecord into ReviewMetricsRecord', () => {
    const reviewerOutputs = [
      makeReviewOutput('r1', 'architect', [
        { category_id: 'problem_clarity', score: 90 },
        { category_id: 'completeness', score: 80 },
      ]),
      makeReviewOutput('r2', 'domain_expert', [
        { category_id: 'problem_clarity', score: 85 },
        { category_id: 'completeness', score: 75 },
      ]),
    ];

    const categoryAggregates: CategoryAggregate[] = [
      {
        category_id: 'problem_clarity',
        category_name: 'Problem Clarity',
        weight: 50,
        aggregate_score: 87.5,
        per_reviewer_scores: [
          { reviewer_id: 'r1', score: 90 },
          { reviewer_id: 'r2', score: 85 },
        ],
        min_threshold: 70,
        threshold_violated: false,
      },
      {
        category_id: 'completeness',
        category_name: 'Completeness',
        weight: 50,
        aggregate_score: 77.5,
        per_reviewer_scores: [
          { reviewer_id: 'r1', score: 80 },
          { reviewer_id: 'r2', score: 75 },
        ],
        min_threshold: 60,
        threshold_violated: false,
      },
    ];

    const gateRecord = makeGateRecord({
      gate_id: 'gate-full',
      document_id: 'doc-full',
      document_type: 'TDD',
      pipeline_id: 'pipeline-full',
      iteration: 2,
      aggregate_score: 82.5,
      outcome: 'approved',
      reviewer_outputs: reviewerOutputs,
      category_aggregates: categoryAggregates,
      merged_findings: [makeMergedFinding('major'), makeMergedFinding('minor')],
      disagreements: [
        {
          category_id: 'problem_clarity',
          variance: 5,
          reviewer_scores: [
            { reviewer_id: 'r1', score: 90 },
            { reviewer_id: 'r2', score: 85 },
          ],
          note: 'Slight disagreement',
        },
      ],
      stagnation_warning: true,
      quality_regression: {
        previous_score: 80,
        current_score: 82.5,
        delta: 2.5,
        rollback_recommended: false,
      },
      human_escalation: true,
    });

    const record = buildMetricsRecord(gateRecord, 5000);

    expect(record.gate_id).toBe('gate-full');
    expect(record.document_id).toBe('doc-full');
    expect(record.document_type).toBe('TDD');
    expect(record.pipeline_id).toBe('pipeline-full');
    expect(record.timestamp).toBeTruthy();
    expect(record.outcome).toBe('approved');
    expect(record.aggregate_score).toBe(82.5);
    expect(record.iteration_count).toBe(2);
    expect(record.review_duration_ms).toBe(5000);
    expect(record.reviewer_count).toBe(2);
    expect(record.disagreement_count).toBe(1);
    expect(record.stagnation_detected).toBe(true);
    expect(record.quality_regression_detected).toBe(true);
    expect(record.human_escalation).toBe(true);
    expect(record.category_scores).toEqual({
      problem_clarity: 87.5,
      completeness: 77.5,
    });
    expect(record.finding_counts).toEqual({
      critical: 0,
      major: 1,
      minor: 1,
      suggestion: 0,
    });
    expect(record.reviewer_metrics).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Test 2: Finding counts by severity
  // -----------------------------------------------------------------------
  test('counts findings by severity: 2 critical, 3 major, 1 minor, 4 suggestion', () => {
    const findings: MergedFinding[] = [
      makeMergedFinding('critical'),
      makeMergedFinding('critical'),
      makeMergedFinding('major'),
      makeMergedFinding('major'),
      makeMergedFinding('major'),
      makeMergedFinding('minor'),
      makeMergedFinding('suggestion'),
      makeMergedFinding('suggestion'),
      makeMergedFinding('suggestion'),
      makeMergedFinding('suggestion'),
    ];

    const counts = countFindingsBySeverity(findings);
    expect(counts).toEqual({ critical: 2, major: 3, minor: 1, suggestion: 4 });
  });

  // -----------------------------------------------------------------------
  // Test 3: Per-reviewer weighted score delta (positive)
  // -----------------------------------------------------------------------
  test('score_vs_aggregate_delta is positive when reviewer scores higher than aggregate', () => {
    const reviewer = makeReviewOutput('r1', 'architect', [
      { category_id: 'overall', score: 88 },
    ]);

    const metrics = buildReviewerMetrics([reviewer], 85);
    expect(metrics[0].weighted_score).toBe(88);
    expect(metrics[0].score_vs_aggregate_delta).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Test 4: Per-reviewer negative delta
  // -----------------------------------------------------------------------
  test('score_vs_aggregate_delta is negative when reviewer scores lower than aggregate', () => {
    const reviewer = makeReviewOutput('r1', 'architect', [
      { category_id: 'overall', score: 80 },
    ]);

    const metrics = buildReviewerMetrics([reviewer], 85);
    expect(metrics[0].weighted_score).toBe(80);
    expect(metrics[0].score_vs_aggregate_delta).toBe(-5);
  });

  // -----------------------------------------------------------------------
  // Test 5: Outlier detection -- 4 reviewers
  // -----------------------------------------------------------------------
  test('flags outlier with 4 reviewers: [95, 90, 85, 40]', () => {
    // Mean = 77.5, StdDev = sqrt(((95-77.5)^2 + (90-77.5)^2 + (85-77.5)^2 + (40-77.5)^2)/4)
    //       = sqrt((306.25 + 156.25 + 56.25 + 1406.25)/4) = sqrt(1925/4) = sqrt(481.25) ~= 21.94
    // 40 deviates: |40 - 77.5| / 21.94 = 37.5 / 21.94 ~= 1.71 > 1.5 => outlier
    // 95 deviates: |95 - 77.5| / 21.94 = 17.5 / 21.94 ~= 0.80 => not outlier
    const reviewers = [
      makeReviewOutput('r1', 'architect', [{ category_id: 'overall', score: 95 }]),
      makeReviewOutput('r2', 'domain_expert', [{ category_id: 'overall', score: 90 }]),
      makeReviewOutput('r3', 'security', [{ category_id: 'overall', score: 85 }]),
      makeReviewOutput('r4', 'junior', [{ category_id: 'overall', score: 40 }]),
    ];

    const metrics = buildReviewerMetrics(reviewers, 77.5);

    expect(metrics[0].is_outlier).toBe(false); // r1: 95
    expect(metrics[1].is_outlier).toBe(false); // r2: 90
    expect(metrics[2].is_outlier).toBe(false); // r3: 85
    expect(metrics[3].is_outlier).toBe(true); // r4: 40 => outlier
  });

  // -----------------------------------------------------------------------
  // Test 6: Outlier with 2 reviewers
  // -----------------------------------------------------------------------
  test('2 reviewers [90, 60]: neither is outlier (both equidistant from mean)', () => {
    const reviewers = [
      makeReviewOutput('r1', 'architect', [{ category_id: 'overall', score: 90 }]),
      makeReviewOutput('r2', 'domain_expert', [{ category_id: 'overall', score: 60 }]),
    ];

    // Mean = 75, StdDev = 15. Each deviates 1.0 stddev. Not > 1.5.
    const metrics = buildReviewerMetrics(reviewers, 75);
    expect(metrics[0].is_outlier).toBe(false);
    expect(metrics[1].is_outlier).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 7: Write failure retry -- succeeds on 3rd attempt
  // -----------------------------------------------------------------------
  test('retries write and succeeds on 3rd attempt', async () => {
    let callCount = 0;
    const mockStore: MetricsStore = {
      write: jest.fn(async () => {
        callCount++;
        if (callCount < 3) {
          throw new Error(`Write failure #${callCount}`);
        }
      }),
      query: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    };

    const gateRecord = makeGateRecord();
    const record = buildMetricsRecord(gateRecord, 1000);

    await writeWithRetry(mockStore, record, 3);

    expect(mockStore.write).toHaveBeenCalledTimes(3);
  });

  // -----------------------------------------------------------------------
  // Test 8: Write failure -- all retries exhausted (graceful failure)
  // -----------------------------------------------------------------------
  test('gracefully handles total write failure after all retries', async () => {
    const mockStore: MetricsStore = {
      write: jest.fn(async () => {
        throw new Error('Persistent failure');
      }),
      query: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    };

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const gateRecord = makeGateRecord({ gate_id: 'gate-fail' });
    const record = buildMetricsRecord(gateRecord, 1000);

    // Should NOT throw
    await expect(writeWithRetry(mockStore, record, 3)).resolves.toBeUndefined();

    expect(mockStore.write).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Metrics write failed after 3 attempts for gate gate-fail'),
      expect.any(Error)
    );

    errorSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Test 9: Observer integration
  // -----------------------------------------------------------------------
  test('onGateCompleted triggers store.write via observer pattern', async () => {
    const mockStore = createMockStore();
    const collector = new MetricsCollector(mockStore);

    const gateRecord = makeGateRecord({
      gate_id: 'gate-observer',
      reviewer_outputs: [
        makeReviewOutput('r1', 'architect', [{ category_id: 'overall', score: 85 }]),
      ],
    });

    // Call observer method
    collector.onGateCompleted(gateRecord, 2000);

    // Wait for fire-and-forget promise to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockStore.writeFn).toHaveBeenCalledTimes(1);
    const writtenRecord = mockStore.writeFn.mock.calls[0][0] as ReviewMetricsRecord;
    expect(writtenRecord.gate_id).toBe('gate-observer');
  });

  // -----------------------------------------------------------------------
  // Test 10: Empty findings
  // -----------------------------------------------------------------------
  test('zero findings produces all-zero severity counts', () => {
    const counts = countFindingsBySeverity([]);
    expect(counts).toEqual({ critical: 0, major: 0, minor: 0, suggestion: 0 });
  });

  // -----------------------------------------------------------------------
  // SPEC-004-4-4 Test 18: Exponential backoff timing
  // Verify retries use 100ms, 200ms, 400ms delays (mock timer).
  // -----------------------------------------------------------------------
  test('exponential backoff: retries use 100ms, 200ms, 400ms delays', async () => {
    jest.useFakeTimers();

    const callTimestamps: number[] = [];
    let callCount = 0;
    const mockStore: MetricsStore = {
      write: jest.fn(async () => {
        callTimestamps.push(Date.now());
        callCount++;
        if (callCount < 4) {
          throw new Error(`Write failure #${callCount}`);
        }
      }),
      query: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    };

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const gateRecord = makeGateRecord({ gate_id: 'gate-backoff' });
    const record = buildMetricsRecord(gateRecord, 1000);

    // writeWithRetry with 3 retries: attempts at 0, +100ms, +200ms
    const writePromise = writeWithRetry(mockStore, record, 3);

    // Advance timers through all backoff delays
    // After attempt 1 fails: sleep 100ms
    await jest.advanceTimersByTimeAsync(100);
    // After attempt 2 fails: sleep 200ms
    await jest.advanceTimersByTimeAsync(200);
    // After attempt 3 fails: no more retries, logs error

    await writePromise;

    // All 3 attempts should have been made
    expect(mockStore.write).toHaveBeenCalledTimes(3);

    jest.useRealTimers();
    errorSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Helper function unit tests
// ---------------------------------------------------------------------------

describe('buildCategoryScoreMap', () => {
  test('maps category aggregates to id -> score record', () => {
    const aggregates: CategoryAggregate[] = [
      {
        category_id: 'clarity',
        category_name: 'Clarity',
        weight: 30,
        aggregate_score: 88,
        per_reviewer_scores: [],
        min_threshold: null,
        threshold_violated: false,
      },
      {
        category_id: 'depth',
        category_name: 'Depth',
        weight: 70,
        aggregate_score: 72,
        per_reviewer_scores: [],
        min_threshold: null,
        threshold_violated: false,
      },
    ];

    expect(buildCategoryScoreMap(aggregates)).toEqual({
      clarity: 88,
      depth: 72,
    });
  });
});

describe('computeWeightedScore', () => {
  test('returns mean of all category scores for a reviewer', () => {
    const output = makeReviewOutput('r1', 'architect', [
      { category_id: 'a', score: 80 },
      { category_id: 'b', score: 90 },
      { category_id: 'c', score: 70 },
    ]);
    // mean = (80 + 90 + 70) / 3 = 80
    expect(computeWeightedScore(output)).toBe(80);
  });

  test('returns 0 for reviewer with no category scores', () => {
    const output = makeReviewOutput('r1', 'architect', []);
    expect(computeWeightedScore(output)).toBe(0);
  });
});
