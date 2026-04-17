/**
 * Tests for PipelineAggregator.
 *
 * Covers SPEC-004-4-2 test cases 11-20:
 *  11. First pass rate
 *  12. Mean iterations to approval
 *  13. Escalation rate
 *  14. Mean aggregate score
 *  15. Stagnation rate
 *  16. Category score distribution
 *  17. By document type breakdown
 *  18. Custom time window
 *  19. Empty data
 *  20. Overall aggregates
 */

import { DocumentType } from '../../../src/review-gate/types';
import {
  PipelineAggregator,
  mean,
  median,
  percentile,
  computeDistribution,
} from '../../../src/review-gate/metrics/pipeline-aggregator';
import { MetricsStore } from '../../../src/review-gate/metrics/metrics-store';
import {
  ReviewMetricsRecord,
  MetricsFilter,
} from '../../../src/review-gate/metrics/metrics-types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal ReviewMetricsRecord for testing.
 */
function makeRecord(overrides: Partial<ReviewMetricsRecord> = {}): ReviewMetricsRecord {
  return {
    gate_id: `gate-${Math.random().toString(36).slice(2)}`,
    document_id: 'doc-001',
    document_type: 'PRD',
    pipeline_id: 'pipeline-001',
    timestamp: new Date().toISOString(),
    outcome: 'approved',
    aggregate_score: 85,
    iteration_count: 1,
    review_duration_ms: 3000,
    reviewer_count: 2,
    disagreement_count: 0,
    stagnation_detected: false,
    quality_regression_detected: false,
    human_escalation: false,
    category_scores: {},
    finding_counts: { critical: 0, major: 0, minor: 0, suggestion: 0 },
    reviewer_metrics: [],
    ...overrides,
  };
}

/**
 * Create a mock MetricsStore that returns the given records on query.
 */
function createMockStore(records: ReviewMetricsRecord[]): MetricsStore {
  return {
    write: jest.fn(async () => {}),
    query: jest.fn(async (filter: MetricsFilter) => {
      return records.filter((r) => {
        if (filter.from_timestamp && r.timestamp < filter.from_timestamp) return false;
        if (filter.to_timestamp && r.timestamp > filter.to_timestamp) return false;
        if (filter.document_type && r.document_type !== filter.document_type) return false;
        return true;
      });
    }),
    count: jest.fn(async (filter: MetricsFilter) => {
      const filtered = records.filter((r) => {
        if (filter.from_timestamp && r.timestamp < filter.from_timestamp) return false;
        if (filter.to_timestamp && r.timestamp > filter.to_timestamp) return false;
        return true;
      });
      return filtered.length;
    }),
  };
}

// ---------------------------------------------------------------------------
// Statistical helper tests
// ---------------------------------------------------------------------------

describe('Statistical helpers', () => {
  test('mean of [80, 85, 90, 75] is 82.5', () => {
    expect(mean([80, 85, 90, 75])).toBe(82.5);
  });

  test('mean of empty array is 0', () => {
    expect(mean([])).toBe(0);
  });

  test('median of [60, 70, 80, 90, 100] is 80', () => {
    expect(median([60, 70, 80, 90, 100])).toBe(80);
  });

  test('median of [60, 80] is 70', () => {
    expect(median([60, 80])).toBe(70);
  });

  test('median of empty array is 0', () => {
    expect(median([])).toBe(0);
  });

  test('percentile p25 of [60, 70, 80, 90, 100] is 70', () => {
    expect(percentile([60, 70, 80, 90, 100], 25)).toBe(70);
  });

  test('percentile p75 of [60, 70, 80, 90, 100] is 90', () => {
    expect(percentile([60, 70, 80, 90, 100], 75)).toBe(90);
  });

  test('percentile of single element returns that element', () => {
    expect(percentile([42], 25)).toBe(42);
    expect(percentile([42], 75)).toBe(42);
  });

  test('percentile of empty array is 0', () => {
    expect(percentile([], 50)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// PipelineAggregator tests
// ---------------------------------------------------------------------------

describe('PipelineAggregator', () => {
  // -----------------------------------------------------------------------
  // Test 11: First pass rate
  // -----------------------------------------------------------------------
  test('first_pass_rate: 4 of 10 PRD records approved on iteration 1 => 40%', async () => {
    const records: ReviewMetricsRecord[] = [];
    // 4 approved on iteration 1
    for (let i = 0; i < 4; i++) {
      records.push(makeRecord({ outcome: 'approved', iteration_count: 1 }));
    }
    // 3 approved on iteration 2+
    for (let i = 0; i < 3; i++) {
      records.push(makeRecord({ outcome: 'approved', iteration_count: 2 }));
    }
    // 3 rejected
    for (let i = 0; i < 3; i++) {
      records.push(makeRecord({ outcome: 'rejected', iteration_count: 1 }));
    }

    const store = createMockStore(records);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    expect(result.by_document_type['PRD']!.first_pass_rate).toBe(40);
  });

  // -----------------------------------------------------------------------
  // Test 12: Mean iterations to approval
  // -----------------------------------------------------------------------
  test('mean_iterations_to_approval: [1, 2, 2, 3, 2] => 2.0', async () => {
    const iterationCounts = [1, 2, 2, 3, 2];
    const records = iterationCounts.map((ic) =>
      makeRecord({ outcome: 'approved', iteration_count: ic })
    );

    const store = createMockStore(records);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    expect(result.by_document_type['PRD']!.mean_iterations_to_approval).toBe(2.0);
  });

  // -----------------------------------------------------------------------
  // Test 13: Escalation rate
  // -----------------------------------------------------------------------
  test('escalation_rate: 2 of 10 with human_escalation => 20%', async () => {
    const records: ReviewMetricsRecord[] = [];
    for (let i = 0; i < 2; i++) {
      records.push(makeRecord({ human_escalation: true }));
    }
    for (let i = 0; i < 8; i++) {
      records.push(makeRecord({ human_escalation: false }));
    }

    const store = createMockStore(records);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    expect(result.by_document_type['PRD']!.escalation_rate).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Test 14: Mean aggregate score
  // -----------------------------------------------------------------------
  test('mean_aggregate_score: [80, 85, 90, 75] => 82.5', async () => {
    const scores = [80, 85, 90, 75];
    const records = scores.map((s) => makeRecord({ aggregate_score: s }));

    const store = createMockStore(records);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    expect(result.by_document_type['PRD']!.mean_aggregate_score).toBe(82.5);
  });

  // -----------------------------------------------------------------------
  // Test 15: Stagnation rate
  // -----------------------------------------------------------------------
  test('stagnation_rate: 3 of 10 with stagnation_detected => 30%', async () => {
    const records: ReviewMetricsRecord[] = [];
    for (let i = 0; i < 3; i++) {
      records.push(makeRecord({ stagnation_detected: true }));
    }
    for (let i = 0; i < 7; i++) {
      records.push(makeRecord({ stagnation_detected: false }));
    }

    const store = createMockStore(records);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    expect(result.by_document_type['PRD']!.stagnation_rate).toBe(30);
  });

  // -----------------------------------------------------------------------
  // Test 16: Category score distribution
  // -----------------------------------------------------------------------
  test('category score distribution for problem_clarity [60, 70, 80, 90, 100]', async () => {
    const scores = [60, 70, 80, 90, 100];
    const records = scores.map((s) =>
      makeRecord({ category_scores: { problem_clarity: s } })
    );

    const store = createMockStore(records);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    const dist =
      result.by_document_type['PRD']!.category_score_distributions['problem_clarity'];
    expect(dist).toBeDefined();
    expect(dist.min).toBe(60);
    expect(dist.max).toBe(100);
    expect(dist.mean).toBe(80);
    expect(dist.median).toBe(80);
    expect(dist.p25).toBe(70);
    expect(dist.p75).toBe(90);
    expect(dist.sample_count).toBe(5);
  });

  // -----------------------------------------------------------------------
  // Test 17: By document type breakdown
  // -----------------------------------------------------------------------
  test('aggregates broken down by document type: 5 PRD + 3 TDD', async () => {
    const records: ReviewMetricsRecord[] = [];
    for (let i = 0; i < 5; i++) {
      records.push(makeRecord({ document_type: 'PRD' }));
    }
    for (let i = 0; i < 3; i++) {
      records.push(makeRecord({ document_type: 'TDD' }));
    }

    const store = createMockStore(records);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    expect(result.by_document_type['PRD']).toBeDefined();
    expect(result.by_document_type['PRD']!.total_gates).toBe(5);
    expect(result.by_document_type['PRD']!.document_type).toBe('PRD');

    expect(result.by_document_type['TDD']).toBeDefined();
    expect(result.by_document_type['TDD']!.total_gates).toBe(3);
    expect(result.by_document_type['TDD']!.document_type).toBe('TDD');
  });

  // -----------------------------------------------------------------------
  // Test 18: Custom time window (7 days)
  // -----------------------------------------------------------------------
  test('custom 7-day window only includes records within 7 days', async () => {
    const now = Date.now();
    const recentRecord = makeRecord({
      timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(), // 3 days ago
    });
    const oldRecord = makeRecord({
      timestamp: new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString(), // 10 days ago
    });

    const store = createMockStore([recentRecord, oldRecord]);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(7);

    // Only the recent record should be included
    expect(result.by_document_type['PRD']!.total_gates).toBe(1);
  });

  // -----------------------------------------------------------------------
  // Test 19: Empty data
  // -----------------------------------------------------------------------
  test('empty data: all rates 0, all means 0', async () => {
    const store = createMockStore([]);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    expect(result.overall.total_gates).toBe(0);
    expect(result.overall.total_approved).toBe(0);
    expect(result.overall.total_rejected).toBe(0);
    expect(result.overall.total_escalated).toBe(0);
    expect(result.overall.mean_review_duration_ms).toBe(0);
    expect(result.overall.mean_iterations).toBe(0);
    expect(Object.keys(result.by_document_type)).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 20: Overall aggregates
  // -----------------------------------------------------------------------
  test('overall aggregates: correct sums across all types', async () => {
    const records: ReviewMetricsRecord[] = [
      // 3 approved PRD
      makeRecord({ document_type: 'PRD', outcome: 'approved', human_escalation: false, review_duration_ms: 2000, iteration_count: 1 }),
      makeRecord({ document_type: 'PRD', outcome: 'approved', human_escalation: false, review_duration_ms: 4000, iteration_count: 2 }),
      makeRecord({ document_type: 'PRD', outcome: 'approved', human_escalation: true, review_duration_ms: 6000, iteration_count: 3 }),
      // 2 TDD: 1 rejected, 1 approved
      makeRecord({ document_type: 'TDD', outcome: 'rejected', human_escalation: true, review_duration_ms: 3000, iteration_count: 2 }),
      makeRecord({ document_type: 'TDD', outcome: 'approved', human_escalation: false, review_duration_ms: 5000, iteration_count: 1 }),
    ];

    const store = createMockStore(records);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    expect(result.overall.total_gates).toBe(5);
    expect(result.overall.total_approved).toBe(4);
    expect(result.overall.total_rejected).toBe(1);
    expect(result.overall.total_escalated).toBe(2);
    // mean duration: (2000 + 4000 + 6000 + 3000 + 5000) / 5 = 4000
    expect(result.overall.mean_review_duration_ms).toBe(4000);
    // mean iterations: (1 + 2 + 3 + 2 + 1) / 5 = 1.8
    expect(result.overall.mean_iterations).toBe(1.8);
  });

  // -----------------------------------------------------------------------
  // SPEC-004-4-4 Test 20: Single record
  // -----------------------------------------------------------------------
  test('single record: rates are 0% or 100%, means equal the single value', async () => {
    const singleRecord = makeRecord({
      outcome: 'approved',
      iteration_count: 1,
      aggregate_score: 90,
      review_duration_ms: 2500,
      human_escalation: false,
      stagnation_detected: false,
    });

    const store = createMockStore([singleRecord]);
    const aggregator = new PipelineAggregator(store);
    const result = await aggregator.computeAggregates(30);

    const prd = result.by_document_type['PRD']!;
    expect(prd.total_gates).toBe(1);
    // Approved on iteration 1 -> 100% first pass rate
    expect(prd.first_pass_rate).toBe(100);
    expect(prd.mean_iterations_to_approval).toBe(1);
    // No escalation -> 0%
    expect(prd.escalation_rate).toBe(0);
    expect(prd.mean_aggregate_score).toBe(90);
    expect(prd.stagnation_rate).toBe(0);

    expect(result.overall.total_gates).toBe(1);
    expect(result.overall.total_approved).toBe(1);
    expect(result.overall.total_rejected).toBe(0);
    expect(result.overall.mean_review_duration_ms).toBe(2500);
    expect(result.overall.mean_iterations).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// computeDistribution unit tests
// ---------------------------------------------------------------------------

describe('computeDistribution', () => {
  test('produces correct distribution for [60, 70, 80, 90, 100]', () => {
    const dist = computeDistribution('test_cat', [60, 70, 80, 90, 100]);
    expect(dist.category_id).toBe('test_cat');
    expect(dist.min).toBe(60);
    expect(dist.max).toBe(100);
    expect(dist.mean).toBe(80);
    expect(dist.median).toBe(80);
    expect(dist.p25).toBe(70);
    expect(dist.p75).toBe(90);
    expect(dist.sample_count).toBe(5);
  });

  test('empty scores produce all-zero distribution', () => {
    const dist = computeDistribution('empty', []);
    expect(dist.min).toBe(0);
    expect(dist.max).toBe(0);
    expect(dist.mean).toBe(0);
    expect(dist.median).toBe(0);
    expect(dist.p25).toBe(0);
    expect(dist.p75).toBe(0);
    expect(dist.sample_count).toBe(0);
  });

  test('single score produces that value for all stats', () => {
    const dist = computeDistribution('single', [75]);
    expect(dist.min).toBe(75);
    expect(dist.max).toBe(75);
    expect(dist.mean).toBe(75);
    expect(dist.median).toBe(75);
    expect(dist.p25).toBe(75);
    expect(dist.p75).toBe(75);
    expect(dist.sample_count).toBe(1);
  });
});
