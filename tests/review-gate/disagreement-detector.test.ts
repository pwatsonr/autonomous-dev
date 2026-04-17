/**
 * Unit tests for DisagreementDetector (SPEC-004-2-4).
 *
 * Covers all 16 test cases from the spec:
 * - TDD worked example
 * - Threshold boundary conditions
 * - Single/no reviewer edge cases
 * - Multiple disagreements and sort order
 * - Three-reviewer pairwise max variance
 * - Low confidence and significant divergence notes
 * - Missing category treated as score 0
 * - Custom threshold configuration
 * - All identical scores
 */

import type { Rubric, RubricCategory, ReviewOutput, CategoryScore, Disagreement } from '../../src/review-gate/types';
import {
  DisagreementDetector,
  DisagreementConfig,
  DEFAULT_DISAGREEMENT_CONFIG,
} from '../../src/review-gate/disagreement-detector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal Rubric with the given categories for testing.
 * Weights need not sum to 100 for disagreement detection tests.
 */
function buildRubric(
  categories: { id: string; name: string; weight?: number; min_threshold?: number | null }[],
): Rubric {
  return {
    document_type: 'TDD',
    version: '1.0.0',
    approval_threshold: 85,
    total_weight: 100,
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      weight: c.weight ?? 10,
      description: `Measures ${c.name}`,
      min_threshold: c.min_threshold ?? null,
      calibration: {
        score_0: `No ${c.name.toLowerCase()}`,
        score_50: `Partial ${c.name.toLowerCase()}`,
        score_100: `Comprehensive ${c.name.toLowerCase()}`,
      },
    })),
  };
}

/**
 * Build a minimal ReviewOutput with given category scores.
 */
function buildReviewOutput(
  reviewerId: string,
  scores: Record<string, number>,
): ReviewOutput {
  return {
    reviewer_id: reviewerId,
    reviewer_role: 'test-role',
    document_id: 'doc-1',
    document_version: '1.0',
    timestamp: '2026-04-08T12:00:00Z',
    scoring_mode: 'document_level',
    category_scores: Object.entries(scores).map(([category_id, score]) => ({
      category_id,
      score,
      section_scores: null,
      justification: `Score ${score} for ${category_id}`,
    })),
    findings: [],
    summary: 'Test review output',
  };
}

// ---------------------------------------------------------------------------
// TDD worked example rubric (subset)
// ---------------------------------------------------------------------------

const TDD_RUBRIC = buildRubric([
  { id: 'architecture_soundness', name: 'Architecture Soundness', weight: 20 },
  { id: 'tradeoff_rigor', name: 'Tradeoff Rigor', weight: 15 },
  { id: 'data_model_integrity', name: 'Data Model Integrity', weight: 15 },
  { id: 'api_contract_completeness', name: 'API Contract Completeness', weight: 15 },
  { id: 'integration_robustness', name: 'Integration Robustness', weight: 10 },
  { id: 'security_depth', name: 'Security Depth', weight: 10 },
  { id: 'prd_alignment', name: 'PRD Alignment', weight: 15 },
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DisagreementDetector', () => {
  let detector: DisagreementDetector;

  beforeEach(() => {
    detector = new DisagreementDetector();
  });

  // --- Test case 1: TDD worked example ---
  it('1. TDD worked example: security_depth [75, 60] flagged at threshold 15', () => {
    const reviewerA = buildReviewOutput('reviewer-a', {
      architecture_soundness: 90,
      tradeoff_rigor: 85,
      data_model_integrity: 88,
      api_contract_completeness: 92,
      integration_robustness: 80,
      security_depth: 75,
      prd_alignment: 95,
    });
    const reviewerB = buildReviewOutput('reviewer-b', {
      architecture_soundness: 82,
      tradeoff_rigor: 88,
      data_model_integrity: 85,
      api_contract_completeness: 80,
      integration_robustness: 78,
      security_depth: 60,
      prd_alignment: 90,
    });

    const disagreements = detector.detect([reviewerA, reviewerB], TDD_RUBRIC);

    // security_depth: |75-60| = 15 -> flagged
    // api_contract_completeness: |92-80| = 12 -> not flagged
    // Others have smaller differences
    const securityDisagreement = disagreements.find((d) => d.category_id === 'security_depth');
    expect(securityDisagreement).toBeDefined();
    expect(securityDisagreement!.variance).toBe(15);
    expect(securityDisagreement!.reviewer_scores).toEqual([
      { reviewer_id: 'reviewer-a', score: 75 },
      { reviewer_id: 'reviewer-b', score: 60 },
    ]);
  });

  // --- Test case 2: Below threshold ---
  it('2. Below threshold: problem_clarity [85, 75] variance 10 < 15, not flagged', () => {
    const rubric = buildRubric([
      { id: 'problem_clarity', name: 'Problem Clarity' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { problem_clarity: 85 });
    const reviewerB = buildReviewOutput('reviewer-b', { problem_clarity: 75 });

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toHaveLength(0);
  });

  // --- Test case 3: Exactly at threshold ---
  it('3. Exactly at threshold: variance 15 is flagged (>= not >)', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 80 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 65 });

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].variance).toBe(15);
  });

  // --- Test case 4: One point below threshold ---
  it('4. One point below threshold: variance 14, not flagged', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 80 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 66 });

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toHaveLength(0);
  });

  // --- Test case 5: Single reviewer returns empty ---
  it('5. Single reviewer returns empty array', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 50 });

    const disagreements = detector.detect([reviewerA], rubric);
    expect(disagreements).toEqual([]);
  });

  // --- Test case 6: No reviewers returns empty ---
  it('6. No reviewers returns empty array', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);

    const disagreements = detector.detect([], rubric);
    expect(disagreements).toEqual([]);
  });

  // --- Test case 7: Multiple disagreements ---
  it('7. Multiple disagreements: two categories exceed threshold, returns 2 Disagreement objects', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
      { id: 'cat_b', name: 'Category B' },
      { id: 'cat_c', name: 'Category C' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 90, cat_b: 50, cat_c: 80 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 70, cat_b: 30, cat_c: 78 });
    // cat_a: |90-70| = 20 -> flagged
    // cat_b: |50-30| = 20 -> flagged
    // cat_c: |80-78| = 2 -> not flagged

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toHaveLength(2);
    expect(disagreements.map((d) => d.category_id)).toContain('cat_a');
    expect(disagreements.map((d) => d.category_id)).toContain('cat_b');
  });

  // --- Test case 8: Sorted by variance ---
  it('8. Sorted by variance: Category B (25) appears before Category A (20)', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
      { id: 'cat_b', name: 'Category B' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 90, cat_b: 95 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 70, cat_b: 70 });
    // cat_a: |90-70| = 20
    // cat_b: |95-70| = 25

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toHaveLength(2);
    expect(disagreements[0].category_id).toBe('cat_b');
    expect(disagreements[0].variance).toBe(25);
    expect(disagreements[1].category_id).toBe('cat_a');
    expect(disagreements[1].variance).toBe(20);
  });

  // --- Test case 9: Three reviewers ---
  it('9. Three reviewers: [90, 60, 75] max pairwise = |90-60| = 30, flagged', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 90 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 60 });
    const reviewerC = buildReviewOutput('reviewer-c', { cat_a: 75 });

    const disagreements = detector.detect([reviewerA, reviewerB, reviewerC], rubric);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].variance).toBe(30);
    expect(disagreements[0].reviewer_scores).toHaveLength(3);
  });

  // --- Test case 10: Three reviewers -- pairwise, not std ---
  it('10. Three reviewers [80, 60, 70]: max pairwise = |80-60| = 20, flagged', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 80 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 60 });
    const reviewerC = buildReviewOutput('reviewer-c', { cat_a: 70 });

    const disagreements = detector.detect([reviewerA, reviewerB, reviewerC], rubric);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].variance).toBe(20);
  });

  // --- Test case 11: Low confidence note for panel of 2 ---
  it('11. Low confidence note for panel of 2: note contains "limited data" and "lower confidence"', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 90 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 70 });

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].note).toContain('limited data');
    expect(disagreements[0].note).toContain('lower confidence');
  });

  // --- Test case 12: No low confidence note for panel of 3 ---
  it('12. No low confidence note for panel of 3', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 90 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 60 });
    const reviewerC = buildReviewOutput('reviewer-c', { cat_a: 75 });

    const disagreements = detector.detect([reviewerA, reviewerB, reviewerC], rubric);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].note).not.toContain('lower confidence');
  });

  // --- Test case 13: Significant divergence note ---
  it('13. Significant divergence note: variance 30 includes "significant divergence"', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 90 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 60 });

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].variance).toBe(30);
    expect(disagreements[0].note).toContain('significant divergence');
  });

  // --- Test case 14: Missing category treated as 0 ---
  it('14. Missing category treated as 0: reviewer B has no security_depth, variance = |75-0| = 75', () => {
    const rubric = buildRubric([
      { id: 'security_depth', name: 'Security Depth' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { security_depth: 75 });
    // Reviewer B has no security_depth category score
    const reviewerB: ReviewOutput = {
      reviewer_id: 'reviewer-b',
      reviewer_role: 'test-role',
      document_id: 'doc-1',
      document_version: '1.0',
      timestamp: '2026-04-08T12:00:00Z',
      scoring_mode: 'document_level',
      category_scores: [],
      findings: [],
      summary: 'Test review output',
    };

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].variance).toBe(75);
    expect(disagreements[0].reviewer_scores).toEqual([
      { reviewer_id: 'reviewer-a', score: 75 },
      { reviewer_id: 'reviewer-b', score: 0 },
    ]);
  });

  // --- Test case 15: Custom threshold ---
  it('15. Custom threshold: variance_threshold 10, variance 12 is flagged, variance 8 is not', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
      { id: 'cat_b', name: 'Category B' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 80, cat_b: 80 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 68, cat_b: 72 });
    // cat_a: |80-68| = 12 -> flagged with threshold 10
    // cat_b: |80-72| = 8 -> not flagged

    const disagreements = detector.detect(
      [reviewerA, reviewerB],
      rubric,
      { variance_threshold: 10 },
    );
    expect(disagreements).toHaveLength(1);
    expect(disagreements[0].category_id).toBe('cat_a');
    expect(disagreements[0].variance).toBe(12);
  });

  // --- Test case 16: All identical scores ---
  it('16. All identical scores: two reviewers, same scores on all categories, returns []', () => {
    const rubric = buildRubric([
      { id: 'cat_a', name: 'Category A' },
      { id: 'cat_b', name: 'Category B' },
      { id: 'cat_c', name: 'Category C' },
    ]);
    const reviewerA = buildReviewOutput('reviewer-a', { cat_a: 85, cat_b: 90, cat_c: 75 });
    const reviewerB = buildReviewOutput('reviewer-b', { cat_a: 85, cat_b: 90, cat_c: 75 });

    const disagreements = detector.detect([reviewerA, reviewerB], rubric);
    expect(disagreements).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_DISAGREEMENT_CONFIG validation
// ---------------------------------------------------------------------------

describe('DEFAULT_DISAGREEMENT_CONFIG', () => {
  it('has variance_threshold of 15', () => {
    expect(DEFAULT_DISAGREEMENT_CONFIG.variance_threshold).toBe(15);
  });

  it('has low_confidence_panel_size of 2', () => {
    expect(DEFAULT_DISAGREEMENT_CONFIG.low_confidence_panel_size).toBe(2);
  });
});
