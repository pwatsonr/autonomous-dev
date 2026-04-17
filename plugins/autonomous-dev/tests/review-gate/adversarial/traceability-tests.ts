/**
 * Adversarial traceability tests.
 *
 * Tests that the review system detects missing traceability links:
 * absent traces_from fields, references to nonexistent parent documents,
 * and silently dropped requirements.
 *
 * Based on SPEC-004-4-4 section 4.
 */

import type { Finding } from '../../../src/review-gate/types';
import {
  AdversarialRunner,
  ADVERSARIAL_TESTS,
  validateResult,
} from './adversarial-runner';
import type {
  AdversarialTestCase,
  ReviewerExecutorAdapter,
} from './adversarial-runner';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: overrides.id ?? 'f-1',
    section_id: overrides.section_id ?? 'traceability',
    category_id: overrides.category_id ?? 'prd_alignment',
    severity: overrides.severity ?? 'major',
    critical_sub: overrides.critical_sub ?? null,
    upstream_defect: overrides.upstream_defect ?? false,
    description: overrides.description ?? 'Traceability gap detected',
    evidence: overrides.evidence ?? 'Missing traceability link to parent',
    suggested_resolution: overrides.suggested_resolution ?? 'Add traces_from reference',
    ...overrides,
  };
}

function makeTraceabilityTestCases(): AdversarialTestCase[] {
  return ADVERSARIAL_TESTS.filter((t) => t.category === 'traceability');
}

function makeMockExecutor(
  score: number,
  outcome: string,
  findings: Finding[],
): ReviewerExecutorAdapter {
  return {
    async executeReview() {
      return { score, outcome, findings };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Adversarial Traceability Tests', () => {
  const traceabilityTests = makeTraceabilityTestCases();

  // -----------------------------------------------------------------------
  // T1: Missing traces_from entirely
  // -----------------------------------------------------------------------
  describe('T1: Missing traces_from', () => {
    const testCase = traceabilityTests.find((t) => t.id === 'T1')!;

    test('PreReviewValidator or reviewer flags missing traces_from', async () => {
      const findings = [
        makeFinding({
          category_id: 'prd_alignment',
          description: 'TDD has no traces_from field; cannot verify parent alignment',
          severity: 'critical',
        }),
      ];
      const executor = makeMockExecutor(40, 'changes_requested', findings);
      const runner = new AdversarialRunner();

      const results = await runner.runAdversarialTests(executor, [testCase]);

      expect(results).toHaveLength(1);
      expect(results[0].expected_behavior_met).toBe(true);
      expect(results[0].failures).toEqual([]);
    });

    test('traceability gap flagged via description containing "trace"', () => {
      const findings = [
        makeFinding({
          category_id: 'prd_alignment',
          description: 'No traceability information present in document',
        }),
      ];
      const result = validateResult(testCase, 40, 'changes_requested', findings);
      expect(result.pass).toBe(true);
    });

    test('no traceability finding fails validation', () => {
      const result = validateResult(testCase, 40, 'changes_requested', []);
      expect(result.pass).toBe(false);
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining('traceability gap'),
        ]),
      );
    });

    test('finding with alignment category satisfies traceability check', () => {
      const findings = [
        makeFinding({
          category_id: 'prd_alignment',
          description: 'Document lacks parent reference',
        }),
      ];
      const result = validateResult(testCase, 40, 'changes_requested', findings);
      // prd_alignment contains "alignment" which satisfies traceability_gap_flagged
      expect(result.pass).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // T2: Nonexistent parent reference
  // -----------------------------------------------------------------------
  describe('T2: Nonexistent parent', () => {
    const testCase = traceabilityTests.find((t) => t.id === 'T2')!;

    test('PreReviewValidator flags unresolvable traces_from to PRD-999', async () => {
      const findings = [
        makeFinding({
          category_id: 'prd_alignment',
          description: 'traces_from references PRD-999 which does not exist',
          severity: 'critical',
        }),
      ];
      const executor = makeMockExecutor(35, 'rejected', findings);
      const runner = new AdversarialRunner();

      const results = await runner.runAdversarialTests(executor, [testCase]);

      expect(results).toHaveLength(1);
      expect(results[0].expected_behavior_met).toBe(true);
    });

    test('no traceability finding fails validation', () => {
      const result = validateResult(testCase, 35, 'rejected', []);
      expect(result.pass).toBe(false);
      expect(result.failures.some((f) => f.includes('traceability'))).toBe(true);
    });

    test('finding with "trace" in description satisfies check', () => {
      const findings = [
        makeFinding({
          category_id: 'validation',
          description: 'Unresolvable trace reference to nonexistent parent document',
        }),
      ];
      const result = validateResult(testCase, 35, 'rejected', findings);
      // "trace" in description satisfies traceability_gap_flagged
      expect(result.pass).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // T3: Dropped requirements
  // -----------------------------------------------------------------------
  describe('T3: Silently dropped requirements', () => {
    const testCase = traceabilityTests.find((t) => t.id === 'T3')!;

    test('reviewer flags 3 dropped requirements in prd_alignment', async () => {
      const findings = [
        makeFinding({
          category_id: 'prd_alignment',
          description:
            'TDD omits FR-004, FR-006, FR-008 from parent PRD-042 without justification',
          severity: 'critical',
        }),
        makeFinding({
          id: 'f-2',
          category_id: 'prd_alignment',
          description: 'Missing traceability for 3 of 10 parent requirements',
          severity: 'major',
        }),
      ];
      const executor = makeMockExecutor(55, 'changes_requested', findings);
      const runner = new AdversarialRunner();

      const results = await runner.runAdversarialTests(executor, [testCase]);

      expect(results).toHaveLength(1);
      expect(results[0].expected_behavior_met).toBe(true);
      expect(results[0].failures).toEqual([]);
    });

    test('missing prd_alignment finding fails validation', () => {
      const findings = [
        makeFinding({
          category_id: 'requirements_completeness',
          description: 'Some requirements appear to be missing',
          severity: 'major',
        }),
      ];
      const result = validateResult(testCase, 55, 'changes_requested', findings);
      expect(result.pass).toBe(false);
      // Should fail on both traceability_gap_flagged and required_finding_categories
      expect(result.failures.length).toBeGreaterThanOrEqual(1);
    });

    test('missing required severity fails validation', () => {
      const findings = [
        makeFinding({
          category_id: 'prd_alignment',
          description: 'Traceability gaps in parent requirement coverage',
          severity: 'minor', // Needs major or critical
        }),
      ];
      const result = validateResult(testCase, 55, 'changes_requested', findings);
      expect(result.pass).toBe(false);
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining("severity 'major'"),
        ]),
      );
    });

    test('both major and critical severities present passes', () => {
      const findings = [
        makeFinding({
          category_id: 'prd_alignment',
          description: 'Critical traceability gap: 3 requirements omitted',
          severity: 'critical',
        }),
        makeFinding({
          id: 'f-2',
          category_id: 'prd_alignment',
          description: 'Major alignment issue with parent PRD',
          severity: 'major',
        }),
      ];
      const result = validateResult(testCase, 55, 'changes_requested', findings);
      expect(result.pass).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Runner executes all traceability tests
  // -----------------------------------------------------------------------
  test('AdversarialRunner produces results for all 3 traceability tests', async () => {
    const findings = [
      makeFinding({
        category_id: 'prd_alignment',
        description: 'Traceability gap found',
        severity: 'critical',
      }),
      makeFinding({
        id: 'f-2',
        category_id: 'prd_alignment',
        description: 'Missing parent alignment',
        severity: 'major',
      }),
    ];
    const executor = makeMockExecutor(45, 'changes_requested', findings);
    const runner = new AdversarialRunner();

    const results = await runner.runAdversarialTests(executor, traceabilityTests);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.category).toBe('traceability');
      expect(result.test_id).toMatch(/^T\d$/);
    }
  });

  // -----------------------------------------------------------------------
  // Full adversarial suite
  // -----------------------------------------------------------------------
  test('Full ADVERSARIAL_TESTS registry has 9 test cases: 3 manipulation, 3 contradiction, 3 traceability', () => {
    expect(ADVERSARIAL_TESTS).toHaveLength(9);

    const manipulation = ADVERSARIAL_TESTS.filter((t) => t.category === 'manipulation');
    const contradiction = ADVERSARIAL_TESTS.filter((t) => t.category === 'contradiction');
    const traceability = ADVERSARIAL_TESTS.filter((t) => t.category === 'traceability');

    expect(manipulation).toHaveLength(3);
    expect(contradiction).toHaveLength(3);
    expect(traceability).toHaveLength(3);
  });
});
