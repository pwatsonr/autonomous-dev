/**
 * CalibrationRunner: automated runner for calibration regression tests.
 *
 * Executes the review pipeline against reference documents from the calibration
 * document library and validates that scores, outcomes, and findings match
 * expectations within tolerance.
 *
 * Designed to run:
 * - After reviewer prompt changes (mandatory)
 * - After rubric updates (mandatory)
 * - Periodically (weekly recommended)
 * - On-demand via test command
 *
 * Based on SPEC-004-4-3 section 3.
 */

import type { CalibrationExpectation } from './expectations';
import type { ReviewerExecutor, ExecutionResult } from '../../../src/review-gate/reviewer-executor';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** Result of running calibration against a single reference document. */
export interface CalibrationRunResult {
  document_path: string;
  tier: string;
  actual_score: number;
  expected_range: { min: number; max: number };
  score_in_range: boolean;
  actual_outcome: string;
  outcome_expected: boolean;
  expected_findings_found: {
    category_id: string;
    expected: number;
    actual: number;
    pass: boolean;
  }[];
  consistency_check: {
    run_scores: number[];
    variance: number;
    within_tolerance: boolean;
  };
  overall_pass: boolean;
}

/** Adapter that the CalibrationRunner uses to execute a document through the review pipeline. */
export interface ReviewPipelineAdapter {
  /**
   * Execute a document through the full review pipeline.
   *
   * Returns the aggregate score, outcome, and findings by category.
   */
  executeReview(documentPath: string, documentType: string): Promise<{
    aggregate_score: number;
    outcome: 'approved' | 'changes_requested' | 'rejected';
    findings: { category_id: string; severity: string }[];
  }>;
}

// ---------------------------------------------------------------------------
// CalibrationRunner
// ---------------------------------------------------------------------------

export class CalibrationRunner {
  constructor(private pipeline: ReviewPipelineAdapter) {}

  /**
   * Run calibration against all provided expectations.
   *
   * For each expectation:
   * 1. Load the reference document from expectations.document_path
   * 2. Run the document through the full review pipeline `runs_per_document` times
   * 3. For each run: record score, outcome, and findings by category
   * 4. Check score_in_range: all run scores fall within expected_range
   * 5. Check outcome_expected: all run outcomes are in expected_outcome list
   * 6. Check expected_findings: for each expected finding category,
   *    at least min_count findings were generated in all runs
   * 7. Consistency check: compute variance across runs.
   *    within_tolerance = (max_score - min_score) <= score_tolerance
   * 8. overall_pass = score_in_range AND outcome_expected AND
   *    all expected_findings_found AND consistency_within_tolerance
   */
  async runCalibration(
    expectations: CalibrationExpectation[],
    runs_per_document: number = 3,
  ): Promise<CalibrationRunResult[]> {
    const results: CalibrationRunResult[] = [];

    for (const expectation of expectations) {
      const result = await this.runSingleExpectation(expectation, runs_per_document);
      results.push(result);
    }

    return results;
  }

  /**
   * Run calibration for a single expectation document.
   */
  private async runSingleExpectation(
    expectation: CalibrationExpectation,
    runs_per_document: number,
  ): Promise<CalibrationRunResult> {
    const runScores: number[] = [];
    const runOutcomes: string[] = [];
    const runFindingCounts: Map<string, number[]> = new Map();

    // Initialize finding count arrays for each expected finding category
    for (const ef of expectation.expected_findings) {
      runFindingCounts.set(ef.category_id, []);
    }

    // Execute the pipeline multiple times
    for (let i = 0; i < runs_per_document; i++) {
      const reviewResult = await this.pipeline.executeReview(
        expectation.document_path,
        expectation.document_type,
      );

      runScores.push(reviewResult.aggregate_score);
      runOutcomes.push(reviewResult.outcome);

      // Count findings per expected category
      for (const ef of expectation.expected_findings) {
        const count = reviewResult.findings.filter(
          f => f.category_id === ef.category_id,
        ).length;
        runFindingCounts.get(ef.category_id)!.push(count);
      }
    }

    // Compute average score for the primary result
    const avgScore = runScores.length > 0
      ? Math.round(runScores.reduce((a, b) => a + b, 0) / runScores.length * 100) / 100
      : 0;

    // Check score_in_range: ALL run scores fall within expected_range
    const scoreInRange = runScores.every(
      s => s >= expectation.expected_score_range.min && s <= expectation.expected_score_range.max,
    );

    // Check outcome_expected: ALL run outcomes are in expected_outcome list
    const outcomeExpected = runOutcomes.every(
      o => expectation.expected_outcome.includes(o as 'approved' | 'changes_requested' | 'rejected'),
    );

    // Check expected_findings: for each expected finding category,
    // at least min_count findings were generated in ALL runs
    const expectedFindingsFound = expectation.expected_findings.map(ef => {
      const counts = runFindingCounts.get(ef.category_id) ?? [];
      const minActual = counts.length > 0 ? Math.min(...counts) : 0;
      return {
        category_id: ef.category_id,
        expected: ef.min_count,
        actual: minActual,
        pass: minActual >= ef.min_count,
      };
    });

    // Consistency check: variance = max_score - min_score
    const maxScore = runScores.length > 0 ? Math.max(...runScores) : 0;
    const minScore = runScores.length > 0 ? Math.min(...runScores) : 0;
    const variance = maxScore - minScore;
    const withinTolerance = variance <= expectation.score_tolerance;

    // overall_pass = all checks pass
    const allFindingsPass = expectedFindingsFound.every(f => f.pass);
    const overallPass = scoreInRange && outcomeExpected && allFindingsPass && withinTolerance;

    return {
      document_path: expectation.document_path,
      tier: expectation.tier,
      actual_score: avgScore,
      expected_range: expectation.expected_score_range,
      score_in_range: scoreInRange,
      actual_outcome: runOutcomes[0] ?? '',
      outcome_expected: outcomeExpected,
      expected_findings_found: expectedFindingsFound,
      consistency_check: {
        run_scores: runScores,
        variance,
        within_tolerance: withinTolerance,
      },
      overall_pass: overallPass,
    };
  }
}
