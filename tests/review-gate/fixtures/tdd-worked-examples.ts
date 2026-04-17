/**
 * TDD worked example data encoded as typed test fixtures.
 *
 * These fixtures reproduce the exact numbers from TDD-004 section 3.3.3
 * and serve as regression tests for the scoring pipeline.
 */

import type { Rubric, RubricCategory } from '../../../src/review-gate/types';

// ---------------------------------------------------------------------------
// Helper: build a minimal Rubric with the given categories
// ---------------------------------------------------------------------------

function buildRubric(
  documentType: string,
  threshold: number,
  categories: Omit<RubricCategory, 'description' | 'calibration'>[]
): Rubric {
  return {
    document_type: documentType as Rubric['document_type'],
    version: '1.0.0',
    approval_threshold: threshold,
    total_weight: 100,
    categories: categories.map((c) => ({
      ...c,
      description: `Measures ${c.name}`,
      calibration: {
        score_0: `No ${c.name.toLowerCase()}`,
        score_50: `Partial ${c.name.toLowerCase()}`,
        score_100: `Comprehensive ${c.name.toLowerCase()}`,
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// PRD Rubric (fixture version matching TDD worked example)
// ---------------------------------------------------------------------------

const PRD_RUBRIC_FIXTURE = buildRubric('PRD', 85, [
  { id: 'problem_clarity', name: 'Problem Clarity', weight: 15, min_threshold: 60 },
  { id: 'goals_measurability', name: 'Goals Measurability', weight: 15, min_threshold: 60 },
  { id: 'user_story_coverage', name: 'User Story Coverage', weight: 15, min_threshold: 60 },
  { id: 'requirements_completeness', name: 'Requirements Completeness', weight: 20, min_threshold: 70 },
  { id: 'requirements_testability', name: 'Requirements Testability', weight: 15, min_threshold: 60 },
  { id: 'risk_identification', name: 'Risk Identification', weight: 10, min_threshold: 50 },
  { id: 'internal_consistency', name: 'Internal Consistency', weight: 10, min_threshold: 50 },
]);

// ---------------------------------------------------------------------------
// TDD Rubric (fixture version matching TDD worked example)
// ---------------------------------------------------------------------------

const TDD_RUBRIC_FIXTURE = buildRubric('TDD', 85, [
  { id: 'architecture_soundness', name: 'Architecture Soundness', weight: 20, min_threshold: 70 },
  { id: 'tradeoff_rigor', name: 'Tradeoff Rigor', weight: 15, min_threshold: 60 },
  { id: 'data_model_integrity', name: 'Data Model Integrity', weight: 15, min_threshold: 60 },
  { id: 'api_contract_completeness', name: 'API Contract Completeness', weight: 15, min_threshold: 60 },
  { id: 'integration_robustness', name: 'Integration Robustness', weight: 10, min_threshold: 50 },
  { id: 'security_depth', name: 'Security Depth', weight: 10, min_threshold: 50 },
  { id: 'prd_alignment', name: 'PRD Alignment', weight: 15, min_threshold: 70 },
]);

// ---------------------------------------------------------------------------
// Fixture 1: Single-reviewer PRD review
// ---------------------------------------------------------------------------

/**
 * Single-reviewer PRD review.
 *
 * Scores: [92, 78, 85, 70, 88, 65, 90]
 * Weights: [15, 15, 15, 20, 15, 10, 10]
 *
 * Calculation:
 *   0.15*92 + 0.15*78 + 0.15*85 + 0.20*70 + 0.15*88 + 0.10*65 + 0.10*90
 *   = 13.80 + 11.70 + 12.75 + 14.00 + 13.20 + 6.50 + 9.00
 *   = 80.95
 *
 * Expected outcome: changes_requested (80.95 < 85 threshold)
 */
export const SINGLE_REVIEWER_PRD = {
  rubric: PRD_RUBRIC_FIXTURE,
  scores: {
    problem_clarity: 92,
    goals_measurability: 78,
    user_story_coverage: 85,
    requirements_completeness: 70,
    requirements_testability: 88,
    risk_identification: 65,
    internal_consistency: 90,
  },
  expected_weighted_score: 80.95,
  expected_outcome: 'changes_requested' as const,
  threshold: 85,
};

// ---------------------------------------------------------------------------
// Fixture 2: Two-reviewer TDD review (mean)
// ---------------------------------------------------------------------------

/**
 * Two-reviewer TDD review aggregated with mean.
 *
 * Reviewer A scores: [90, 85, 88, 92, 80, 75, 95]
 * Reviewer A weighted:
 *   0.20*90 + 0.15*85 + 0.15*88 + 0.15*92 + 0.10*80 + 0.10*75 + 0.15*95
 *   = 18.00 + 12.75 + 13.20 + 13.80 + 8.00 + 7.50 + 14.25
 *   = 87.50
 *
 * Reviewer B scores: [82, 88, 85, 80, 78, 60, 90]
 * Reviewer B weighted:
 *   0.20*82 + 0.15*88 + 0.15*85 + 0.15*80 + 0.10*78 + 0.10*60 + 0.15*90
 *   = 16.40 + 13.20 + 12.75 + 12.00 + 7.80 + 6.00 + 13.50
 *   = 81.65
 *
 * Mean: (87.50 + 81.65) / 2 = 84.575 => rounded to 84.58
 *
 * Expected outcome: changes_requested (84.58 < 85 threshold)
 *
 * Disagreement: security_depth has scores [75, 60], variance = 15
 */
export const TWO_REVIEWER_TDD_MEAN = {
  rubric: TDD_RUBRIC_FIXTURE,
  reviewer_a_scores: {
    architecture_soundness: 90,
    tradeoff_rigor: 85,
    data_model_integrity: 88,
    api_contract_completeness: 92,
    integration_robustness: 80,
    security_depth: 75,
    prd_alignment: 95,
  },
  reviewer_a_weighted: 87.50,
  reviewer_b_scores: {
    architecture_soundness: 82,
    tradeoff_rigor: 88,
    data_model_integrity: 85,
    api_contract_completeness: 80,
    integration_robustness: 78,
    security_depth: 60,
    prd_alignment: 90,
  },
  reviewer_b_weighted: 81.65,
  expected_aggregate_mean: 84.58,
  expected_outcome: 'changes_requested' as const,
  threshold: 85,
  expected_disagreement: {
    category_id: 'security_depth',
    variance: 15,
    scores: [75, 60],
  },
};
