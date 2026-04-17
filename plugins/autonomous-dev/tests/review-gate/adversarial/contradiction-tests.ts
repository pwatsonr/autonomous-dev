/**
 * Adversarial contradiction tests.
 *
 * Tests that the review system detects subtle internal contradictions
 * within documents: conflicting data store requirements, conflicting
 * performance targets, and scope contradictions.
 *
 * Based on SPEC-004-4-4 section 3.
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
    section_id: overrides.section_id ?? 'nfr',
    category_id: overrides.category_id ?? 'internal_consistency',
    severity: overrides.severity ?? 'major',
    critical_sub: overrides.critical_sub ?? null,
    upstream_defect: overrides.upstream_defect ?? false,
    description: overrides.description ?? 'Internal contradiction detected',
    evidence: overrides.evidence ?? 'Conflicting statements in document',
    suggested_resolution: overrides.suggested_resolution ?? 'Resolve the contradiction',
    ...overrides,
  };
}

function makeContradictionTestCases(): AdversarialTestCase[] {
  return ADVERSARIAL_TESTS.filter((t) => t.category === 'contradiction');
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

describe('Adversarial Contradiction Tests', () => {
  const contradictionTests = makeContradictionTestCases();

  // -----------------------------------------------------------------------
  // C1: Conflicting data store requirements
  // -----------------------------------------------------------------------
  describe('C1: Data store contradiction', () => {
    const testCase = contradictionTests.find((t) => t.id === 'C1')!;

    test('reviewer detects PostgreSQL vs portability contradiction', async () => {
      const findings = [
        makeFinding({
          category_id: 'internal_consistency',
          description: 'Data model uses PostgreSQL-specific JSONB columns but NFR-003 requires database portability',
          severity: 'critical',
        }),
      ];
      const executor = makeMockExecutor(60, 'changes_requested', findings);
      const runner = new AdversarialRunner();

      const results = await runner.runAdversarialTests(executor, [testCase]);

      expect(results).toHaveLength(1);
      expect(results[0].expected_behavior_met).toBe(true);
      expect(results[0].failures).toEqual([]);
    });

    test('missing contradiction finding fails validation', () => {
      // No internal_consistency finding and no "contradict" in descriptions
      const result = validateResult(testCase, 80, 'approved', []);
      expect(result.pass).toBe(false);
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining('contradiction'),
        ]),
      );
    });

    test('finding with "contradict" in description also passes', () => {
      const findings = [
        makeFinding({
          category_id: 'data_model_integrity',
          description: 'Data model contradicts the portability requirement in NFR-003',
        }),
      ];
      const result = validateResult(testCase, 65, 'changes_requested', findings);
      // contradiction_detected check passes because description contains "contradict"
      // But required_finding_categories includes "internal_consistency" which is not present
      expect(result.pass).toBe(false);
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining("'internal_consistency'"),
        ]),
      );
    });

    test('internal_consistency finding alone satisfies contradiction and category check', () => {
      const findings = [
        makeFinding({
          category_id: 'internal_consistency',
          description: 'PostgreSQL JSONB usage conflicts with database-agnostic requirement',
        }),
      ];
      const result = validateResult(testCase, 65, 'changes_requested', findings);
      expect(result.pass).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // C2: Conflicting performance targets
  // -----------------------------------------------------------------------
  describe('C2: Performance target contradiction', () => {
    const testCase = contradictionTests.find((t) => t.id === 'C2')!;

    test('reviewer detects sub-100ms goal vs 200ms average NFR', async () => {
      const findings = [
        makeFinding({
          category_id: 'internal_consistency',
          description:
            'Goal G-1 states sub-100ms for all endpoints, but NFR-001 allows 200ms average',
          severity: 'major',
        }),
      ];
      const executor = makeMockExecutor(70, 'changes_requested', findings);
      const runner = new AdversarialRunner();

      const results = await runner.runAdversarialTests(executor, [testCase]);

      expect(results).toHaveLength(1);
      expect(results[0].expected_behavior_met).toBe(true);
    });

    test('missing internal_consistency finding fails validation', () => {
      const findings = [
        makeFinding({
          category_id: 'requirements_completeness',
          description: 'Performance requirements need more detail',
        }),
      ];
      const result = validateResult(testCase, 70, 'changes_requested', findings);
      expect(result.pass).toBe(false);
      expect(result.failures.some((f) => f.includes('contradiction'))).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // C3: Scope contradiction
  // -----------------------------------------------------------------------
  describe('C3: Scope contradiction', () => {
    const testCase = contradictionTests.find((t) => t.id === 'C3')!;

    test('reviewer detects out-of-scope user stories (Germany, Japan)', async () => {
      const findings = [
        makeFinding({
          category_id: 'internal_consistency',
          description:
            'Scope limits to North America only, but US-7 references Germany and US-8 references Japan',
          severity: 'major',
        }),
        makeFinding({
          id: 'f-2',
          category_id: 'user_story_coverage',
          description: 'User stories US-7 and US-8 are outside declared scope',
          severity: 'major',
        }),
      ];
      const executor = makeMockExecutor(62, 'changes_requested', findings);
      const runner = new AdversarialRunner();

      const results = await runner.runAdversarialTests(executor, [testCase]);

      expect(results).toHaveLength(1);
      expect(results[0].expected_behavior_met).toBe(true);
    });

    test('missing user_story_coverage category fails validation', () => {
      const findings = [
        makeFinding({
          category_id: 'internal_consistency',
          description: 'Scope contradiction found',
        }),
      ];
      const result = validateResult(testCase, 65, 'changes_requested', findings);
      expect(result.pass).toBe(false);
      expect(result.failures).toEqual(
        expect.arrayContaining([
          expect.stringContaining("'user_story_coverage'"),
        ]),
      );
    });

    test('both required categories present passes validation', () => {
      const findings = [
        makeFinding({
          category_id: 'internal_consistency',
          description: 'Scope contradiction between scope section and user stories',
        }),
        makeFinding({
          id: 'f-2',
          category_id: 'user_story_coverage',
          description: 'US-7 and US-8 contradict scope limitation to North America',
        }),
      ];
      const result = validateResult(testCase, 60, 'changes_requested', findings);
      expect(result.pass).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Runner executes all contradiction tests
  // -----------------------------------------------------------------------
  test('AdversarialRunner produces results for all 3 contradiction tests', async () => {
    const findings = [
      makeFinding({
        category_id: 'internal_consistency',
        description: 'Contradiction detected',
      }),
      makeFinding({
        id: 'f-2',
        category_id: 'user_story_coverage',
        description: 'User story out of scope',
      }),
    ];
    const executor = makeMockExecutor(60, 'changes_requested', findings);
    const runner = new AdversarialRunner();

    const results = await runner.runAdversarialTests(executor, contradictionTests);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.category).toBe('contradiction');
      expect(result.test_id).toMatch(/^C\d$/);
    }
  });
});
