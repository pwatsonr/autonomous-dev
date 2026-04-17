import { QualityRubric } from '../../src/pipeline/types/quality-rubric';
import {
  AggregationResult,
  ReviewOutput,
  Finding,
  CategoryAggregate,
} from '../../src/review-gate/score-aggregator';
import { ApprovalEvaluator } from '../../src/review-gate/approval-evaluator';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a rubric with approval_threshold included (extended type).
 */
function makeRubricWithThreshold(
  categories: { id: string; name?: string; weight: number; minimumScore: number }[],
  approvalThreshold: number
): QualityRubric & { approval_threshold: number } {
  return {
    documentType: 'PRD',
    version: '1.0',
    aggregationMethod: 'mean',
    approval_threshold: approvalThreshold,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name ?? c.id,
      description: `Measures ${c.id}`,
      weight: c.weight,
      minimumScore: c.minimumScore,
      scoringGuide: [
        { min: 0, max: 49, description: 'Poor' },
        { min: 50, max: 100, description: 'Good' },
      ],
    })),
  };
}

/**
 * Creates a minimal AggregationResult with the given aggregate score.
 */
function makeAggregationResult(
  aggregateScore: number,
  perReviewerScores: { reviewer_id: string; weighted_score: number }[] = [],
  categoryAggregates: CategoryAggregate[] = []
): AggregationResult {
  return {
    aggregate_score: aggregateScore,
    per_reviewer_scores: perReviewerScores,
    category_aggregates: categoryAggregates,
  };
}

/**
 * Creates a ReviewOutput with optional findings.
 */
function makeReviewOutput(
  reviewerId: string,
  scores: { category_id: string; score: number }[],
  findings: Finding[] = []
): ReviewOutput {
  return {
    reviewer_id: reviewerId,
    category_scores: scores.map((s) => ({
      category_id: s.category_id,
      score: s.score,
      section_scores: null,
    })),
    findings,
  };
}

// Default rubric: single category, threshold 85
const DEFAULT_RUBRIC = makeRubricWithThreshold(
  [{ id: 'completeness', name: 'Completeness', weight: 1.0, minimumScore: 50 }],
  85
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalEvaluator', () => {
  const evaluator = new ApprovalEvaluator();

  // -----------------------------------------------------------------------
  // Test 1: All conditions pass -- approved
  // -----------------------------------------------------------------------
  test('All conditions pass: aggregate 86, threshold 85 => approved', () => {
    const aggResult = makeAggregationResult(86, [
      { reviewer_id: 'r1', weighted_score: 86 },
    ]);
    const reviewer = makeReviewOutput('r1', [{ category_id: 'completeness', score: 86 }]);

    const decision = evaluator.evaluate(aggResult, [reviewer], DEFAULT_RUBRIC, 1, 3);

    expect(decision.outcome).toBe('approved');
    expect(decision.threshold_met).toBe(true);
    expect(decision.has_critical_blocking).toBe(false);
    expect(decision.has_critical_reject).toBe(false);
    expect(decision.floor_violations).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 2: Score exactly at threshold -- approved
  // -----------------------------------------------------------------------
  test('Score exactly at threshold: aggregate 85, threshold 85 => approved', () => {
    const aggResult = makeAggregationResult(85, [
      { reviewer_id: 'r1', weighted_score: 85 },
    ]);
    const reviewer = makeReviewOutput('r1', [{ category_id: 'completeness', score: 85 }]);

    const decision = evaluator.evaluate(aggResult, [reviewer], DEFAULT_RUBRIC, 1, 3);

    expect(decision.outcome).toBe('approved');
    expect(decision.threshold_met).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 3: Score one below threshold -- changes_requested
  // -----------------------------------------------------------------------
  test('Score below threshold: aggregate 84.99, threshold 85 => changes_requested', () => {
    const aggResult = makeAggregationResult(84.99, [
      { reviewer_id: 'r1', weighted_score: 84.99 },
    ]);
    const reviewer = makeReviewOutput('r1', [{ category_id: 'completeness', score: 84.99 }]);

    const decision = evaluator.evaluate(aggResult, [reviewer], DEFAULT_RUBRIC, 1, 3);

    expect(decision.outcome).toBe('changes_requested');
    expect(decision.threshold_met).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 4: Critical blocking finding -- changes_requested
  // -----------------------------------------------------------------------
  test('Critical blocking finding: aggregate 90 => changes_requested', () => {
    const aggResult = makeAggregationResult(90, [
      { reviewer_id: 'r1', weighted_score: 90 },
    ]);
    const blockingFinding: Finding = {
      severity: 'critical',
      critical_sub: 'blocking',
      section_id: 'problem_statement',
      category_id: 'completeness',
      description: 'Missing critical section',
      evidence: 'Section is empty',
      suggested_resolution: 'Fill in the section',
    };
    const reviewer = makeReviewOutput(
      'r1',
      [{ category_id: 'completeness', score: 90 }],
      [blockingFinding]
    );

    const decision = evaluator.evaluate(aggResult, [reviewer], DEFAULT_RUBRIC, 1, 3);

    expect(decision.outcome).toBe('changes_requested');
    expect(decision.has_critical_blocking).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 5: Critical reject finding -- rejected
  // -----------------------------------------------------------------------
  test('Critical reject finding: aggregate 90 => rejected immediately', () => {
    const aggResult = makeAggregationResult(90, [
      { reviewer_id: 'r1', weighted_score: 90 },
    ]);
    const rejectFinding: Finding = {
      severity: 'critical',
      critical_sub: 'reject',
      section_id: 'problem_statement',
      category_id: 'completeness',
      description: 'Fundamentally flawed approach',
      evidence: 'Approach contradicts requirements',
      suggested_resolution: 'Complete rewrite needed',
    };
    const reviewer = makeReviewOutput(
      'r1',
      [{ category_id: 'completeness', score: 90 }],
      [rejectFinding]
    );

    const decision = evaluator.evaluate(aggResult, [reviewer], DEFAULT_RUBRIC, 1, 3);

    expect(decision.outcome).toBe('rejected');
    expect(decision.has_critical_reject).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 6: Floor violation -- changes_requested
  // -----------------------------------------------------------------------
  test('Floor violation: aggregate 86, category below min_threshold => changes_requested', () => {
    const rubric = makeRubricWithThreshold(
      [{ id: 'risk_identification', name: 'Risk Identification', weight: 1.0, minimumScore: 50 }],
      85
    );
    const aggResult = makeAggregationResult(86, [
      { reviewer_id: 'r1', weighted_score: 86 },
    ]);
    // Reviewer scored the category at 40, below minimumScore of 50
    const reviewer = makeReviewOutput('r1', [
      { category_id: 'risk_identification', score: 40 },
    ]);

    const decision = evaluator.evaluate(aggResult, [reviewer], rubric, 1, 3);

    expect(decision.outcome).toBe('changes_requested');
    expect(decision.floor_violations).toHaveLength(1);
    expect(decision.floor_violations[0].category_id).toBe('risk_identification');
    expect(decision.floor_violations[0].score).toBe(40);
    expect(decision.floor_violations[0].min_threshold).toBe(50);
    expect(decision.floor_violations[0].reviewer_id).toBe('r1');
  });

  // -----------------------------------------------------------------------
  // Test 7: Floor violation auto-generated finding content
  // -----------------------------------------------------------------------
  test('Floor violation auto-generated finding has correct content', () => {
    const rubric = makeRubricWithThreshold(
      [{ id: 'risk_identification', name: 'Risk Identification', weight: 1.0, minimumScore: 50 }],
      85
    );
    const aggResult = makeAggregationResult(86, [
      { reviewer_id: 'r1', weighted_score: 86 },
    ]);
    const reviewer = makeReviewOutput('r1', [
      { category_id: 'risk_identification', score: 40 },
    ]);

    const decision = evaluator.evaluate(aggResult, [reviewer], rubric, 1, 3);

    expect(decision.auto_generated_findings).toHaveLength(1);
    const finding = decision.auto_generated_findings[0];
    expect(finding.severity).toBe('major');
    expect(finding.category_id).toBe('risk_identification');
    expect(finding.description).toContain('Risk Identification');
    expect(finding.description).toContain('40');
    expect(finding.description).toContain('50');
    expect(finding.description).toContain('r1');
    expect(finding.evidence).toContain('r1');
    expect(finding.evidence).toContain('40');
    expect(finding.evidence).toContain('50');
    expect(finding.suggested_resolution).toContain('Risk Identification');
    expect(finding.suggested_resolution).toContain('50');
  });

  // -----------------------------------------------------------------------
  // Test 8: Multiple floor violations
  // -----------------------------------------------------------------------
  test('Multiple floor violations produce multiple auto-generated findings', () => {
    const rubric = makeRubricWithThreshold(
      [
        { id: 'cat_a', name: 'Category A', weight: 0.5, minimumScore: 60 },
        { id: 'cat_b', name: 'Category B', weight: 0.5, minimumScore: 70 },
      ],
      85
    );
    const aggResult = makeAggregationResult(86, [
      { reviewer_id: 'r1', weighted_score: 86 },
    ]);
    const reviewer = makeReviewOutput('r1', [
      { category_id: 'cat_a', score: 50 },
      { category_id: 'cat_b', score: 60 },
    ]);

    const decision = evaluator.evaluate(aggResult, [reviewer], rubric, 1, 3);

    expect(decision.outcome).toBe('changes_requested');
    expect(decision.floor_violations).toHaveLength(2);
    expect(decision.auto_generated_findings).toHaveLength(2);
  });

  // -----------------------------------------------------------------------
  // Test 9: NaN aggregate -- changes_requested
  // -----------------------------------------------------------------------
  test('NaN aggregate score => changes_requested', () => {
    const aggResult = makeAggregationResult(NaN);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const decision = evaluator.evaluate(aggResult, [], DEFAULT_RUBRIC, 1, 3);
    errorSpy.mockRestore();

    expect(decision.outcome).toBe('changes_requested');
    expect(decision.threshold_met).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 10: Infinity aggregate -- changes_requested
  // -----------------------------------------------------------------------
  test('Infinity aggregate score => changes_requested', () => {
    const aggResult = makeAggregationResult(Infinity);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const decision = evaluator.evaluate(aggResult, [], DEFAULT_RUBRIC, 1, 3);
    errorSpy.mockRestore();

    expect(decision.outcome).toBe('changes_requested');
    expect(decision.threshold_met).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 11: No reviewers, no findings -- NaN aggregate => changes_requested
  // -----------------------------------------------------------------------
  test('No reviewers: empty outputs, NaN aggregate => changes_requested', () => {
    const aggResult = makeAggregationResult(NaN);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const decision = evaluator.evaluate(aggResult, [], DEFAULT_RUBRIC, 1, 3);
    errorSpy.mockRestore();

    expect(decision.outcome).toBe('changes_requested');
  });

  // -----------------------------------------------------------------------
  // Test 12: Critical reject takes precedence over score pass
  // -----------------------------------------------------------------------
  test('Critical reject takes precedence even when score passes threshold', () => {
    const aggResult = makeAggregationResult(95, [
      { reviewer_id: 'r1', weighted_score: 95 },
    ]);
    const rejectFinding: Finding = {
      severity: 'critical',
      critical_sub: 'reject',
      section_id: 'architecture',
      category_id: 'completeness',
      description: 'Architectural approach is fundamentally flawed',
      evidence: 'Cannot scale beyond single node',
      suggested_resolution: 'Redesign architecture',
    };
    const reviewer = makeReviewOutput(
      'r1',
      [{ category_id: 'completeness', score: 95 }],
      [rejectFinding]
    );

    const decision = evaluator.evaluate(aggResult, [reviewer], DEFAULT_RUBRIC, 1, 3);

    expect(decision.outcome).toBe('rejected');
    expect(decision.has_critical_reject).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Additional: Max iterations reached with failing score => rejected
  // -----------------------------------------------------------------------
  test('Max iterations reached with failing score => rejected', () => {
    const aggResult = makeAggregationResult(80, [
      { reviewer_id: 'r1', weighted_score: 80 },
    ]);
    const reviewer = makeReviewOutput('r1', [{ category_id: 'completeness', score: 80 }]);

    const decision = evaluator.evaluate(aggResult, [reviewer], DEFAULT_RUBRIC, 3, 3);

    expect(decision.outcome).toBe('rejected');
    expect(decision.reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Iteration count 3'),
      ])
    );
  });

  // -----------------------------------------------------------------------
  // Additional: Negative infinity aggregate => changes_requested
  // -----------------------------------------------------------------------
  test('Negative Infinity aggregate score => changes_requested', () => {
    const aggResult = makeAggregationResult(-Infinity);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const decision = evaluator.evaluate(aggResult, [], DEFAULT_RUBRIC, 1, 3);
    errorSpy.mockRestore();

    expect(decision.outcome).toBe('changes_requested');
  });

  // -----------------------------------------------------------------------
  // Additional: Approved has empty reasons array
  // -----------------------------------------------------------------------
  test('Approved decision has empty reasons array', () => {
    const aggResult = makeAggregationResult(90, [
      { reviewer_id: 'r1', weighted_score: 90 },
    ]);
    const reviewer = makeReviewOutput('r1', [{ category_id: 'completeness', score: 90 }]);

    const decision = evaluator.evaluate(aggResult, [reviewer], DEFAULT_RUBRIC, 1, 3);

    expect(decision.outcome).toBe('approved');
    expect(decision.reasons).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Additional: Critical blocking + floor violation = changes_requested
  // -----------------------------------------------------------------------
  test('Critical blocking combined with floor violation => changes_requested', () => {
    const rubric = makeRubricWithThreshold(
      [{ id: 'cat_a', name: 'Category A', weight: 1.0, minimumScore: 70 }],
      85
    );
    const aggResult = makeAggregationResult(90, [
      { reviewer_id: 'r1', weighted_score: 90 },
    ]);
    const blockingFinding: Finding = {
      severity: 'critical',
      critical_sub: 'blocking',
      section_id: 'overview',
      category_id: 'cat_a',
      description: 'Blocking issue found',
      evidence: 'Evidence here',
      suggested_resolution: 'Fix it',
    };
    const reviewer = makeReviewOutput(
      'r1',
      [{ category_id: 'cat_a', score: 60 }],
      [blockingFinding]
    );

    const decision = evaluator.evaluate(aggResult, [reviewer], rubric, 1, 3);

    expect(decision.outcome).toBe('changes_requested');
    expect(decision.has_critical_blocking).toBe(true);
    expect(decision.floor_violations).toHaveLength(1);
  });
});
