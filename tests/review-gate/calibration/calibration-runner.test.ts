/**
 * Unit tests for CalibrationRunner (SPEC-004-4-3, Task 9).
 *
 * Covers all 10 test cases from the spec (numbered 15-24):
 * 15. Gold doc in range
 * 16. Gold doc below range
 * 17. Failing doc above range
 * 18. Expected findings found
 * 19. Expected findings missing
 * 20. Consistency within tolerance
 * 21. Consistency outside tolerance
 * 22. Outcome matches expectation
 * 23. Overall pass -- all checks pass
 * 24. Overall fail -- one check fails
 */

import { CalibrationRunner } from './calibration-runner';
import type { ReviewPipelineAdapter, CalibrationRunResult } from './calibration-runner';
import type { CalibrationExpectation } from './expectations';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CalibrationExpectation for testing. */
function makeExpectation(overrides: Partial<CalibrationExpectation> = {}): CalibrationExpectation {
  return {
    document_path: overrides.document_path ?? 'tests/review-gate/calibration/gold/prd-gold.md',
    document_type: overrides.document_type ?? 'PRD',
    tier: overrides.tier ?? 'gold',
    expected_score_range: overrides.expected_score_range ?? { min: 90, max: 100 },
    expected_outcome: overrides.expected_outcome ?? ['approved'],
    expected_findings: overrides.expected_findings ?? [],
    score_tolerance: overrides.score_tolerance ?? 5,
  };
}

/** Create a mock pipeline adapter that returns predetermined results. */
function makeMockPipeline(
  results: {
    aggregate_score: number;
    outcome: 'approved' | 'changes_requested' | 'rejected';
    findings: { category_id: string; severity: string }[];
  }[],
): ReviewPipelineAdapter {
  let callIndex = 0;
  return {
    async executeReview() {
      const result = results[callIndex % results.length];
      callIndex++;
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CalibrationRunner', () => {
  // -----------------------------------------------------------------------
  // Test 15: Gold doc in range
  // -----------------------------------------------------------------------
  test('15. Gold doc in range: score 95, expected 90-100, score_in_range true', async () => {
    const pipeline = makeMockPipeline([
      { aggregate_score: 95, outcome: 'approved', findings: [] },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      expected_score_range: { min: 90, max: 100 },
      expected_outcome: ['approved'],
    });

    const [result] = await runner.runCalibration([expectation], 1);

    expect(result.score_in_range).toBe(true);
    expect(result.actual_score).toBe(95);
  });

  // -----------------------------------------------------------------------
  // Test 16: Gold doc below range
  // -----------------------------------------------------------------------
  test('16. Gold doc below range: score 80, expected 90-100, score_in_range false', async () => {
    const pipeline = makeMockPipeline([
      { aggregate_score: 80, outcome: 'approved', findings: [] },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      expected_score_range: { min: 90, max: 100 },
    });

    const [result] = await runner.runCalibration([expectation], 1);

    expect(result.score_in_range).toBe(false);
    expect(result.overall_pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 17: Failing doc above range
  // -----------------------------------------------------------------------
  test('17. Failing doc above range: score 60, expected 0-49, score_in_range false', async () => {
    const pipeline = makeMockPipeline([
      { aggregate_score: 60, outcome: 'changes_requested', findings: [] },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      tier: 'failing',
      expected_score_range: { min: 0, max: 49 },
      expected_outcome: ['changes_requested', 'rejected'],
    });

    const [result] = await runner.runCalibration([expectation], 1);

    expect(result.score_in_range).toBe(false);
    expect(result.overall_pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 18: Expected findings found
  // -----------------------------------------------------------------------
  test('18. Expected findings found: bronze PRD flags requirements_completeness', async () => {
    const pipeline = makeMockPipeline([
      {
        aggregate_score: 60,
        outcome: 'changes_requested',
        findings: [
          { category_id: 'requirements_completeness', severity: 'critical' },
          { category_id: 'requirements_completeness', severity: 'major' },
        ],
      },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      tier: 'bronze',
      expected_score_range: { min: 50, max: 70 },
      expected_outcome: ['changes_requested'],
      expected_findings: [
        { category_id: 'requirements_completeness', min_count: 2 },
      ],
    });

    const [result] = await runner.runCalibration([expectation], 1);

    expect(result.expected_findings_found).toHaveLength(1);
    expect(result.expected_findings_found[0].pass).toBe(true);
    expect(result.expected_findings_found[0].actual).toBe(2);
    expect(result.expected_findings_found[0].expected).toBe(2);
  });

  // -----------------------------------------------------------------------
  // Test 19: Expected findings missing
  // -----------------------------------------------------------------------
  test('19. Expected findings missing: silver TDD expected tradeoff_rigor, none found', async () => {
    const pipeline = makeMockPipeline([
      {
        aggregate_score: 78,
        outcome: 'changes_requested',
        findings: [
          { category_id: 'error_handling', severity: 'minor' },
        ],
      },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      tier: 'silver',
      document_type: 'TDD',
      expected_score_range: { min: 70, max: 85 },
      expected_outcome: ['changes_requested'],
      expected_findings: [
        { category_id: 'tradeoff_rigor', min_count: 1 },
      ],
    });

    const [result] = await runner.runCalibration([expectation], 1);

    expect(result.expected_findings_found).toHaveLength(1);
    expect(result.expected_findings_found[0].pass).toBe(false);
    expect(result.expected_findings_found[0].actual).toBe(0);
    expect(result.overall_pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 20: Consistency within tolerance
  // -----------------------------------------------------------------------
  test('20. Consistency within tolerance: scores [82, 85, 84], variance 3 <= 5', async () => {
    const pipeline = makeMockPipeline([
      { aggregate_score: 82, outcome: 'changes_requested', findings: [] },
      { aggregate_score: 85, outcome: 'changes_requested', findings: [] },
      { aggregate_score: 84, outcome: 'changes_requested', findings: [] },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      tier: 'silver',
      expected_score_range: { min: 70, max: 85 },
      expected_outcome: ['changes_requested'],
      score_tolerance: 5,
    });

    const [result] = await runner.runCalibration([expectation], 3);

    expect(result.consistency_check.run_scores).toEqual([82, 85, 84]);
    expect(result.consistency_check.variance).toBe(3);
    expect(result.consistency_check.within_tolerance).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 21: Consistency outside tolerance
  // -----------------------------------------------------------------------
  test('21. Consistency outside tolerance: scores [75, 85, 90], variance 15 > 5', async () => {
    const pipeline = makeMockPipeline([
      { aggregate_score: 75, outcome: 'changes_requested', findings: [] },
      { aggregate_score: 85, outcome: 'changes_requested', findings: [] },
      { aggregate_score: 90, outcome: 'approved', findings: [] },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      tier: 'silver',
      expected_score_range: { min: 70, max: 90 },
      expected_outcome: ['changes_requested', 'approved'],
      score_tolerance: 5,
    });

    const [result] = await runner.runCalibration([expectation], 3);

    expect(result.consistency_check.run_scores).toEqual([75, 85, 90]);
    expect(result.consistency_check.variance).toBe(15);
    expect(result.consistency_check.within_tolerance).toBe(false);
    expect(result.overall_pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 22: Outcome matches expectation
  // -----------------------------------------------------------------------
  test('22. Outcome matches expectation: gold PRD returns approved', async () => {
    const pipeline = makeMockPipeline([
      { aggregate_score: 95, outcome: 'approved', findings: [] },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      expected_outcome: ['approved'],
    });

    const [result] = await runner.runCalibration([expectation], 1);

    expect(result.outcome_expected).toBe(true);
    expect(result.actual_outcome).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Test 23: Overall pass -- all checks pass
  // -----------------------------------------------------------------------
  test('23. Overall pass: score in range, outcome expected, findings found, consistency ok', async () => {
    const pipeline = makeMockPipeline([
      {
        aggregate_score: 62,
        outcome: 'changes_requested',
        findings: [
          { category_id: 'requirements_completeness', severity: 'critical' },
          { category_id: 'problem_clarity', severity: 'major' },
        ],
      },
      {
        aggregate_score: 64,
        outcome: 'changes_requested',
        findings: [
          { category_id: 'requirements_completeness', severity: 'critical' },
          { category_id: 'problem_clarity', severity: 'major' },
        ],
      },
      {
        aggregate_score: 63,
        outcome: 'changes_requested',
        findings: [
          { category_id: 'requirements_completeness', severity: 'critical' },
          { category_id: 'problem_clarity', severity: 'major' },
        ],
      },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      tier: 'bronze',
      expected_score_range: { min: 50, max: 70 },
      expected_outcome: ['changes_requested'],
      expected_findings: [
        { category_id: 'requirements_completeness', min_count: 1 },
        { category_id: 'problem_clarity', min_count: 1 },
      ],
      score_tolerance: 5,
    });

    const [result] = await runner.runCalibration([expectation], 3);

    expect(result.score_in_range).toBe(true);
    expect(result.outcome_expected).toBe(true);
    expect(result.expected_findings_found.every(f => f.pass)).toBe(true);
    expect(result.consistency_check.within_tolerance).toBe(true);
    expect(result.overall_pass).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 24: Overall fail -- one check fails
  // -----------------------------------------------------------------------
  test('24. Overall fail: score in range but expected findings missing', async () => {
    const pipeline = makeMockPipeline([
      {
        aggregate_score: 62,
        outcome: 'changes_requested',
        findings: [
          { category_id: 'problem_clarity', severity: 'major' },
          // Missing requirements_completeness finding
        ],
      },
    ]);
    const runner = new CalibrationRunner(pipeline);
    const expectation = makeExpectation({
      tier: 'bronze',
      expected_score_range: { min: 50, max: 70 },
      expected_outcome: ['changes_requested'],
      expected_findings: [
        { category_id: 'requirements_completeness', min_count: 1 },
        { category_id: 'problem_clarity', min_count: 1 },
      ],
    });

    const [result] = await runner.runCalibration([expectation], 1);

    expect(result.score_in_range).toBe(true);
    expect(result.outcome_expected).toBe(true);
    // requirements_completeness not found
    const reqFinding = result.expected_findings_found.find(
      f => f.category_id === 'requirements_completeness',
    );
    expect(reqFinding!.pass).toBe(false);
    // problem_clarity found
    const probFinding = result.expected_findings_found.find(
      f => f.category_id === 'problem_clarity',
    );
    expect(probFinding!.pass).toBe(true);
    // Overall fail because one finding check failed
    expect(result.overall_pass).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Additional: Multiple expectations in single run
  // -----------------------------------------------------------------------
  test('runs multiple expectations and returns results for each', async () => {
    const pipeline = makeMockPipeline([
      { aggregate_score: 95, outcome: 'approved', findings: [] },
      { aggregate_score: 30, outcome: 'rejected', findings: [] },
    ]);
    const runner = new CalibrationRunner(pipeline);

    const goldExpectation = makeExpectation({
      tier: 'gold',
      expected_score_range: { min: 90, max: 100 },
      expected_outcome: ['approved'],
    });
    const failingExpectation = makeExpectation({
      document_path: 'tests/review-gate/calibration/failing/prd-failing.md',
      tier: 'failing',
      expected_score_range: { min: 0, max: 49 },
      expected_outcome: ['changes_requested', 'rejected'],
    });

    const results = await runner.runCalibration([goldExpectation, failingExpectation], 1);

    expect(results).toHaveLength(2);
    expect(results[0].tier).toBe('gold');
    expect(results[0].overall_pass).toBe(true);
    expect(results[1].tier).toBe('failing');
    expect(results[1].overall_pass).toBe(true);
  });
});
