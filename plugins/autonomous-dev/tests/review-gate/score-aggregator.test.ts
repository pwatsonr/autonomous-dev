import { QualityRubric } from '../../src/pipeline/types/quality-rubric';
import {
  ScoreAggregator,
  CategoryScore,
  ReviewOutput,
} from '../../src/review-gate/score-aggregator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a rubric with the given category IDs and weights.
 * Used to build test-specific rubrics matching the TDD worked examples.
 */
function makeRubric(
  categories: { id: string; weight: number; minimumScore?: number }[],
  documentType = 'PRD'
): QualityRubric {
  return {
    documentType,
    version: '1.0',
    aggregationMethod: 'mean',
    categories: categories.map((c) => ({
      id: c.id,
      name: c.id,
      description: `Measures ${c.id}`,
      weight: c.weight,
      minimumScore: c.minimumScore ?? 60,
      scoringGuide: [
        { min: 0, max: 49, description: 'Poor' },
        { min: 50, max: 100, description: 'Good' },
      ],
    })),
  };
}

/**
 * Creates a ReviewOutput with the given category scores.
 */
function makeReviewOutput(
  reviewerId: string,
  scores: { category_id: string; score: number }[]
): ReviewOutput {
  return {
    reviewer_id: reviewerId,
    category_scores: scores.map((s) => ({
      category_id: s.category_id,
      score: s.score,
      section_scores: null,
    })),
    findings: [],
  };
}

// ---------------------------------------------------------------------------
// TDD Worked Example Fixtures
// ---------------------------------------------------------------------------

/**
 * TDD worked example (single reviewer, PRD).
 * 7 categories with weights [0.15, 0.15, 0.15, 0.20, 0.15, 0.10, 0.10]
 * Scores: [92, 78, 85, 70, 88, 65, 90]
 * Expected: 0.15*92 + 0.15*78 + 0.15*85 + 0.20*70 + 0.15*88 + 0.10*65 + 0.10*90 = 80.95
 */
const WORKED_EXAMPLE_CATEGORIES = [
  { id: 'cat_a', weight: 0.15 },
  { id: 'cat_b', weight: 0.15 },
  { id: 'cat_c', weight: 0.15 },
  { id: 'cat_d', weight: 0.20 },
  { id: 'cat_e', weight: 0.15 },
  { id: 'cat_f', weight: 0.10 },
  { id: 'cat_g', weight: 0.10 },
];

const WORKED_EXAMPLE_SCORES = [92, 78, 85, 70, 88, 65, 90];

const WORKED_EXAMPLE_RUBRIC = makeRubric(WORKED_EXAMPLE_CATEGORIES);

const WORKED_EXAMPLE_CATEGORY_SCORES: CategoryScore[] = WORKED_EXAMPLE_CATEGORIES.map(
  (cat, i) => ({
    category_id: cat.id,
    score: WORKED_EXAMPLE_SCORES[i],
    section_scores: null,
  })
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScoreAggregator', () => {
  const aggregator = new ScoreAggregator();

  // -----------------------------------------------------------------------
  // Test 1: TDD worked example (single reviewer, PRD)
  // -----------------------------------------------------------------------
  test('TDD worked example: single reviewer PRD scores produce 80.95', () => {
    const result = aggregator.computeWeightedScore(
      WORKED_EXAMPLE_CATEGORY_SCORES,
      WORKED_EXAMPLE_RUBRIC
    );
    expect(result).toBe(80.95);
  });

  // -----------------------------------------------------------------------
  // Test 2: TDD worked example (two reviewers, TDD, mean)
  // -----------------------------------------------------------------------
  test('TDD worked example: two-reviewer mean aggregation produces 84.58', () => {
    // Build a simple rubric where the weighted scores will be 87.50 and 81.65
    // We use a single-category rubric with weight 1.0 to directly control weighted scores
    const singleCatRubric = makeRubric([{ id: 'overall', weight: 1.0 }], 'TDD');

    const reviewerA: ReviewOutput = {
      reviewer_id: 'reviewer_a',
      category_scores: [{ category_id: 'overall', score: 87.50, section_scores: null }],
      findings: [],
    };

    const reviewerB: ReviewOutput = {
      reviewer_id: 'reviewer_b',
      category_scores: [{ category_id: 'overall', score: 81.65, section_scores: null }],
      findings: [],
    };

    const result = aggregator.aggregateScores(
      [reviewerA, reviewerB],
      singleCatRubric,
      'mean'
    );

    expect(result.aggregate_score).toBe(84.58);
    expect(result.per_reviewer_scores).toHaveLength(2);
    expect(result.per_reviewer_scores[0].weighted_score).toBe(87.50);
    expect(result.per_reviewer_scores[1].weighted_score).toBe(81.65);
  });

  // -----------------------------------------------------------------------
  // Test 3: Median with 3 reviewers
  // -----------------------------------------------------------------------
  test('Median with 3 reviewers [80, 85, 90] returns 85', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewers: ReviewOutput[] = [80, 85, 90].map((score, i) =>
      makeReviewOutput(`r${i}`, [{ category_id: 'overall', score }])
    );

    const result = aggregator.aggregateScores(reviewers, rubric, 'median');
    expect(result.aggregate_score).toBe(85);
  });

  // -----------------------------------------------------------------------
  // Test 4: Median with 2 reviewers
  // -----------------------------------------------------------------------
  test('Median with 2 reviewers [80, 90] returns 85 (mean of two middle values)', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewers: ReviewOutput[] = [80, 90].map((score, i) =>
      makeReviewOutput(`r${i}`, [{ category_id: 'overall', score }])
    );

    const result = aggregator.aggregateScores(reviewers, rubric, 'median');
    expect(result.aggregate_score).toBe(85);
  });

  // -----------------------------------------------------------------------
  // Test 5: Min aggregation
  // -----------------------------------------------------------------------
  test('Min aggregation [80, 85, 90] returns 80', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewers: ReviewOutput[] = [80, 85, 90].map((score, i) =>
      makeReviewOutput(`r${i}`, [{ category_id: 'overall', score }])
    );

    const result = aggregator.aggregateScores(reviewers, rubric, 'min');
    expect(result.aggregate_score).toBe(80);
  });

  // -----------------------------------------------------------------------
  // Test 6: Single reviewer, all methods return same score
  // -----------------------------------------------------------------------
  test('Single reviewer: all aggregation methods return 75', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewer = makeReviewOutput('r0', [{ category_id: 'overall', score: 75 }]);

    for (const method of ['mean', 'median', 'min'] as const) {
      const result = aggregator.aggregateScores([reviewer], rubric, method);
      expect(result.aggregate_score).toBe(75);
    }
  });

  // -----------------------------------------------------------------------
  // Test 7: All identical scores
  // -----------------------------------------------------------------------
  test('Three reviewers all scoring 82: all methods return 82', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewers = [0, 1, 2].map((i) =>
      makeReviewOutput(`r${i}`, [{ category_id: 'overall', score: 82 }])
    );

    for (const method of ['mean', 'median', 'min'] as const) {
      const result = aggregator.aggregateScores(reviewers, rubric, method);
      expect(result.aggregate_score).toBe(82);
    }
  });

  // -----------------------------------------------------------------------
  // Test 8: Multi-section category minimum
  // -----------------------------------------------------------------------
  test('resolveCategoryScore returns minimum of section scores', () => {
    const catScore: CategoryScore = {
      category_id: 'internal_consistency',
      score: 80,
      section_scores: [
        { section_id: 'goals', score: 90 },
        { section_id: 'user_stories', score: 70 },
      ],
    };

    expect(aggregator.resolveCategoryScore(catScore)).toBe(70);
  });

  // -----------------------------------------------------------------------
  // Test 9: Document-level scoring (null section_scores)
  // -----------------------------------------------------------------------
  test('resolveCategoryScore returns score field when section_scores is null', () => {
    const catScore: CategoryScore = {
      category_id: 'completeness',
      score: 85,
      section_scores: null,
    };

    expect(aggregator.resolveCategoryScore(catScore)).toBe(85);
  });

  // -----------------------------------------------------------------------
  // Test 10: Empty reviewer array
  // -----------------------------------------------------------------------
  test('Empty reviewer array returns NaN for aggregate', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const result = aggregator.aggregateScores([], rubric, 'mean');
    expect(result.aggregate_score).toBeNaN();
    expect(result.per_reviewer_scores).toHaveLength(0);
    expect(result.category_aggregates).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 11: Zero-weight category
  // -----------------------------------------------------------------------
  test('Zero-weight category is excluded from sum; remaining categories produce correct result', () => {
    const rubric = makeRubric([
      { id: 'cat_a', weight: 0.0 },
      { id: 'cat_b', weight: 0.6 },
      { id: 'cat_c', weight: 0.4 },
    ]);

    const scores: CategoryScore[] = [
      { category_id: 'cat_a', score: 100, section_scores: null },
      { category_id: 'cat_b', score: 80, section_scores: null },
      { category_id: 'cat_c', score: 70, section_scores: null },
    ];

    // Expected: 0*100 + 0.6*80 + 0.4*70 = 0 + 48 + 28 = 76
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const result = aggregator.computeWeightedScore(scores, rubric);
    expect(result).toBe(76);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Category 'cat_a' has weight 0")
    );
    warnSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Test 12: Per-category aggregation
  // -----------------------------------------------------------------------
  test('Per-category aggregation: two reviewers, mean of problem_clarity is 85', () => {
    const rubric = makeRubric([{ id: 'problem_clarity', weight: 1.0, minimumScore: 70 }]);

    const reviewerA = makeReviewOutput('a', [{ category_id: 'problem_clarity', score: 90 }]);
    const reviewerB = makeReviewOutput('b', [{ category_id: 'problem_clarity', score: 80 }]);

    const result = aggregator.aggregateScores([reviewerA, reviewerB], rubric, 'mean');

    expect(result.category_aggregates).toHaveLength(1);
    expect(result.category_aggregates[0].category_id).toBe('problem_clarity');
    expect(result.category_aggregates[0].aggregate_score).toBe(85);
    expect(result.category_aggregates[0].per_reviewer_scores).toHaveLength(2);
    expect(result.category_aggregates[0].threshold_violated).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Additional: Median with 5 reviewers
  // -----------------------------------------------------------------------
  test('Median with 5 reviewers [70, 75, 80, 85, 90] returns 80', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewers = [70, 75, 80, 85, 90].map((score, i) =>
      makeReviewOutput(`r${i}`, [{ category_id: 'overall', score }])
    );

    const result = aggregator.aggregateScores(reviewers, rubric, 'median');
    expect(result.aggregate_score).toBe(80);
  });

  // -----------------------------------------------------------------------
  // Additional: Median with 1 reviewer
  // -----------------------------------------------------------------------
  test('Median with 1 reviewer returns that score', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewer = makeReviewOutput('r0', [{ category_id: 'overall', score: 77 }]);

    const result = aggregator.aggregateScores([reviewer], rubric, 'median');
    expect(result.aggregate_score).toBe(77);
  });

  // -----------------------------------------------------------------------
  // Additional: Per-section scoring integrated with weighted score
  // -----------------------------------------------------------------------
  test('Multi-section category uses minimum when computing weighted score', () => {
    const rubric = makeRubric([
      { id: 'cat_a', weight: 0.5 },
      { id: 'cat_b', weight: 0.5 },
    ]);

    const scores: CategoryScore[] = [
      {
        category_id: 'cat_a',
        score: 90,
        section_scores: [
          { section_id: 'sec1', score: 90 },
          { section_id: 'sec2', score: 60 },
        ],
      },
      { category_id: 'cat_b', score: 80, section_scores: null },
    ];

    // cat_a resolved = min(90, 60) = 60
    // weighted = 0.5 * 60 + 0.5 * 80 = 30 + 40 = 70
    const result = aggregator.computeWeightedScore(scores, rubric);
    expect(result).toBe(70);
  });

  // -----------------------------------------------------------------------
  // Additional: Category aggregate threshold_violated
  // -----------------------------------------------------------------------
  test('Per-category aggregate flags threshold_violated when below minimumScore', () => {
    const rubric = makeRubric([{ id: 'strict_cat', weight: 1.0, minimumScore: 90 }]);

    const reviewerA = makeReviewOutput('a', [{ category_id: 'strict_cat', score: 85 }]);
    const reviewerB = makeReviewOutput('b', [{ category_id: 'strict_cat', score: 80 }]);

    const result = aggregator.aggregateScores([reviewerA, reviewerB], rubric, 'mean');

    expect(result.category_aggregates[0].aggregate_score).toBe(82.5);
    expect(result.category_aggregates[0].threshold_violated).toBe(true);
  });
});

// ===========================================================================
// TDD Worked Example Regression Tests (using fixtures)
// ===========================================================================

import {
  SINGLE_REVIEWER_PRD,
  TWO_REVIEWER_TDD_MEAN,
} from './fixtures/tdd-worked-examples';

describe('ScoreAggregator - TDD Worked Example Regression', () => {
  const aggregator = new ScoreAggregator();

  // -----------------------------------------------------------------------
  // Test 14: Single-reviewer PRD fixture produces 80.95
  // -----------------------------------------------------------------------
  test('Single-reviewer PRD fixture produces weighted score 80.95', () => {
    const rubric = SINGLE_REVIEWER_PRD.rubric;
    const categoryScores: CategoryScore[] = Object.entries(
      SINGLE_REVIEWER_PRD.scores
    ).map(([categoryId, score]) => ({
      category_id: categoryId,
      score,
      section_scores: null,
    }));

    // Build a QualityRubric from the fixture rubric for computeWeightedScore
    const qualityRubric: QualityRubric = {
      documentType: rubric.document_type,
      version: rubric.version,
      aggregationMethod: 'mean',
      categories: rubric.categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        weight: c.weight / 100,
        minimumScore: c.min_threshold ?? 0,
        scoringGuide: [
          { min: 0, max: 49, description: 'Poor' },
          { min: 50, max: 100, description: 'Good' },
        ],
      })),
    };

    const result = aggregator.computeWeightedScore(categoryScores, qualityRubric);
    expect(result).toBe(SINGLE_REVIEWER_PRD.expected_weighted_score);
  });

  // -----------------------------------------------------------------------
  // Test 15: Two-reviewer TDD fixture produces 84.58
  // -----------------------------------------------------------------------
  test('Two-reviewer TDD fixture produces aggregate mean score 84.58', () => {
    const rubric = TWO_REVIEWER_TDD_MEAN.rubric;

    const qualityRubric: QualityRubric = {
      documentType: rubric.document_type,
      version: rubric.version,
      aggregationMethod: 'mean',
      categories: rubric.categories.map((c) => ({
        id: c.id,
        name: c.name,
        description: c.description,
        weight: c.weight / 100,
        minimumScore: c.min_threshold ?? 0,
        scoringGuide: [
          { min: 0, max: 49, description: 'Poor' },
          { min: 50, max: 100, description: 'Good' },
        ],
      })),
    };

    const reviewerA: ReviewOutput = {
      reviewer_id: 'reviewer_a',
      category_scores: Object.entries(TWO_REVIEWER_TDD_MEAN.reviewer_a_scores).map(
        ([categoryId, score]) => ({
          category_id: categoryId,
          score,
          section_scores: null,
        })
      ),
      findings: [],
    };

    const reviewerB: ReviewOutput = {
      reviewer_id: 'reviewer_b',
      category_scores: Object.entries(TWO_REVIEWER_TDD_MEAN.reviewer_b_scores).map(
        ([categoryId, score]) => ({
          category_id: categoryId,
          score,
          section_scores: null,
        })
      ),
      findings: [],
    };

    // Verify individual weighted scores
    const reviewerAWeighted = aggregator.computeWeightedScore(
      reviewerA.category_scores,
      qualityRubric
    );
    expect(reviewerAWeighted).toBe(TWO_REVIEWER_TDD_MEAN.reviewer_a_weighted);

    const reviewerBWeighted = aggregator.computeWeightedScore(
      reviewerB.category_scores,
      qualityRubric
    );
    expect(reviewerBWeighted).toBe(TWO_REVIEWER_TDD_MEAN.reviewer_b_weighted);

    // Verify aggregate
    const result = aggregator.aggregateScores(
      [reviewerA, reviewerB],
      qualityRubric,
      'mean'
    );
    expect(result.aggregate_score).toBe(TWO_REVIEWER_TDD_MEAN.expected_aggregate_mean);
  });

  // -----------------------------------------------------------------------
  // Test 16: Two-reviewer TDD disagreement at security_depth
  // -----------------------------------------------------------------------
  test('Two-reviewer TDD: security_depth has variance of 15', () => {
    const { expected_disagreement, reviewer_a_scores, reviewer_b_scores } =
      TWO_REVIEWER_TDD_MEAN;

    const scoreA =
      reviewer_a_scores[
        expected_disagreement.category_id as keyof typeof reviewer_a_scores
      ];
    const scoreB =
      reviewer_b_scores[
        expected_disagreement.category_id as keyof typeof reviewer_b_scores
      ];

    const variance = Math.abs(scoreA - scoreB);

    expect(variance).toBe(expected_disagreement.variance);
    expect([scoreA, scoreB]).toEqual(expected_disagreement.scores);
  });
});

// ===========================================================================
// Property-Based and Edge-Case Tests
// ===========================================================================

describe('ScoreAggregator - Property-Based and Edge-Case Tests', () => {
  const aggregator = new ScoreAggregator();

  /**
   * Generates an array of random integers in 0-100.
   */
  function randomScores(count: number): number[] {
    return Array.from({ length: count }, () => Math.floor(Math.random() * 101));
  }

  /**
   * Generates an array of random weights summing to 100.
   */
  function randomWeights(count: number): number[] {
    // Generate random values and normalize to sum to 100
    const raw = Array.from({ length: count }, () => Math.random() + 0.01);
    const sum = raw.reduce((s, v) => s + v, 0);
    const normalized = raw.map((v) => Math.round((v / sum) * 10000) / 100);

    // Adjust last weight to ensure exact sum of 100
    const normSum = normalized.reduce((s, v) => s + v, 0);
    normalized[normalized.length - 1] += Math.round((100 - normSum) * 100) / 100;

    return normalized;
  }

  // -----------------------------------------------------------------------
  // Test 19: 100 random score sets always produce 0-100 result
  // -----------------------------------------------------------------------
  test('100 random (scores, weights) pairs always produce result in [0, 100]', () => {
    for (let trial = 0; trial < 100; trial++) {
      const numCategories = Math.floor(Math.random() * 7) + 1; // 1-7 categories
      const weights = randomWeights(numCategories);
      const scores = randomScores(numCategories);

      const rubric = makeRubric(
        weights.map((w, i) => ({
          id: `cat_${i}`,
          weight: w / 100, // QualityRubric uses 0-1 weights
        }))
      );

      const categoryScores: CategoryScore[] = scores.map((s, i) => ({
        category_id: `cat_${i}`,
        score: s,
        section_scores: null,
      }));

      const result = aggregator.computeWeightedScore(categoryScores, rubric);

      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(100);
    }
  });

  // -----------------------------------------------------------------------
  // Test 20: Determinism
  // -----------------------------------------------------------------------
  test('Same inputs through computeWeightedScore produce identical results', () => {
    const rubric = makeRubric([
      { id: 'a', weight: 0.3 },
      { id: 'b', weight: 0.3 },
      { id: 'c', weight: 0.4 },
    ]);

    const scores: CategoryScore[] = [
      { category_id: 'a', score: 72, section_scores: null },
      { category_id: 'b', score: 88, section_scores: null },
      { category_id: 'c', score: 65, section_scores: null },
    ];

    const result1 = aggregator.computeWeightedScore(scores, rubric);
    const result2 = aggregator.computeWeightedScore(scores, rubric);

    expect(result1).toBe(result2);
  });

  // -----------------------------------------------------------------------
  // Test 21: All-zero scores produce 0
  // -----------------------------------------------------------------------
  test('All-zero scores produce weighted result of 0', () => {
    const rubric = makeRubric([
      { id: 'a', weight: 0.5 },
      { id: 'b', weight: 0.5 },
    ]);

    const scores: CategoryScore[] = [
      { category_id: 'a', score: 0, section_scores: null },
      { category_id: 'b', score: 0, section_scores: null },
    ];

    const result = aggregator.computeWeightedScore(scores, rubric);
    expect(result).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 22: All-100 scores produce 100
  // -----------------------------------------------------------------------
  test('All-100 scores produce weighted result of 100', () => {
    const rubric = makeRubric([
      { id: 'a', weight: 0.5 },
      { id: 'b', weight: 0.5 },
    ]);

    const scores: CategoryScore[] = [
      { category_id: 'a', score: 100, section_scores: null },
      { category_id: 'b', score: 100, section_scores: null },
    ];

    const result = aggregator.computeWeightedScore(scores, rubric);
    expect(result).toBe(100);
  });

  // -----------------------------------------------------------------------
  // Test 23: Score exactly at threshold passes
  // -----------------------------------------------------------------------
  test('Aggregate 85.00 at threshold 85 is a pass', () => {
    // This is verified at the ApprovalEvaluator level, but we assert
    // the aggregator produces the exact value for downstream checks.
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewer = makeReviewOutput('r0', [{ category_id: 'overall', score: 85 }]);

    const result = aggregator.aggregateScores([reviewer], rubric, 'mean');
    expect(result.aggregate_score).toBe(85);
    // Threshold comparison: 85 >= 85 = true
    expect(result.aggregate_score >= 85).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 24: Score 0.01 below threshold fails
  // -----------------------------------------------------------------------
  test('Aggregate 84.99 at threshold 85 is a fail', () => {
    const rubric = makeRubric([{ id: 'overall', weight: 1.0 }]);
    const reviewer = makeReviewOutput('r0', [{ category_id: 'overall', score: 84.99 }]);

    const result = aggregator.aggregateScores([reviewer], rubric, 'mean');
    expect(result.aggregate_score).toBe(84.99);
    // Threshold comparison: 84.99 >= 85 = false
    expect(result.aggregate_score >= 85).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Additional: ApprovalEvaluator determinism
  // -----------------------------------------------------------------------
  test('ApprovalEvaluator is deterministic for identical inputs', () => {
    // Import here to avoid issues; test is about determinism
    const { ApprovalEvaluator } = require('../../src/review-gate/approval-evaluator');
    const evalr = new ApprovalEvaluator();

    const rubric = makeRubric([{ id: 'overall', weight: 1.0, minimumScore: 60 }]);
    const aggResult = {
      aggregate_score: 80,
      per_reviewer_scores: [{ reviewer_id: 'r1', weighted_score: 80 }],
      category_aggregates: [],
    };
    const reviewerOutputs = [
      makeReviewOutput('r1', [{ category_id: 'overall', score: 80 }]),
    ];

    const result1 = evalr.evaluate(aggResult, reviewerOutputs, rubric, 1, 3);
    const result2 = evalr.evaluate(aggResult, reviewerOutputs, rubric, 1, 3);

    expect(result1.outcome).toBe(result2.outcome);
    expect(result1.threshold_met).toBe(result2.threshold_met);
    expect(result1.has_critical_blocking).toBe(result2.has_critical_blocking);
    expect(result1.has_critical_reject).toBe(result2.has_critical_reject);
    expect(result1.floor_violations.length).toBe(result2.floor_violations.length);
  });
});
