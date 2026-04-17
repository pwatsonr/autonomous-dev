# SPEC-004-1-2: Section Mappings, Score Aggregator & Approval Evaluator

## Metadata
- **Parent Plan**: PLAN-004-1
- **Tasks Covered**: Task 4, Task 5, Task 6
- **Estimated effort**: 9 hours

## Description

Implement the section-to-category mapping definitions, the score aggregation engine (single and multi-reviewer), and the three-part approval decision logic. These components form the scoring pipeline: section mappings tell the system which sections contribute to which rubric categories, the ScoreAggregator computes weighted and aggregated scores, and the ApprovalEvaluator makes the final pass/fail decision.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/section-mappings.ts` | Create | Section-to-category mapping definitions for all 5 document types |
| `src/review-gate/score-aggregator.ts` | Create | Score calculation for single and multi-reviewer scenarios |
| `src/review-gate/approval-evaluator.ts` | Create | Three-part approval decision logic |

## Implementation Details

### 1. Section-to-Category Mappings (`section-mappings.ts`)

**Type definition:**
```typescript
interface SectionMapping {
  section_id: string;
  category_ids: string[];
}

interface DocumentSectionMappings {
  document_type: DocumentType;
  mappings: SectionMapping[];
  word_count_threshold: number;  // below this, fall back to document-level scoring (default: 500)
}
```

**PRD Section Mappings** (from TDD section 3.3.1):

| Section ID | Category IDs |
|------------|-------------|
| `problem_statement` | `["problem_clarity"]` |
| `goals` | `["goals_measurability", "internal_consistency"]` |
| `user_stories` | `["user_story_coverage", "internal_consistency"]` |
| `functional_requirements` | `["requirements_completeness", "requirements_testability", "internal_consistency"]` |
| `non_functional_requirements` | `["requirements_completeness", "requirements_testability"]` |
| `success_metrics` | `["goals_measurability"]` |
| `risks_and_mitigations` | `["risk_identification"]` |

**TDD Section Mappings:**

| Section ID | Category IDs |
|------------|-------------|
| `overview` | `["prd_alignment"]` |
| `architecture` | `["architecture_soundness", "prd_alignment"]` |
| `detailed_design` | `["architecture_soundness", "data_model_integrity", "api_contract_completeness"]` |
| `data_models` | `["data_model_integrity"]` |
| `api_contracts` | `["api_contract_completeness"]` |
| `integrations` | `["integration_robustness"]` |
| `security` | `["security_depth"]` |
| `trade_offs` | `["tradeoff_rigor"]` |

**Plan Section Mappings:**

| Section ID | Category IDs |
|------------|-------------|
| `tasks` | `["work_unit_granularity", "tdd_alignment"]` |
| `dependencies` | `["dependency_accuracy"]` |
| `testing_strategy` | `["test_strategy_coverage"]` |
| `effort_estimates` | `["effort_estimation"]` |
| `risks` | `["risk_awareness"]` |
| `tdd_traceability` | `["tdd_alignment"]` |

**Spec Section Mappings:**

| Section ID | Category IDs |
|------------|-------------|
| `acceptance_criteria` | `["acceptance_criteria_precision", "plan_alignment"]` |
| `files_to_create_modify` | `["file_path_accuracy"]` |
| `test_cases` | `["test_case_coverage"]` |
| `implementation_details` | `["code_pattern_clarity"]` |
| `plan_traceability` | `["plan_alignment"]` |
| `dependencies` | `["dependency_completeness"]` |

**Code Section Mappings:**

| Section ID | Category IDs |
|------------|-------------|
| `implementation` | `["spec_compliance", "code_quality", "maintainability"]` |
| `tests` | `["test_coverage"]` |
| `documentation` | `["documentation_completeness"]` |
| `performance_paths` | `["performance"]` |
| `security_paths` | `["security"]` |
| `spec_traceability` | `["spec_compliance"]` |

**Exported functions:**

- `getSectionMappings(documentType: DocumentType): DocumentSectionMappings` -- Returns mappings for the given type. Throws if not found.
- `getCategoryForSection(documentType: DocumentType, sectionId: string): string[]` -- Returns category IDs for a given section.
- `getSectionsForCategory(documentType: DocumentType, categoryId: string): string[]` -- Returns section IDs for a given category (inverse lookup).
- `shouldUseDocumentLevelScoring(documentType: DocumentType, wordCount: number): boolean` -- Returns `true` if word count is below threshold or no mapping exists for the document type.

**Multi-section category minimum rule:**
When a category spans multiple sections (e.g., `internal_consistency` in PRD spans Goals, User Stories, and Functional Requirements), the category score is the **minimum** of its per-section scores. This is enforced in the ScoreAggregator, but the mappings module provides the inverse lookup to identify multi-section categories.

### 2. ScoreAggregator (`score-aggregator.ts`)

**Class: `ScoreAggregator`**

**Single-reviewer weighted score:**
```typescript
computeWeightedScore(categoryScores: CategoryScore[], rubric: Rubric): number
```

Formula:
```
score = SUM(categoryScore[i].score * (rubric.categories[i].weight / 100))
```

Result rounded to 2 decimal places using `Math.round(score * 100) / 100`.

**Multi-section category resolution:**
```typescript
resolveCategoryScore(categoryScore: CategoryScore): number
```
- If `section_scores` is null (document-level), return `categoryScore.score` directly.
- If `section_scores` is non-null (per-section), return `Math.min(...section_scores.map(s => s.score))`.

**Multi-reviewer aggregation:**
```typescript
aggregateScores(
  reviewerOutputs: ReviewOutput[],
  rubric: Rubric,
  method: "mean" | "median" | "min"
): AggregationResult
```

Where `AggregationResult`:
```typescript
interface AggregationResult {
  aggregate_score: number;
  per_reviewer_scores: { reviewer_id: string; weighted_score: number }[];
  category_aggregates: CategoryAggregate[];
}
```

**Aggregation formulas:**

- **Mean**: `aggregate = SUM(reviewer_weighted_scores) / reviewer_count`. Round to 2 decimal places.
- **Median**: Sort reviewer weighted scores. If odd count, take middle. If even count, take mean of two middle values. Round to 2 decimal places.
- **Min**: `aggregate = Math.min(...reviewer_weighted_scores)`. Round to 2 decimal places.

**Per-category aggregation:**
For each category, compute the aggregate (using same method) across reviewers' scores for that category. Populate `CategoryAggregate.per_reviewer_scores` and `CategoryAggregate.threshold_violated`.

**TDD worked example verification (single reviewer):**
Input: PRD rubric, scores [92, 78, 85, 70, 88, 65, 90] for the 7 categories with weights [15, 15, 15, 20, 15, 10, 10].
Expected: `0.15*92 + 0.15*78 + 0.15*85 + 0.20*70 + 0.15*88 + 0.10*65 + 0.10*90 = 13.80 + 11.70 + 12.75 + 14.00 + 13.20 + 6.50 + 9.00 = 80.95`

**TDD worked example verification (two reviewers, mean):**
Reviewer A weighted score: 87.50. Reviewer B weighted score: 81.65.
Expected: `(87.50 + 81.65) / 2 = 84.575`, rounded to `84.58`.

**Edge cases:**
- Single reviewer: aggregation returns that reviewer's score.
- All identical scores: all methods return the same value.
- Empty reviewer array: return `NaN` (handled by ApprovalEvaluator).
- Category with weight 0: skip in weighted sum calculation, log warning.

### 3. ApprovalEvaluator (`approval-evaluator.ts`)

**Class: `ApprovalEvaluator`**

```typescript
evaluate(
  aggregationResult: AggregationResult,
  reviewerOutputs: ReviewOutput[],
  rubric: Rubric,
  iterationCount: number,
  maxIterations: number
): ApprovalDecision
```

Where `ApprovalDecision`:
```typescript
interface ApprovalDecision {
  outcome: "approved" | "changes_requested" | "rejected";
  reasons: string[];
  auto_generated_findings: Finding[];
  threshold_met: boolean;
  has_critical_blocking: boolean;
  has_critical_reject: boolean;
  floor_violations: { category_id: string; reviewer_id: string; score: number; min_threshold: number }[];
}
```

**Three-part approval check (TDD section 3.4.2):**

1. **Aggregate score check**: `aggregationResult.aggregate_score >= rubric.approval_threshold`. Threshold is inclusive (equal passes).

2. **Critical finding check**: Scan all `reviewerOutputs[].findings` for `severity === "critical"`.
   - If any finding has `critical_sub === "reject"`: `outcome = "rejected"` immediately, no further checks.
   - If any finding has `critical_sub === "blocking"`: `outcome = "changes_requested"` (author can fix).

3. **Per-category floor check**: For each category in the rubric where `min_threshold !== null`, check every reviewer's score for that category. If any reviewer scored below the floor:
   - Auto-generate a `Finding` with:
     - `severity: "major"`
     - `section_id`: derived from section mappings for that category
     - `category_id`: the failing category
     - `description`: `"Category '{category_name}' scored {score} by reviewer {reviewer_id}, below the minimum threshold of {min_threshold}."`
     - `evidence`: `"Reviewer {reviewer_id} scored {score}/{min_threshold}"`
     - `suggested_resolution`: `"Improve the quality of content in the '{category_name}' area to meet the minimum standard of {min_threshold}/100."`
   - Force `outcome = "changes_requested"` even if aggregate is above threshold.

**Decision flow:**
```
if any finding has critical_sub === "reject":
    return "rejected"
if aggregate_score is NaN or Infinity:
    log error with all input scores
    return "changes_requested"
if aggregate_score >= threshold AND no critical findings AND no floor violations:
    return "approved"
if iteration_count >= max_iterations:
    return "rejected"
return "changes_requested"
```

Note: The `iteration_count >= max_iterations` check is informational here. The IterationController (PLAN-004-3) is the authoritative source for max-iteration rejection. The ApprovalEvaluator includes it as a defensive check.

## Acceptance Criteria

1. PRD section mapping matches TDD section 3.3.1 table exactly (7 sections mapped to categories).
2. When a category spans multiple sections, `getSectionsForCategory()` returns all section IDs.
3. Fallback to document-level scoring returns `true` when document is under 500 words.
4. Single-reviewer weighted score reproduces TDD worked example: 80.95 for the given PRD scores.
5. Two-reviewer mean aggregation reproduces TDD worked example: 84.58 (rounded) for the given TDD scores.
6. Median aggregation works correctly for 1, 2, 3, and 5 reviewer counts.
7. Min aggregation returns the lowest reviewer's weighted score.
8. Per-section scoring: when a category spans multiple sections, `resolveCategoryScore()` returns the minimum of section scores.
9. Document is approved only when ALL three conditions pass (TDD 3.4.2).
10. `critical:blocking` findings cause `changes_requested` outcome.
11. `critical:reject` findings cause immediate `rejected` outcome.
12. Per-category floor violations auto-generate `major` findings with descriptive text.
13. Threshold check is inclusive (score exactly equal to threshold passes).
14. `NaN`/`Infinity` aggregate score defaults to `changes_requested` with error logged.
15. Category with weight 0 is skipped in score calculation with a logged warning.

## Test Cases

### `tests/review-gate/section-mappings.test.ts`
1. **PRD mappings completeness**: Verify all 7 PRD sections are mapped and all 7 categories are reachable.
2. **Internal consistency spans 3 sections**: Call `getSectionsForCategory("PRD", "internal_consistency")`, verify returns `["goals", "user_stories", "functional_requirements"]`.
3. **Inverse lookup**: Call `getCategoryForSection("PRD", "functional_requirements")`, verify returns `["requirements_completeness", "requirements_testability", "internal_consistency"]`.
4. **Document-level fallback at 499 words**: `shouldUseDocumentLevelScoring("PRD", 499)` returns `true`.
5. **Per-section mode at 500 words**: `shouldUseDocumentLevelScoring("PRD", 500)` returns `false`.
6. **All 5 document types have mappings**: Loop and verify no throws.

### `tests/review-gate/score-aggregator.test.ts`
1. **TDD worked example (single reviewer, PRD)**: Input scores [92, 78, 85, 70, 88, 65, 90]. Expected: 80.95.
2. **TDD worked example (two reviewers, TDD, mean)**: Reviewer A = 87.50, Reviewer B = 81.65. Expected aggregate: 84.58.
3. **Median with 3 reviewers**: Scores [80, 85, 90]. Expected median: 85.
4. **Median with 2 reviewers**: Scores [80, 90]. Expected median: 85 (mean of two middle values).
5. **Min aggregation**: Scores [80, 85, 90]. Expected: 80.
6. **Single reviewer, all methods**: Score 75. All aggregation methods return 75.
7. **All identical scores**: Three reviewers all score 82. All methods return 82.
8. **Multi-section category minimum**: Category has section_scores [{section_id: "goals", score: 90}, {section_id: "user_stories", score: 70}]. `resolveCategoryScore()` returns 70.
9. **Document-level scoring (null section_scores)**: `resolveCategoryScore()` returns the `score` field directly.
10. **Empty reviewer array**: Returns NaN for aggregate.
11. **Zero-weight category**: Category with weight 0 is excluded from sum. Remaining categories produce correct result.
12. **Per-category aggregation**: Two reviewers with scores for `problem_clarity` of 90 and 80. Mean aggregate for that category is 85.

### `tests/review-gate/approval-evaluator.test.ts`
1. **All conditions pass -- approved**: Aggregate 86, threshold 85, no critical findings, no floor violations. Outcome: `approved`.
2. **Score exactly at threshold -- approved**: Aggregate 85, threshold 85. Outcome: `approved`.
3. **Score one below threshold -- changes_requested**: Aggregate 84.99, threshold 85. Outcome: `changes_requested`.
4. **Critical blocking finding -- changes_requested**: Aggregate 90 (above threshold), but one finding is `critical:blocking`. Outcome: `changes_requested`.
5. **Critical reject finding -- rejected**: Aggregate 90, one finding is `critical:reject`. Outcome: `rejected` immediately.
6. **Floor violation -- changes_requested**: Aggregate 86 (above threshold), but reviewer scored `risk_identification` at 40, min_threshold 50. Outcome: `changes_requested` with auto-generated `major` finding.
7. **Floor violation auto-generated finding content**: Verify the auto-generated finding has correct `category_id`, `severity: "major"`, `description` mentioning the score and threshold, and `suggested_resolution`.
8. **Multiple floor violations**: Two categories violated. Two auto-generated findings produced.
9. **NaN aggregate -- changes_requested**: Aggregate is NaN. Outcome: `changes_requested`.
10. **Infinity aggregate -- changes_requested**: Aggregate is Infinity. Outcome: `changes_requested`.
11. **No reviewers, no findings**: Empty reviewer outputs. Aggregate NaN. Outcome: `changes_requested`.
12. **Critical reject takes precedence over score pass**: Score above threshold, but `critical:reject` finding present. Outcome: `rejected`.
