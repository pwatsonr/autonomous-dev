/**
 * Deterministic mock for `rule-set-enforcement-reviewer` (SPEC-022-2-05).
 *
 * Returns a single `SQL_INJECTION` finding when the diff contains the
 * planted vulnerable string; otherwise returns no findings. Used by the
 * standards-to-fix integration test to keep the e2e flow deterministic
 * without invoking the real LLM-backed agent.
 *
 * @module tests/fixtures/agents/mock-rule-set-enforcement-reviewer
 */

export interface MockReviewerInput {
  diff: string;
}

export interface MockSecurityFinding {
  finding_id: string;
  rule_id: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  location: { file: string; line: number };
  message: string;
}

export interface MockReviewerOutput {
  artifact_type: 'security-findings';
  findings: MockSecurityFinding[];
}

/** The exact SQL fragment the integration test plants in the diff. */
const SQL_INJECTION_MARKER = `SELECT * FROM users WHERE id = '`;

export default async function mockReviewer(
  input: MockReviewerInput,
): Promise<MockReviewerOutput> {
  const findings: MockSecurityFinding[] = input.diff.includes(SQL_INJECTION_MARKER)
    ? [
        {
          finding_id: 'SQLI-001',
          rule_id: 'SQL_INJECTION',
          severity: 'critical',
          location: { file: 'src/db.js', line: 42 },
          message: 'String concatenation in SQL query',
        },
      ]
    : [];
  return { artifact_type: 'security-findings', findings };
}
