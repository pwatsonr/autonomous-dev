# PLAN-004-1: Rubric Engine & Scoring Foundation

## Metadata
- **Parent TDD**: TDD-004-review-gates
- **Estimated effort**: 5 days
- **Dependencies**: None (foundational plan)
- **Blocked by**: None
- **Priority**: P0

## Objective

Build the rubric registry, scoring mechanics, pre-review validation, and core data models that every other review gate component depends on. This plan delivers the foundational types and scoring logic that reviewer agents produce output against, the score aggregator consumes, and the iteration controller evaluates.

## Scope

### In Scope
- Rubric schema types (`Rubric`, `RubricCategory`, `CalibrationExamples`)
- RubricRegistry: storage, retrieval, and validation of rubrics by document type
- Hardcoded rubric definitions for all 5 document types (PRD, TDD, Plan, Spec, Code) with categories, weights, min thresholds, and calibration examples per TDD sections 3.2.2 -- 3.2.6
- Section-to-category mapping definitions per TDD section 3.3.1
- Score calculation: per-section scoring (default) and document-level scoring (fallback)
- ScoreAggregator: mean, median, min aggregation across multiple reviewers
- Approval decision logic: aggregate threshold check, critical finding auto-fail, per-category floor enforcement (TDD section 3.4)
- PreReviewValidator: structural completeness, frontmatter schema validation, `traces_from` reference resolution
- Core data models: `ReviewOutput`, `CategoryScore`, `SectionScore`, `Finding`, `GateReviewResult`, `CategoryAggregate`, `ReviewGateRecord`, `PersistedRubric`
- Rubric weight invariant validation (sum to 100)
- Threshold configuration per document type with defaults from TDD section 3.4.1

### Out of Scope
- Reviewer agent execution (PLAN-004-2)
- Multi-reviewer panel assembly (PLAN-004-2)
- Blind scoring context filtering (PLAN-004-2)
- Iteration loop / feedback formatting (PLAN-004-3)
- Smoke tests (PLAN-004-4)
- Metrics collection (PLAN-004-4)
- Operator rubric customization UI (Phase 3, deferred)
- Rubric versioning and migration (Phase 3, deferred)

## Tasks

1. **Define core TypeScript interfaces** -- Create the foundational type definitions for all review gate data models.
   - Files to create/modify:
     - `src/review-gate/types.ts` -- `Rubric`, `RubricCategory`, `CalibrationExamples`, `DocumentType`, `ReviewOutput`, `CategoryScore`, `SectionScore`, `Finding`, `GateReviewResult`, `CategoryAggregate`, `MergedFinding`, `Disagreement`, `QualityRegression`, `ReviewGateRecord`, `PersistedRubric`, `TrustLevel`
   - Acceptance criteria:
     - All interfaces from TDD sections 3.2.1, 3.6.3, 3.7.1, 4.1, 4.2 are defined
     - `Finding.severity` is a union type: `"critical" | "major" | "minor" | "suggestion"`
     - `Finding.critical_sub` is `"blocking" | "reject" | null`
     - Score fields are typed as integers 0--100
     - Weight fields sum validated at type level with runtime check
   - Estimated effort: 4 hours

2. **Implement RubricRegistry** -- Build the registry that stores, validates, and retrieves rubric definitions by document type.
   - Files to create/modify:
     - `src/review-gate/rubric-registry.ts`
   - Acceptance criteria:
     - `getRubric(documentType)` returns the correct rubric
     - `validateRubric(rubric)` rejects rubrics where category weights do not sum to 100 (+/- 0.01 float tolerance)
     - `validateRubric(rubric)` rejects rubrics with categories missing required fields
     - Registry is initialized with hardcoded defaults but accepts overrides
     - Rubric version is tracked and frozen at retrieval time
   - Estimated effort: 3 hours

3. **Define hardcoded rubrics for all 5 document types** -- Encode the complete rubric definitions from TDD sections 3.2.2 through 3.2.6 including all category IDs, weights, min thresholds, descriptions, and calibration examples.
   - Files to create/modify:
     - `src/review-gate/rubrics/prd-rubric.ts`
     - `src/review-gate/rubrics/tdd-rubric.ts`
     - `src/review-gate/rubrics/plan-rubric.ts`
     - `src/review-gate/rubrics/spec-rubric.ts`
     - `src/review-gate/rubrics/code-rubric.ts`
   - Acceptance criteria:
     - Each rubric matches TDD exactly: category IDs, weights, min thresholds, calibration text
     - All rubrics pass `validateRubric()`
     - PRD rubric has 7 categories summing to 100%
     - TDD rubric has 7 categories summing to 100%
     - Plan rubric has 6 categories summing to 100%
     - Spec rubric has 6 categories summing to 100%
     - Code rubric has 7 categories summing to 100%
   - Estimated effort: 4 hours

4. **Define section-to-category mappings** -- Encode the mapping tables from TDD section 3.3.1 for each document type.
   - Files to create/modify:
     - `src/review-gate/section-mappings.ts`
   - Acceptance criteria:
     - PRD section mapping matches TDD table (7 sections mapped to categories)
     - When a category spans multiple sections, the minimum score rule is documented and enforced
     - Fallback to document-level scoring when document is under 500 words or no mapping exists
   - Estimated effort: 2 hours

5. **Implement ScoreAggregator** -- Build score calculation for single-reviewer and multi-reviewer scenarios with mean/median/min aggregation.
   - Files to create/modify:
     - `src/review-gate/score-aggregator.ts`
   - Acceptance criteria:
     - Single-reviewer weighted score matches TDD worked example (section 3.3.3): weights * scores = 80.95
     - Two-reviewer mean aggregation matches TDD worked example: (87.50 + 81.65) / 2 = 84.575, rounded to 84.58
     - Median aggregation works correctly for odd and even reviewer counts
     - Min aggregation returns the lowest reviewer's weighted score
     - Per-section scoring: when a category spans multiple sections, category score = minimum of section scores
     - Handles edge cases: single reviewer, all identical scores, extreme variance
   - Estimated effort: 4 hours

6. **Implement approval decision logic** -- Build the three-part approval check: aggregate threshold, critical findings, per-category floors.
   - Files to create/modify:
     - `src/review-gate/approval-evaluator.ts`
   - Acceptance criteria:
     - Document approved only when ALL three conditions pass (TDD 3.4.2)
     - `critical:blocking` findings cause auto-fail with `changes_requested`
     - `critical:reject` findings cause immediate `rejected` outcome
     - Per-category floor violations generate mandatory `major` findings even if not flagged by reviewer
     - Threshold is inclusive (score == threshold passes)
     - Score aggregation producing NaN/Infinity defaults to `changes_requested` with error log
   - Estimated effort: 3 hours

7. **Implement PreReviewValidator** -- Build structural validation that runs before any reviewer is invoked.
   - Files to create/modify:
     - `src/review-gate/pre-review-validator.ts`
   - Acceptance criteria:
     - Validates all required sections are present for the given document type
     - Validates frontmatter schema (required fields present, correct types)
     - Validates `traces_from` references resolve to existing documents
     - Edge case: document with 0 required sections (all optional) skips validation
     - Returns structured validation errors, not just pass/fail
   - Estimated effort: 3 hours

8. **Unit tests for scoring and validation** -- Comprehensive test coverage for the scoring pipeline and validator.
   - Files to create/modify:
     - `tests/review-gate/score-aggregator.test.ts`
     - `tests/review-gate/approval-evaluator.test.ts`
     - `tests/review-gate/rubric-registry.test.ts`
     - `tests/review-gate/pre-review-validator.test.ts`
   - Acceptance criteria:
     - ScoreAggregator: tests for mean/median/min, single and multi-reviewer, TDD worked examples reproduced
     - ApprovalEvaluator: tests for threshold pass/fail, critical finding auto-fail, floor violations, NaN handling
     - RubricRegistry: tests for valid/invalid rubrics, weight sum validation, retrieval by type
     - PreReviewValidator: tests for missing sections, invalid frontmatter, unresolvable traces
     - Edge cases: 0-weight categories, scores at exact boundaries, empty reviewer arrays
   - Estimated effort: 5 hours

## Dependencies & Integration Points

- **Downstream**: PLAN-004-2 (reviewer agents) depends on `Rubric`, `ReviewOutput`, and `Finding` types. PLAN-004-3 (iteration loop) depends on `GateReviewResult`, `ApprovalEvaluator`, and `ScoreAggregator`. PLAN-004-4 (metrics) depends on `ReviewGateRecord`.
- **External**: `traces_from` validation in PreReviewValidator needs access to the document store (interface defined here, implementation may depend on the versioning system from a separate TDD).

## Testing Strategy

- **Unit tests**: Every scoring function tested with the exact worked examples from TDD section 3.3.3. Boundary conditions for thresholds (exactly at threshold, one point below, one point above). Invalid rubric configurations rejected.
- **Property-based tests**: Score aggregation always produces results in 0--100 range. Weighted scores equal manual calculation for random inputs. Approval evaluator is deterministic for identical inputs.
- **Regression tests**: TDD worked examples encoded as fixtures that must always pass.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Floating-point precision in weight sums causes false validation failures | Medium | Low | Use tolerance of +/- 0.01 as specified in TDD. Test with known edge cases. |
| Section-to-category mapping incomplete for new document types | Low | Medium | Design mapping system to be extensible. Fallback to document-level scoring for unmapped types. |
| Per-section minimum scoring rule (TDD 3.3.1) is too strict in practice | Medium | Medium | Make the aggregation strategy for multi-section categories configurable (min is default, mean available). |

## Definition of Done

- [ ] All TypeScript interfaces from TDD sections 3.2, 3.6.3, 3.7.1, 4.1, 4.2 are implemented
- [ ] RubricRegistry loads, validates, and serves rubrics for all 5 document types
- [ ] All 5 hardcoded rubrics match TDD definitions exactly
- [ ] ScoreAggregator produces correct results for TDD worked examples
- [ ] Approval evaluator enforces all three approval conditions
- [ ] PreReviewValidator catches missing sections, invalid frontmatter, broken traces
- [ ] Unit tests pass with >90% line coverage on all scoring and validation modules
- [ ] No lint errors, no type errors
