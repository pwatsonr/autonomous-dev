/**
 * AdversarialRunner: executes adversarial test cases against a reviewer
 * executor and validates that the review system is resilient to gaming.
 *
 * Each test case defines:
 * - A document designed to exploit reviewer weaknesses
 * - Expected behavior (what the reviewer should catch)
 * - Automated pass/fail validation
 *
 * Based on SPEC-004-4-4 sections 1, 5, and 6.
 */

import type { DocumentType, Finding, FindingSeverity } from '../../../src/review-gate/types';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** An adversarial test case definition. */
export interface AdversarialTestCase {
  id: string;
  category: 'manipulation' | 'contradiction' | 'traceability';
  document_path: string;
  document_type: DocumentType;
  description: string;
  expected_behavior: {
    score_not_inflated: boolean;
    contradiction_detected: boolean;
    traceability_gap_flagged: boolean;
    max_acceptable_score?: number;
    required_finding_categories?: string[];
    required_finding_severities?: FindingSeverity[];
  };
}

/** Result of running a single adversarial test case. */
export interface AdversarialTestResult {
  test_id: string;
  category: string;
  actual_score: number;
  actual_outcome: string;
  actual_findings: Finding[];
  expected_behavior_met: boolean;
  failures: string[];
}

/**
 * Interface for the reviewer execution layer used by the adversarial runner.
 *
 * This abstraction allows the runner to accept any reviewer implementation --
 * real or mocked -- making the tests usable in both unit and integration contexts.
 */
export interface ReviewerExecutorAdapter {
  executeReview(
    documentContent: string,
    documentType: DocumentType,
  ): Promise<{
    score: number;
    outcome: string;
    findings: Finding[];
  }>;
}

// ---------------------------------------------------------------------------
// Validation logic
// ---------------------------------------------------------------------------

/**
 * Validate a single adversarial test result against its expected behavior.
 *
 * Returns { pass: true, failures: [] } if all expectations are met.
 */
export function validateResult(
  testCase: AdversarialTestCase,
  score: number,
  outcome: string,
  findings: Finding[],
): { pass: boolean; failures: string[] } {
  const failures: string[] = [];

  // Check score inflation for manipulation tests
  if (
    testCase.expected_behavior.score_not_inflated &&
    testCase.expected_behavior.max_acceptable_score !== undefined &&
    score > testCase.expected_behavior.max_acceptable_score
  ) {
    failures.push(
      `Score ${score} exceeds max acceptable ${testCase.expected_behavior.max_acceptable_score}. ` +
      `Possible manipulation inflation.`,
    );
  }

  // Check contradiction detection
  if (testCase.expected_behavior.contradiction_detected) {
    const contradictionFinding = findings.find(
      (f) =>
        f.category_id === 'internal_consistency' ||
        f.description.toLowerCase().includes('contradict'),
    );
    if (!contradictionFinding) {
      failures.push(
        'Expected contradiction to be detected, but no contradiction finding found.',
      );
    }
  }

  // Check traceability gap flagging
  if (testCase.expected_behavior.traceability_gap_flagged) {
    const traceabilityFinding = findings.find(
      (f) =>
        f.category_id.includes('alignment') ||
        f.description.toLowerCase().includes('trace') ||
        f.description.toLowerCase().includes('traceability'),
    );
    if (!traceabilityFinding) {
      failures.push(
        'Expected traceability gap to be flagged, but no traceability finding found.',
      );
    }
  }

  // Check required finding categories
  if (testCase.expected_behavior.required_finding_categories) {
    for (const cat of testCase.expected_behavior.required_finding_categories) {
      if (!findings.some((f) => f.category_id === cat)) {
        failures.push(`Expected finding in category '${cat}', but none found.`);
      }
    }
  }

  // Check required finding severities
  if (testCase.expected_behavior.required_finding_severities) {
    for (const sev of testCase.expected_behavior.required_finding_severities) {
      if (!findings.some((f) => f.severity === sev)) {
        failures.push(`Expected finding with severity '${sev}', but none found.`);
      }
    }
  }

  return { pass: failures.length === 0, failures };
}

// ---------------------------------------------------------------------------
// Adversarial test registry
// ---------------------------------------------------------------------------

/** All adversarial test cases. */
export const ADVERSARIAL_TESTS: AdversarialTestCase[] = [
  // Manipulation tests
  {
    id: 'M1',
    category: 'manipulation',
    document_path: 'fixtures/manipulation-direct-instruction.md',
    document_type: 'PRD',
    description: 'Document with embedded instruction to score 100',
    expected_behavior: {
      score_not_inflated: true,
      contradiction_detected: false,
      traceability_gap_flagged: false,
      max_acceptable_score: 75,
      required_finding_categories: ['goals_measurability'],
    },
  },
  {
    id: 'M2',
    category: 'manipulation',
    document_path: 'fixtures/manipulation-authority-appeal.md',
    document_type: 'PRD',
    description: 'Document claiming pre-approval by executives',
    expected_behavior: {
      score_not_inflated: true,
      contradiction_detected: false,
      traceability_gap_flagged: false,
      max_acceptable_score: 70,
    },
  },
  {
    id: 'M3',
    category: 'manipulation',
    document_path: 'fixtures/manipulation-vacuous-buzzwords.md',
    document_type: 'PRD',
    description: 'Technical-sounding but vacuous requirements',
    expected_behavior: {
      score_not_inflated: true,
      contradiction_detected: false,
      traceability_gap_flagged: false,
      max_acceptable_score: 60,
      required_finding_categories: ['requirements_testability', 'requirements_completeness'],
      required_finding_severities: ['major'],
    },
  },
  // Contradiction tests
  {
    id: 'C1',
    category: 'contradiction',
    document_path: 'fixtures/contradiction-data-store.md',
    document_type: 'TDD',
    description: 'PostgreSQL-specific features vs database portability requirement',
    expected_behavior: {
      score_not_inflated: false,
      contradiction_detected: true,
      traceability_gap_flagged: false,
      required_finding_categories: ['internal_consistency'],
    },
  },
  {
    id: 'C2',
    category: 'contradiction',
    document_path: 'fixtures/contradiction-performance.md',
    document_type: 'PRD',
    description: 'Conflicting performance targets between goals and NFRs',
    expected_behavior: {
      score_not_inflated: false,
      contradiction_detected: true,
      traceability_gap_flagged: false,
      required_finding_categories: ['internal_consistency'],
    },
  },
  {
    id: 'C3',
    category: 'contradiction',
    document_path: 'fixtures/contradiction-scope.md',
    document_type: 'PRD',
    description: 'User story contradicts stated scope',
    expected_behavior: {
      score_not_inflated: false,
      contradiction_detected: true,
      traceability_gap_flagged: false,
      required_finding_categories: ['internal_consistency', 'user_story_coverage'],
    },
  },
  // Traceability tests
  {
    id: 'T1',
    category: 'traceability',
    document_path: 'fixtures/traceability-missing-traces.md',
    document_type: 'TDD',
    description: 'TDD with no traces_from field',
    expected_behavior: {
      score_not_inflated: false,
      contradiction_detected: false,
      traceability_gap_flagged: true,
      required_finding_categories: ['prd_alignment'],
    },
  },
  {
    id: 'T2',
    category: 'traceability',
    document_path: 'fixtures/traceability-nonexistent-parent.md',
    document_type: 'TDD',
    description: 'traces_from references nonexistent PRD',
    expected_behavior: {
      score_not_inflated: false,
      contradiction_detected: false,
      traceability_gap_flagged: true,
    },
  },
  {
    id: 'T3',
    category: 'traceability',
    document_path: 'fixtures/traceability-dropped-requirements.md',
    document_type: 'TDD',
    description: 'TDD silently drops 3 parent requirements',
    expected_behavior: {
      score_not_inflated: false,
      contradiction_detected: false,
      traceability_gap_flagged: true,
      required_finding_categories: ['prd_alignment'],
      required_finding_severities: ['major', 'critical'],
    },
  },
];

// ---------------------------------------------------------------------------
// AdversarialRunner
// ---------------------------------------------------------------------------

/**
 * Runs adversarial test cases against a reviewer executor and validates results.
 */
export class AdversarialRunner {
  /**
   * Execute all provided adversarial test cases and return pass/fail results.
   *
   * @param reviewerExecutor - Adapter for the reviewer execution layer
   * @param testCases - Array of adversarial test cases to run
   * @returns Array of results, one per test case
   */
  async runAdversarialTests(
    reviewerExecutor: ReviewerExecutorAdapter,
    testCases: AdversarialTestCase[],
  ): Promise<AdversarialTestResult[]> {
    const results: AdversarialTestResult[] = [];

    for (const testCase of testCases) {
      // In a real integration test, we would read the document from disk.
      // The runner delegates document loading to the test harness.
      const reviewResult = await reviewerExecutor.executeReview(
        testCase.document_path,
        testCase.document_type,
      );

      const validation = validateResult(
        testCase,
        reviewResult.score,
        reviewResult.outcome,
        reviewResult.findings,
      );

      results.push({
        test_id: testCase.id,
        category: testCase.category,
        actual_score: reviewResult.score,
        actual_outcome: reviewResult.outcome,
        actual_findings: reviewResult.findings,
        expected_behavior_met: validation.pass,
        failures: validation.failures,
      });
    }

    return results;
  }
}
