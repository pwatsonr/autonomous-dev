import { ReviewerOutputValidator } from '../../src/review-gate/reviewer-output-validator';
import type { Rubric } from '../../src/review-gate/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a minimal rubric with the given category definitions.
 */
function makeRubric(
  categories: { id: string; name: string; weight: number }[],
): Rubric {
  return {
    document_type: 'PRD',
    version: '1.0.0',
    approval_threshold: 85,
    total_weight: 100,
    categories: categories.map(c => ({
      id: c.id,
      name: c.name,
      weight: c.weight,
      description: `Measures ${c.name}`,
      min_threshold: 60,
      calibration: {
        score_0: 'Poor',
        score_50: 'Average',
        score_100: 'Excellent',
      },
    })),
  };
}

/**
 * Creates a complete, valid ReviewOutput JSON string.
 */
function makeValidOutput(overrides: Record<string, unknown> = {}): string {
  const base = {
    reviewer_id: 'llm-assigned-id',
    reviewer_role: 'product-analyst',
    document_id: 'doc-001',
    document_version: '1.0.0',
    timestamp: '2026-01-15T10:00:00Z',
    scoring_mode: 'document_level',
    category_scores: [
      {
        category_id: 'clarity',
        score: 85,
        section_scores: null,
        justification: 'Clear and well-written.',
      },
      {
        category_id: 'completeness',
        score: 78,
        section_scores: null,
        justification: 'Mostly complete.',
      },
    ],
    findings: [
      {
        id: 'f-001',
        section_id: 'requirements',
        category_id: 'completeness',
        severity: 'minor',
        critical_sub: null,
        upstream_defect: false,
        description: 'Missing edge case coverage.',
        evidence: 'Section 3.2 does not address error scenarios.',
        suggested_resolution: 'Add error handling requirements.',
      },
    ],
    summary: 'Overall good quality with minor gaps.',
    ...overrides,
  };
  return JSON.stringify(base);
}

/** Default two-category rubric matching the valid output helper. */
const DEFAULT_RUBRIC = makeRubric([
  { id: 'clarity', name: 'Clarity', weight: 50 },
  { id: 'completeness', name: 'Completeness', weight: 50 },
]);

const SYSTEM_REVIEWER_ID = 'product-analyst-12345';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReviewerOutputValidator', () => {
  let validator: ReviewerOutputValidator;

  beforeEach(() => {
    validator = new ReviewerOutputValidator();
  });

  // 1. Valid output passes
  test('valid output passes with no warnings or errors', () => {
    const result = validator.validateAndParse(
      makeValidOutput(),
      DEFAULT_RUBRIC,
      SYSTEM_REVIEWER_ID,
    );

    expect(result.success).toBe(true);
    expect(result.review_output).not.toBeNull();
    expect(result.warnings).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.review_output!.category_scores).toHaveLength(2);
    expect(result.review_output!.findings).toHaveLength(1);
  });

  // 2. JSON in markdown code block
  test('extracts JSON from markdown ```json code block', () => {
    const wrapped = '```json\n' + makeValidOutput() + '\n```';
    const result = validator.validateAndParse(wrapped, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);
    expect(result.review_output).not.toBeNull();
  });

  // 3. JSON in plain code block
  test('extracts JSON from plain ``` code block', () => {
    const wrapped = '```\n' + makeValidOutput() + '\n```';
    const result = validator.validateAndParse(wrapped, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);
    expect(result.review_output).not.toBeNull();
  });

  // 4. Trailing comma tolerance
  test('parses JSON with trailing commas', () => {
    const jsonWithTrailingComma = `{
      "reviewer_id": "r1",
      "reviewer_role": "product-analyst",
      "document_id": "doc-001",
      "document_version": "1.0.0",
      "timestamp": "2026-01-15T10:00:00Z",
      "scoring_mode": "document_level",
      "category_scores": [
        {
          "category_id": "clarity",
          "score": 85,
          "section_scores": null,
          "justification": "Good",
        },
        {
          "category_id": "completeness",
          "score": 78,
          "section_scores": null,
          "justification": "Decent",
        },
      ],
      "findings": [],
      "summary": "Fine overall.",
    }`;

    const result = validator.validateAndParse(jsonWithTrailingComma, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);
    expect(result.success).toBe(true);
    expect(result.review_output).not.toBeNull();
  });

  // 5. Single-line comment tolerance
  test('parses JSON with single-line comments', () => {
    const jsonWithComments = `{
      // This is a reviewer comment
      "reviewer_id": "r1",
      "reviewer_role": "product-analyst",
      "document_id": "doc-001",
      "document_version": "1.0.0",
      "timestamp": "2026-01-15T10:00:00Z",
      "scoring_mode": "document_level",
      "category_scores": [
        {
          "category_id": "clarity",
          "score": 85,
          "section_scores": null,
          "justification": "Good"
        },
        {
          "category_id": "completeness",
          "score": 78,
          "section_scores": null,
          "justification": "Decent"
        }
      ],
      "findings": [],
      "summary": "Fine overall."
    }`;

    const result = validator.validateAndParse(jsonWithComments, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);
    expect(result.success).toBe(true);
    expect(result.review_output).not.toBeNull();
  });

  // 6. Completely invalid output
  test('returns failure for non-JSON output', () => {
    const result = validator.validateAndParse(
      'I cannot evaluate this document.',
      DEFAULT_RUBRIC,
      SYSTEM_REVIEWER_ID,
    );

    expect(result.success).toBe(false);
    expect(result.review_output).toBeNull();
    expect(result.errors.length).toBeGreaterThan(0);
  });

  // 7. Score out of range (high)
  test('clamps score above 100 to 100 with warning', () => {
    const output = makeValidOutput({
      category_scores: [
        {
          category_id: 'clarity',
          score: 115,
          section_scores: null,
          justification: 'Excellent!',
        },
        {
          category_id: 'completeness',
          score: 78,
          section_scores: null,
          justification: 'Mostly complete.',
        },
      ],
    });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);
    expect(result.review_output).not.toBeNull();

    const clarityScore = result.review_output!.category_scores.find(
      cs => cs.category_id === 'clarity',
    );
    expect(clarityScore!.score).toBe(100);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Score for category 'clarity' was 115, clamped to 100"),
    );
  });

  // 8. Score out of range (low)
  test('clamps score below 0 to 0 with warning', () => {
    const output = makeValidOutput({
      category_scores: [
        {
          category_id: 'clarity',
          score: -5,
          section_scores: null,
          justification: 'Very poor.',
        },
        {
          category_id: 'completeness',
          score: 78,
          section_scores: null,
          justification: 'Mostly complete.',
        },
      ],
    });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);
    expect(result.review_output).not.toBeNull();

    const clarityScore = result.review_output!.category_scores.find(
      cs => cs.category_id === 'clarity',
    );
    expect(clarityScore!.score).toBe(0);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("Score for category 'clarity' was -5, clamped to 0"),
    );
  });

  // 9. Missing category
  test('assigns score 0 with critical:blocking finding for missing category', () => {
    const rubric = makeRubric([
      { id: 'clarity', name: 'Clarity', weight: 30 },
      { id: 'completeness', name: 'Completeness', weight: 30 },
      { id: 'consistency', name: 'Consistency', weight: 40 },
    ]);

    // Output only has 2 of 3 categories
    const output = makeValidOutput();
    const result = validator.validateAndParse(output, rubric, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);
    expect(result.review_output).not.toBeNull();

    // Should have 3 category scores now
    expect(result.review_output!.category_scores).toHaveLength(3);

    const consistencyScore = result.review_output!.category_scores.find(
      cs => cs.category_id === 'consistency',
    );
    expect(consistencyScore).toBeDefined();
    expect(consistencyScore!.score).toBe(0);
    expect(consistencyScore!.justification).toBe('Category not evaluated by reviewer.');

    // Should have auto-generated finding
    const sysFinding = result.review_output!.findings.find(
      f => f.id === 'sys-missing-consistency',
    );
    expect(sysFinding).toBeDefined();
    expect(sysFinding!.severity).toBe('critical');
    expect(sysFinding!.critical_sub).toBe('blocking');

    expect(result.warnings).toContainEqual(
      expect.stringContaining("Missing category 'consistency'"),
    );
  });

  // 10. Multiple missing categories
  test('generates findings for multiple missing categories', () => {
    const rubric = makeRubric([
      { id: 'clarity', name: 'Clarity', weight: 20 },
      { id: 'completeness', name: 'Completeness', weight: 20 },
      { id: 'consistency', name: 'Consistency', weight: 20 },
      { id: 'testability', name: 'Testability', weight: 20 },
      { id: 'risk', name: 'Risk', weight: 20 },
    ]);

    // Output only has 2 of 5 categories
    const output = makeValidOutput();
    const result = validator.validateAndParse(output, rubric, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);

    // 3 auto-generated findings (for consistency, testability, risk)
    const sysFindings = result.review_output!.findings.filter(f =>
      f.id.startsWith('sys-missing-'),
    );
    expect(sysFindings).toHaveLength(3);

    expect(sysFindings.map(f => f.category_id).sort()).toEqual([
      'consistency',
      'risk',
      'testability',
    ]);
  });

  // 11. Missing required Finding field (evidence)
  test('returns failure when finding is missing required evidence field', () => {
    const output = makeValidOutput({
      findings: [
        {
          id: 'f-001',
          section_id: 'requirements',
          category_id: 'completeness',
          severity: 'minor',
          critical_sub: null,
          upstream_defect: false,
          description: 'Missing edge case.',
          // evidence is missing
          suggested_resolution: 'Add error handling.',
        },
      ],
    });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'evidence'"),
    );
  });

  // 12. Critical finding missing critical_sub
  test('defaults critical_sub to blocking when missing for critical finding', () => {
    const output = makeValidOutput({
      findings: [
        {
          id: 'f-001',
          section_id: 'requirements',
          category_id: 'completeness',
          severity: 'critical',
          // critical_sub missing
          upstream_defect: false,
          description: 'Major security gap.',
          evidence: 'No authentication described.',
          suggested_resolution: 'Add auth section.',
        },
      ],
    });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);
    const finding = result.review_output!.findings.find(f => f.id === 'f-001');
    expect(finding!.critical_sub).toBe('blocking');
    expect(result.warnings).toContainEqual(
      expect.stringContaining("no critical_sub"),
    );
  });

  // 13. Major finding missing suggested_resolution
  test('warns but does not reject when major finding lacks suggested_resolution', () => {
    const output = makeValidOutput({
      findings: [
        {
          id: 'f-001',
          section_id: 'requirements',
          category_id: 'completeness',
          severity: 'major',
          critical_sub: null,
          upstream_defect: false,
          description: 'Incomplete coverage.',
          evidence: 'Section 2 is missing NFRs.',
          // suggested_resolution missing
        },
      ],
    });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.stringContaining("no suggested_resolution"),
    );
  });

  // 14. Invalid severity value
  test('returns failure for invalid severity value', () => {
    const output = makeValidOutput({
      findings: [
        {
          id: 'f-001',
          section_id: 'requirements',
          category_id: 'completeness',
          severity: 'important', // invalid
          critical_sub: null,
          upstream_defect: false,
          description: 'Some issue.',
          evidence: 'Evidence here.',
          suggested_resolution: 'Fix it.',
        },
      ],
    });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("invalid severity"),
    );
  });

  // 15. Reviewer ID override
  test('overrides reviewer_id with system-assigned value', () => {
    const output = makeValidOutput({ reviewer_id: 'self-assigned' });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(true);
    expect(result.review_output!.reviewer_id).toBe(SYSTEM_REVIEWER_ID);
    expect(result.review_output!.reviewer_id).not.toBe('self-assigned');
  });

  // 16. Empty category_scores array
  test('returns failure for empty category_scores array', () => {
    const output = makeValidOutput({ category_scores: [] });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('category_scores'),
    );
  });

  // 17. Invalid timestamp format
  test('returns failure for invalid timestamp', () => {
    const output = makeValidOutput({ timestamp: 'yesterday' });

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('timestamp'),
    );
  });

  // 18. Missing summary
  test('returns failure when summary is missing', () => {
    const raw = JSON.parse(makeValidOutput());
    delete raw.summary;
    const output = JSON.stringify(raw);

    const result = validator.validateAndParse(output, DEFAULT_RUBRIC, SYSTEM_REVIEWER_ID);

    expect(result.success).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining('summary'),
    );
  });
});
