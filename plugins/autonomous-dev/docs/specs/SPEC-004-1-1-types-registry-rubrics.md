# SPEC-004-1-1: Core Types, Rubric Registry & Hardcoded Rubric Definitions

## Metadata
- **Parent Plan**: PLAN-004-1
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 11 hours

## Description

Establish the foundational type system, rubric registry, and all five hardcoded rubric definitions for the review gate system. This spec delivers the bedrock that every other review gate component depends on: the TypeScript interfaces for all data models (review outputs, findings, scores, gate records), the registry that stores and validates rubrics, and the complete rubric definitions for PRD, TDD, Plan, Spec, and Code document types as specified in TDD-004 sections 3.2.2 through 3.2.6.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/types.ts` | Create | All core TypeScript interfaces and type unions |
| `src/review-gate/rubric-registry.ts` | Create | Registry for storing, validating, and retrieving rubrics |
| `src/review-gate/rubrics/prd-rubric.ts` | Create | Hardcoded PRD rubric definition |
| `src/review-gate/rubrics/tdd-rubric.ts` | Create | Hardcoded TDD rubric definition |
| `src/review-gate/rubrics/plan-rubric.ts` | Create | Hardcoded Plan rubric definition |
| `src/review-gate/rubrics/spec-rubric.ts` | Create | Hardcoded Spec rubric definition |
| `src/review-gate/rubrics/code-rubric.ts` | Create | Hardcoded Code rubric definition |
| `src/review-gate/rubrics/index.ts` | Create | Barrel export for all rubric definitions |

## Implementation Details

### 1. Core TypeScript Interfaces (`types.ts`)

**`DocumentType` union:**
```typescript
type DocumentType = "PRD" | "TDD" | "Plan" | "Spec" | "Code";
```

**`TrustLevel` union:**
```typescript
type TrustLevel = "full_auto" | "approve_roots" | "approve_phase_1" | "approve_all" | "human_only";
```

**`FindingSeverity` and `CriticalSub`:**
```typescript
type FindingSeverity = "critical" | "major" | "minor" | "suggestion";
type CriticalSub = "blocking" | "reject";
```

**`CalibrationExamples` interface:**
```typescript
interface CalibrationExamples {
  score_0: string;
  score_50: string;
  score_100: string;
}
```

**`RubricCategory` interface:**
```typescript
interface RubricCategory {
  id: string;
  name: string;
  weight: number;           // percentage, e.g. 15 means 15%
  description: string;
  min_threshold: number | null;
  calibration: CalibrationExamples;
}
```

**`Rubric` interface:**
```typescript
interface Rubric {
  document_type: DocumentType;
  version: string;
  approval_threshold: number;  // 0-100
  categories: RubricCategory[];
  total_weight: 100;           // invariant enforced at runtime
}
```

**`SectionScore` interface:**
```typescript
interface SectionScore {
  section_id: string;
  score: number;  // 0-100 integer
}
```

**`CategoryScore` interface:**
```typescript
interface CategoryScore {
  category_id: string;
  score: number;             // 0-100 integer
  section_scores: SectionScore[] | null;
  justification: string;
}
```

**`Finding` interface:**
```typescript
interface Finding {
  id: string;
  section_id: string;
  category_id: string;
  severity: FindingSeverity;
  critical_sub: CriticalSub | null;
  upstream_defect: boolean;
  description: string;
  evidence: string;
  suggested_resolution: string;
}
```

**`ReviewOutput` interface:**
```typescript
interface ReviewOutput {
  reviewer_id: string;
  reviewer_role: string;
  document_id: string;
  document_version: string;
  timestamp: string;           // ISO 8601
  scoring_mode: "per_section" | "document_level";
  category_scores: CategoryScore[];
  findings: Finding[];
  summary: string;
}
```

**`CategoryAggregate` interface:**
```typescript
interface CategoryAggregate {
  category_id: string;
  category_name: string;
  weight: number;
  aggregate_score: number;
  per_reviewer_scores: { reviewer_id: string; score: number }[];
  min_threshold: number | null;
  threshold_violated: boolean;
}
```

**`MergedFinding` interface:**
```typescript
interface MergedFinding {
  id: string;
  section_id: string;
  category_id: string;
  severity: FindingSeverity;
  critical_sub: CriticalSub | null;
  upstream_defect: boolean;
  description: string;
  evidence: string;
  suggested_resolution: string;
  reported_by: string[];
  resolution_status: "open" | "resolved" | "recurred" | null;
  prior_finding_id: string | null;
}
```

**`Disagreement` interface:**
```typescript
interface Disagreement {
  category_id: string;
  variance: number;
  reviewer_scores: { reviewer_id: string; score: number }[];
  note: string;
}
```

**`QualityRegression` interface:**
```typescript
interface QualityRegression {
  previous_score: number;
  current_score: number;
  delta: number;
  rollback_recommended: boolean;
}
```

**`GateReviewResult` interface:**
```typescript
interface GateReviewResult {
  gate_id: string;
  document_id: string;
  document_version: string;
  iteration: number;
  outcome: "approved" | "changes_requested" | "rejected";
  aggregate_score: number;
  threshold: number;
  aggregation_method: "mean" | "median" | "min";
  category_aggregates: CategoryAggregate[];
  findings: MergedFinding[];
  disagreements: Disagreement[];
  quality_regression: QualityRegression | null;
  stagnation_warning: boolean;
  summary: string;
}
```

**`ReviewGateRecord` interface:**
```typescript
interface ReviewGateRecord {
  gate_id: string;
  document_id: string;
  document_type: DocumentType;
  document_version: string;
  pipeline_id: string;
  iteration: number;
  max_iterations: number;
  rubric_version: string;
  threshold: number;
  aggregation_method: "mean" | "median" | "min";
  panel_size: number;
  trust_level: TrustLevel;
  reviewer_outputs: ReviewOutput[];
  aggregate_score: number;
  category_aggregates: CategoryAggregate[];
  outcome: "approved" | "changes_requested" | "rejected";
  merged_findings: MergedFinding[];
  disagreements: Disagreement[];
  quality_regression: QualityRegression | null;
  stagnation_warning: boolean;
  human_escalation: boolean;
  started_at: string;
  completed_at: string;
  created_by: string;
}
```

**`PersistedRubric` interface:**
```typescript
interface PersistedRubric {
  document_type: DocumentType;
  version: string;
  approval_threshold: number;
  categories: {
    id: string;
    name: string;
    weight: number;
    description: string;
    min_threshold: number | null;
    section_mapping: string[];
    calibration: CalibrationExamples;
  }[];
  metadata: {
    created_at: string;
    updated_at: string;
    updated_by: string;
  };
}
```

### 2. RubricRegistry (`rubric-registry.ts`)

**Class: `RubricRegistry`**

Constructor initializes with default rubrics for all 5 document types. Accepts optional overrides map.

**Methods:**

- `getRubric(documentType: DocumentType): Rubric` -- Returns a deep-frozen copy of the rubric for the given document type. Throws `RubricNotFoundError` if type is not registered.

- `validateRubric(rubric: Rubric): ValidationResult` -- Returns `{ valid: boolean, errors: string[] }`. Validation rules:
  1. `categories` array is non-empty.
  2. Every category has non-empty `id`, `name`, `description`.
  3. Every category `weight` is a number > 0.
  4. Sum of all `category.weight` values equals 100 within tolerance of +/- 0.01.
  5. Every category `min_threshold` is null or a number in 0-100.
  6. Every category has valid `calibration` with non-empty `score_0`, `score_50`, `score_100`.
  7. `approval_threshold` is a number in 0-100.
  8. `document_type` is a valid `DocumentType`.
  9. `version` is a non-empty string.
  10. No duplicate `category.id` values.

- `registerRubric(rubric: Rubric): void` -- Validates and stores a rubric. Throws `RubricValidationError` if validation fails. Overwrites existing rubric for the same document type.

- `listDocumentTypes(): DocumentType[]` -- Returns all registered document types.

**Weight sum validation formula:**
```
Math.abs(categories.reduce((sum, c) => sum + c.weight, 0) - 100) <= 0.01
```

### 3. Hardcoded Rubric Definitions

Each rubric file exports a `Rubric` object with exact values from TDD-004.

**PRD Rubric** (`prd-rubric.ts`):
- 7 categories, weights sum to 100, threshold 85
- `problem_clarity`: weight 15, min 60
- `goals_measurability`: weight 15, min 60
- `user_story_coverage`: weight 15, min 60
- `requirements_completeness`: weight 20, min 70
- `requirements_testability`: weight 15, min 60
- `risk_identification`: weight 10, min 50
- `internal_consistency`: weight 10, min 50
- Full calibration examples from TDD-004 section 3.2.2 for `problem_clarity`, `requirements_completeness`, `requirements_testability`. Remaining categories get calibration text derived from their descriptions following the same pattern (0 = absent/vague, 50 = partial/surface-level, 100 = comprehensive/quantified).

**TDD Rubric** (`tdd-rubric.ts`):
- 7 categories, weights sum to 100, threshold 85
- `architecture_soundness`: weight 20, min 70
- `tradeoff_rigor`: weight 15, min 60
- `data_model_integrity`: weight 15, min 60
- `api_contract_completeness`: weight 15, min 60
- `integration_robustness`: weight 10, min 50
- `security_depth`: weight 10, min 50
- `prd_alignment`: weight 15, min 70
- Full calibration examples from TDD-004 section 3.2.3 for `architecture_soundness`, `tradeoff_rigor`, `prd_alignment`.

**Plan Rubric** (`plan-rubric.ts`):
- 6 categories, weights sum to 100, threshold 80
- `work_unit_granularity`: weight 20, min 60
- `dependency_accuracy`: weight 20, min 70
- `test_strategy_coverage`: weight 15, min 60
- `effort_estimation`: weight 15, min 50
- `tdd_alignment`: weight 15, min 70
- `risk_awareness`: weight 15, min 50

**Spec Rubric** (`spec-rubric.ts`):
- 6 categories, weights sum to 100, threshold 80
- `acceptance_criteria_precision`: weight 25, min 70
- `file_path_accuracy`: weight 15, min 60
- `test_case_coverage`: weight 20, min 60
- `code_pattern_clarity`: weight 15, min 50
- `plan_alignment`: weight 15, min 70
- `dependency_completeness`: weight 10, min 50

**Code Rubric** (`code-rubric.ts`):
- 7 categories, weights sum to 100, threshold 85
- `spec_compliance`: weight 25, min 80
- `test_coverage`: weight 20, min 70
- `code_quality`: weight 15, min 60
- `documentation_completeness`: weight 10, min 50
- `performance`: weight 10, min 50
- `security`: weight 10, min 60
- `maintainability`: weight 10, min 50

## Acceptance Criteria

1. All TypeScript interfaces from TDD-004 sections 3.2.1, 3.6.3, 3.7.1, 4.1, 4.2 are defined and exported from `types.ts`.
2. `Finding.severity` is typed as `"critical" | "major" | "minor" | "suggestion"`.
3. `Finding.critical_sub` is typed as `"blocking" | "reject" | null`.
4. All score fields (`CategoryScore.score`, `SectionScore.score`, etc.) are typed as `number` with documented constraint 0-100.
5. `RubricRegistry.getRubric()` returns the correct rubric for each of the 5 document types.
6. `RubricRegistry.validateRubric()` rejects rubrics where category weights do not sum to 100 (+/- 0.01).
7. `RubricRegistry.validateRubric()` rejects rubrics with categories missing `id`, `name`, `description`, or `calibration`.
8. `RubricRegistry.validateRubric()` rejects rubrics with duplicate category IDs.
9. Registry is initialized with hardcoded defaults and accepts overrides via `registerRubric()`.
10. Rubric version is tracked and the returned rubric object is frozen (immutable).
11. PRD rubric has exactly 7 categories summing to 100%.
12. TDD rubric has exactly 7 categories summing to 100%.
13. Plan rubric has exactly 6 categories summing to 100%.
14. Spec rubric has exactly 6 categories summing to 100%.
15. Code rubric has exactly 7 categories summing to 100%.
16. Every hardcoded rubric passes `validateRubric()` without errors.
17. Calibration examples for PRD `problem_clarity`, `requirements_completeness`, `requirements_testability` match TDD-004 section 3.2.2 verbatim.
18. Calibration examples for TDD `architecture_soundness`, `tradeoff_rigor`, `prd_alignment` match TDD-004 section 3.2.3 verbatim.

## Test Cases

### `tests/review-gate/types.test.ts`
1. **Type guard validation**: Verify runtime type guard functions correctly identify valid `DocumentType`, `FindingSeverity`, `TrustLevel` values and reject invalid ones.
2. **Finding construction**: Create a `Finding` object with all required fields, verify no type errors. Attempt to assign invalid severity, verify compile-time or runtime rejection.

### `tests/review-gate/rubric-registry.test.ts`
1. **Retrieve PRD rubric**: Call `getRubric("PRD")`, verify 7 categories, threshold 85, weights sum to 100.
2. **Retrieve TDD rubric**: Call `getRubric("TDD")`, verify 7 categories, threshold 85, weights sum to 100.
3. **Retrieve Plan rubric**: Call `getRubric("Plan")`, verify 6 categories, threshold 80, weights sum to 100.
4. **Retrieve Spec rubric**: Call `getRubric("Spec")`, verify 6 categories, threshold 80, weights sum to 100.
5. **Retrieve Code rubric**: Call `getRubric("Code")`, verify 7 categories, threshold 85, weights sum to 100.
6. **Reject invalid document type**: Call `getRubric("Invalid" as DocumentType)`, expect `RubricNotFoundError`.
7. **Reject weights not summing to 100**: Construct rubric with weights summing to 99. Call `validateRubric()`. Expect `valid: false` with error message mentioning weight sum.
8. **Accept weights summing to 100.005** (within tolerance): Construct rubric with weights summing to 100.005. Call `validateRubric()`. Expect `valid: true`.
9. **Reject weights summing to 100.02** (outside tolerance): Construct rubric with weights summing to 100.02. Expect `valid: false`.
10. **Reject missing category name**: Construct rubric with a category where `name` is empty string. Expect `valid: false`.
11. **Reject missing calibration**: Construct rubric with a category where `calibration.score_0` is empty. Expect `valid: false`.
12. **Reject duplicate category IDs**: Construct rubric with two categories sharing the same `id`. Expect `valid: false`.
13. **Override rubric**: Register a custom PRD rubric with different weights. Call `getRubric("PRD")`. Verify the override is returned.
14. **Returned rubric is frozen**: Call `getRubric("PRD")`. Attempt to mutate a category weight. Verify the mutation throws or has no effect.
15. **All hardcoded rubrics pass validation**: Loop over all 5 document types, call `validateRubric()` on each default rubric, assert all return `valid: true`.
