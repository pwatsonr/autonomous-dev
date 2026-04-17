# SPEC-004-1-3: Pre-Review Validator & Comprehensive Unit Tests

## Metadata
- **Parent Plan**: PLAN-004-1
- **Tasks Covered**: Task 7, Task 8
- **Estimated effort**: 8 hours

## Description

Implement the PreReviewValidator that runs structural validation before any reviewer agent is invoked, and the comprehensive unit test suite for all PLAN-004-1 scoring and validation modules. The PreReviewValidator ensures documents meet basic structural requirements (required sections present, frontmatter schema valid, traceability references resolvable) before spending reviewer agent tokens. The test suite covers all scoring and validation edge cases with the TDD worked examples encoded as regression fixtures.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/pre-review-validator.ts` | Create | Structural validation before reviewer invocation |
| `tests/review-gate/pre-review-validator.test.ts` | Create | Tests for pre-review validation |
| `tests/review-gate/score-aggregator.test.ts` | Create | Tests for scoring pipeline (extends SPEC-004-1-2 cases) |
| `tests/review-gate/approval-evaluator.test.ts` | Create | Tests for approval logic (extends SPEC-004-1-2 cases) |
| `tests/review-gate/rubric-registry.test.ts` | Create | Tests for rubric registry (extends SPEC-004-1-1 cases) |
| `tests/review-gate/fixtures/tdd-worked-examples.ts` | Create | TDD worked example data as regression fixtures |

## Implementation Details

### 1. PreReviewValidator (`pre-review-validator.ts`)

**Class: `PreReviewValidator`**

**Constructor:**
```typescript
constructor(
  private sectionMappings: typeof getSectionMappings,
  private documentStore: DocumentStoreInterface  // interface for resolving traces_from references
)
```

**`DocumentStoreInterface`** (adapter for external document storage):
```typescript
interface DocumentStoreInterface {
  documentExists(documentId: string): Promise<boolean>;
  getSectionIds(documentId: string): Promise<string[]>;
}
```

**Primary method:**
```typescript
async validate(
  document: DocumentForValidation,
  documentType: DocumentType
): Promise<PreReviewValidationResult>
```

**`DocumentForValidation` interface:**
```typescript
interface DocumentForValidation {
  id: string;
  content: string;
  frontmatter: Record<string, unknown>;
  sections: { id: string; title: string; content: string }[];
  traces_from?: { document_id: string; section_ids: string[] }[];
  word_count: number;
}
```

**`PreReviewValidationResult` interface:**
```typescript
interface PreReviewValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  scoring_mode: "per_section" | "document_level";
}

interface ValidationError {
  code: string;
  message: string;
  section_id?: string;
  field?: string;
}

interface ValidationWarning {
  code: string;
  message: string;
}
```

**Validation checks (executed in order):**

**Check 1: Required sections present**
- Retrieve the section mapping for the document type.
- For each section in the mapping, verify the document has a section with a matching `id`.
- Missing sections produce an error:
  ```
  { code: "MISSING_SECTION", message: "Required section '{section_id}' is missing.", section_id }
  ```
- Edge case: If the document type has no section mappings (e.g., custom type), skip this check and emit a warning: `{ code: "NO_SECTION_MAPPING", message: "No section mapping defined for document type '{documentType}'. Skipping section validation." }`.
- Edge case: If the document has 0 required sections (all sections are optional), skip validation entirely and return `valid: true`.

**Check 2: Frontmatter schema validation**
Required frontmatter fields by document type:

| Document Type | Required Fields |
|---------------|----------------|
| PRD | `title`, `status`, `author`, `version`, `created_at` |
| TDD | `title`, `status`, `author`, `version`, `created_at`, `traces_from` |
| Plan | `title`, `status`, `author`, `version`, `created_at`, `traces_from` |
| Spec | `title`, `status`, `author`, `version`, `created_at`, `traces_from` |
| Code | `title`, `status`, `author`, `version`, `created_at`, `traces_from` |

For each required field:
- If missing: `{ code: "MISSING_FRONTMATTER", message: "Required frontmatter field '{field}' is missing.", field }`
- If wrong type (e.g., `version` is not a string): `{ code: "INVALID_FRONTMATTER_TYPE", message: "Frontmatter field '{field}' must be of type '{expected_type}', got '{actual_type}'.", field }`

**Check 3: `traces_from` reference resolution**
For each entry in `document.traces_from`:
- Call `documentStore.documentExists(entry.document_id)`.
- If the parent document does not exist: `{ code: "UNRESOLVABLE_TRACE", message: "traces_from references document '{document_id}' which does not exist." }`
- For each `section_id` in the entry, call `documentStore.getSectionIds(entry.document_id)` and verify the section exists: `{ code: "UNRESOLVABLE_TRACE_SECTION", message: "traces_from references section '{section_id}' in document '{document_id}' which does not exist.", section_id }`

**Check 4: Scoring mode determination**
- If `document.word_count < 500`: set `scoring_mode = "document_level"` and emit warning: `{ code: "SHORT_DOCUMENT", message: "Document is under 500 words ({word_count}). Using document-level scoring." }`
- If no section mapping exists for the document type: set `scoring_mode = "document_level"`.
- Otherwise: set `scoring_mode = "per_section"`.

**Result assembly:**
- `valid = errors.length === 0`.
- Return all errors and warnings regardless of `valid` status (warnings can exist on valid documents).

### 2. TDD Worked Example Fixtures (`fixtures/tdd-worked-examples.ts`)

Encode the exact data from TDD-004 section 3.3.3 as typed test fixtures:

**Fixture 1: Single-reviewer PRD review**
```typescript
export const SINGLE_REVIEWER_PRD = {
  rubric: PRD_RUBRIC,
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
  expected_outcome: "changes_requested" as const,
  threshold: 85,
};
```

**Fixture 2: Two-reviewer TDD review (mean)**
```typescript
export const TWO_REVIEWER_TDD_MEAN = {
  rubric: TDD_RUBRIC,
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
  expected_outcome: "changes_requested" as const,
  threshold: 85,
  expected_disagreement: {
    category_id: "security_depth",
    variance: 15,
    scores: [75, 60],
  },
};
```

### 3. Comprehensive Unit Test Coverage

Tests extend the basic cases defined in SPEC-004-1-1 and SPEC-004-1-2 with additional edge cases and property-based checks.

**Property-based test helpers:**
- `randomScores(count: number)`: Generate random integer arrays in 0-100.
- `randomWeights(count: number)`: Generate random weights summing to 100.
- Verify: `computeWeightedScore()` always produces a result in 0-100 range.
- Verify: `computeWeightedScore()` is deterministic for identical inputs.
- Verify: ApprovalEvaluator is deterministic for identical inputs.

## Acceptance Criteria

1. PreReviewValidator validates all required sections are present for each document type.
2. PreReviewValidator validates frontmatter schema (required fields present, correct types).
3. PreReviewValidator validates `traces_from` references resolve to existing documents.
4. PreReviewValidator validates `traces_from` section references resolve to existing sections.
5. Document with 0 required sections (all optional) returns `valid: true` with no errors.
6. PreReviewValidator returns structured `ValidationError` objects, not just pass/fail.
7. PreReviewValidator determines scoring mode based on word count and mapping availability.
8. Documents under 500 words produce a warning and use document-level scoring.
9. ScoreAggregator tests reproduce TDD worked examples exactly (80.95 single, 84.58 mean).
10. ApprovalEvaluator tests cover threshold pass/fail, critical finding auto-fail, floor violations, NaN handling.
11. RubricRegistry tests cover valid/invalid rubrics, weight sum validation, retrieval by type.
12. Property-based tests verify score aggregation always produces results in 0-100 range.
13. All edge cases tested: 0-weight categories, scores at exact boundaries, empty reviewer arrays.
14. TDD worked examples are encoded as fixtures that serve as regression tests.

## Test Cases

### `tests/review-gate/pre-review-validator.test.ts`

1. **Valid PRD document**: Document with all required sections and valid frontmatter. Returns `valid: true`, `errors: []`, `scoring_mode: "per_section"`.
2. **Missing required section**: PRD document missing `risks_and_mitigations`. Returns `valid: false` with `MISSING_SECTION` error.
3. **Multiple missing sections**: PRD document missing 3 sections. Returns 3 `MISSING_SECTION` errors.
4. **Missing frontmatter field**: TDD document missing `traces_from` in frontmatter. Returns `MISSING_FRONTMATTER` error.
5. **Wrong frontmatter type**: Document with `version: 123` (number instead of string). Returns `INVALID_FRONTMATTER_TYPE` error.
6. **Unresolvable parent document**: `traces_from` references `doc-999` which does not exist. Returns `UNRESOLVABLE_TRACE` error.
7. **Unresolvable parent section**: `traces_from` references `section-xyz` in an existing document, but that section does not exist. Returns `UNRESOLVABLE_TRACE_SECTION` error.
8. **Short document (499 words)**: Returns `valid: true` (if sections pass), `scoring_mode: "document_level"`, warning `SHORT_DOCUMENT`.
9. **Document at exactly 500 words**: Returns `scoring_mode: "per_section"`.
10. **Document type with no section mapping**: Custom document type with no mappings defined. Returns `valid: true` with `NO_SECTION_MAPPING` warning and `scoring_mode: "document_level"`.
11. **All errors are structured**: Every error has `code` and `message`. Section-related errors include `section_id`. Frontmatter errors include `field`.
12. **PRD has no traces_from requirement**: PRD frontmatter does not require `traces_from`. Verify missing `traces_from` on PRD does not produce an error.
13. **Multiple validation failures combine**: Document with missing section AND missing frontmatter AND unresolvable trace. Returns all 3 errors.

### `tests/review-gate/fixtures/tdd-worked-examples.ts` (used as regression tests)

14. **Single-reviewer PRD fixture produces 80.95**: Feed fixture scores through `computeWeightedScore()`, assert 80.95.
15. **Two-reviewer TDD fixture produces 84.58**: Feed fixture scores through `aggregateScores()` with mean, assert 84.58.
16. **Two-reviewer TDD disagrement at security_depth**: Feed fixture through `DisagreementDetector`, assert `security_depth` flagged with variance 15.
17. **Single-reviewer PRD outcome is changes_requested**: Feed through `ApprovalEvaluator`, assert `changes_requested`.
18. **Two-reviewer TDD outcome is changes_requested**: Feed through `ApprovalEvaluator`, assert `changes_requested`.

### Additional property-based and edge-case tests

19. **100 random score sets always produce 0-100 result**: Generate 100 random (scores, weights) pairs. Assert `computeWeightedScore()` result is in [0, 100].
20. **Determinism**: Run same inputs through `computeWeightedScore()` twice, assert identical results.
21. **All-zero scores produce 0**: All categories scored 0. Weighted result is 0.
22. **All-100 scores produce 100**: All categories scored 100. Weighted result is 100.
23. **Boundary: score exactly at threshold passes**: Aggregate 85.00, threshold 85. Outcome: `approved` (assuming no other failures).
24. **Boundary: score 0.01 below threshold fails**: Aggregate 84.99, threshold 85. Outcome: `changes_requested`.
