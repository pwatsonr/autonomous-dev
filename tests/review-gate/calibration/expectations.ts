/**
 * Expected scores and findings for each reference document in the calibration
 * document library.
 *
 * Each expectation defines the document path, type, tier, expected score range,
 * expected gate outcome(s), and the specific findings that reviewers should
 * identify.
 *
 * Based on SPEC-004-4-3 section 2.
 */

import type { DocumentType, FindingSeverity } from '../../../src/review-gate/types';

// ---------------------------------------------------------------------------
// Type definitions (also exported for CalibrationRunner)
// ---------------------------------------------------------------------------

export interface CalibrationExpectation {
  document_path: string;
  document_type: DocumentType;
  tier: 'gold' | 'silver' | 'bronze' | 'failing';
  expected_score_range: { min: number; max: number };
  expected_outcome: ('approved' | 'changes_requested' | 'rejected')[];
  expected_findings: {
    category_id: string;
    min_count: number;
    severity?: FindingSeverity;
  }[];
  score_tolerance: number;  // +/- tolerance for consistency checks (default: 5)
}

// ---------------------------------------------------------------------------
// PRD Expectations
// ---------------------------------------------------------------------------

export const PRD_GOLD_EXPECTATION: CalibrationExpectation = {
  document_path: 'tests/review-gate/calibration/gold/prd-gold.md',
  document_type: 'PRD',
  tier: 'gold',
  expected_score_range: { min: 90, max: 100 },
  expected_outcome: ['approved'],
  expected_findings: [],
  score_tolerance: 5,
};

export const PRD_SILVER_EXPECTATION: CalibrationExpectation = {
  document_path: 'tests/review-gate/calibration/silver/prd-silver.md',
  document_type: 'PRD',
  tier: 'silver',
  expected_score_range: { min: 70, max: 85 },
  expected_outcome: ['changes_requested'],
  expected_findings: [
    { category_id: 'problem_clarity', min_count: 1, severity: 'major' },
    { category_id: 'requirements_testability', min_count: 1, severity: 'major' },
    { category_id: 'risk_identification', min_count: 1, severity: 'minor' },
  ],
  score_tolerance: 5,
};

export const PRD_BRONZE_EXPECTATION: CalibrationExpectation = {
  document_path: 'tests/review-gate/calibration/bronze/prd-bronze.md',
  document_type: 'PRD',
  tier: 'bronze',
  expected_score_range: { min: 50, max: 70 },
  expected_outcome: ['changes_requested'],
  expected_findings: [
    { category_id: 'problem_clarity', min_count: 1, severity: 'major' },
    { category_id: 'user_story_coverage', min_count: 1, severity: 'major' },
    { category_id: 'requirements_completeness', min_count: 1, severity: 'critical' },
    { category_id: 'goals_measurability', min_count: 1, severity: 'major' },
  ],
  score_tolerance: 5,
};

export const PRD_FAILING_EXPECTATION: CalibrationExpectation = {
  document_path: 'tests/review-gate/calibration/failing/prd-failing.md',
  document_type: 'PRD',
  tier: 'failing',
  expected_score_range: { min: 0, max: 49 },
  expected_outcome: ['changes_requested', 'rejected'],
  expected_findings: [
    { category_id: 'problem_clarity', min_count: 1, severity: 'critical' },
    { category_id: 'goals_measurability', min_count: 1, severity: 'critical' },
    { category_id: 'internal_consistency', min_count: 1, severity: 'critical' },
  ],
  score_tolerance: 5,
};

// ---------------------------------------------------------------------------
// TDD Expectations
// ---------------------------------------------------------------------------

export const TDD_GOLD_EXPECTATION: CalibrationExpectation = {
  document_path: 'tests/review-gate/calibration/gold/tdd-gold.md',
  document_type: 'TDD',
  tier: 'gold',
  expected_score_range: { min: 90, max: 100 },
  expected_outcome: ['approved'],
  expected_findings: [],
  score_tolerance: 5,
};

export const TDD_SILVER_EXPECTATION: CalibrationExpectation = {
  document_path: 'tests/review-gate/calibration/silver/tdd-silver.md',
  document_type: 'TDD',
  tier: 'silver',
  expected_score_range: { min: 70, max: 85 },
  expected_outcome: ['changes_requested'],
  expected_findings: [
    { category_id: 'tradeoff_rigor', min_count: 1, severity: 'major' },
    { category_id: 'error_handling', min_count: 1, severity: 'minor' },
  ],
  score_tolerance: 5,
};

export const TDD_BRONZE_EXPECTATION: CalibrationExpectation = {
  document_path: 'tests/review-gate/calibration/bronze/tdd-bronze.md',
  document_type: 'TDD',
  tier: 'bronze',
  expected_score_range: { min: 50, max: 70 },
  expected_outcome: ['changes_requested'],
  expected_findings: [
    { category_id: 'architecture_soundness', min_count: 1, severity: 'critical' },
    { category_id: 'tradeoff_rigor', min_count: 1, severity: 'major' },
    { category_id: 'data_model_integrity', min_count: 1, severity: 'major' },
    { category_id: 'security_depth', min_count: 1, severity: 'major' },
  ],
  score_tolerance: 5,
};

export const TDD_FAILING_EXPECTATION: CalibrationExpectation = {
  document_path: 'tests/review-gate/calibration/failing/tdd-failing.md',
  document_type: 'TDD',
  tier: 'failing',
  expected_score_range: { min: 0, max: 49 },
  expected_outcome: ['changes_requested', 'rejected'],
  expected_findings: [
    { category_id: 'architecture_soundness', min_count: 1, severity: 'critical' },
    { category_id: 'tradeoff_rigor', min_count: 1, severity: 'critical' },
    { category_id: 'internal_consistency', min_count: 1, severity: 'critical' },
  ],
  score_tolerance: 5,
};

// ---------------------------------------------------------------------------
// All expectations
// ---------------------------------------------------------------------------

export const ALL_EXPECTATIONS: CalibrationExpectation[] = [
  PRD_GOLD_EXPECTATION,
  PRD_SILVER_EXPECTATION,
  PRD_BRONZE_EXPECTATION,
  PRD_FAILING_EXPECTATION,
  TDD_GOLD_EXPECTATION,
  TDD_SILVER_EXPECTATION,
  TDD_BRONZE_EXPECTATION,
  TDD_FAILING_EXPECTATION,
];
