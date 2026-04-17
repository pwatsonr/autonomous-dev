# SPEC-003-1-02: Per-Type Rubric Definitions and Review Gate Config

## Metadata
- **Parent Plan**: PLAN-003-1
- **Tasks Covered**: Task 4, Task 5
- **Estimated effort**: 6 hours

## Description
Define the complete quality rubrics for all five document types (PRD: 7 categories, TDD: 7, Plan: 6, Spec: 6, Code: 7) with their weights, minimum scores, scoring guides, and aggregation methods. Also define the `ReviewGateConfig` interface with per-type defaults.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/registry/rubrics/prd-rubric.ts` | Create |
| `src/pipeline/registry/rubrics/tdd-rubric.ts` | Create |
| `src/pipeline/registry/rubrics/plan-rubric.ts` | Create |
| `src/pipeline/registry/rubrics/spec-rubric.ts` | Create |
| `src/pipeline/registry/rubrics/code-rubric.ts` | Create |
| `src/pipeline/registry/rubrics/index.ts` | Create (barrel) |
| `src/pipeline/types/review-gate-config.ts` | Create |

## Implementation Details

### Task 4: Per-Type Rubric Definitions

Each rubric file exports a `QualityRubric` constant. Every file follows the same structure:

```typescript
// src/pipeline/registry/rubrics/prd-rubric.ts
import { QualityRubric } from '../../types/quality-rubric';

export const PRD_RUBRIC: QualityRubric = {
  documentType: 'PRD',
  version: '1.0',
  categories: [
    {
      id: 'completeness',
      name: 'Completeness',
      description: 'All required sections are present and substantive',
      weight: 0.20,
      minimumScore: 70,
      scoringGuide: [
        { min: 0, max: 39, description: 'Multiple required sections missing or empty' },
        { min: 40, max: 69, description: 'Some sections incomplete or superficial' },
        { min: 70, max: 89, description: 'All sections present with adequate depth' },
        { min: 90, max: 100, description: 'All sections thorough and detailed' },
      ],
    },
    // ... 6 more categories totaling weight 1.0
  ],
  aggregationMethod: 'mean',
};
```

**PRD Rubric (7 categories, TDD Section 3.3.2)**:
| Category ID | Weight | Min Score |
|-------------|--------|-----------|
| completeness | 0.20 | 70 |
| clarity | 0.15 | 70 |
| feasibility | 0.15 | 65 |
| user_value | 0.15 | 70 |
| scope_definition | 0.15 | 70 |
| acceptance_criteria | 0.10 | 75 |
| risk_assessment | 0.10 | 60 |

**TDD Rubric (7 categories, TDD Section 3.3.3)**:
| Category ID | Weight | Min Score |
|-------------|--------|-----------|
| completeness | 0.15 | 70 |
| technical_accuracy | 0.20 | 75 |
| architecture_quality | 0.20 | 70 |
| api_design | 0.15 | 70 |
| error_handling | 0.10 | 65 |
| testing_strategy | 0.10 | 70 |
| security_considerations | 0.10 | 60 |

**Plan Rubric (6 categories, TDD Section 3.3.4)**:
| Category ID | Weight | Min Score |
|-------------|--------|-----------|
| task_granularity | 0.20 | 70 |
| dependency_accuracy | 0.20 | 75 |
| effort_estimation | 0.15 | 60 |
| completeness | 0.15 | 70 |
| risk_identification | 0.15 | 60 |
| acceptance_criteria | 0.15 | 70 |

**Spec Rubric (6 categories, TDD Section 3.3.5)**:
| Category ID | Weight | Min Score |
|-------------|--------|-----------|
| precision | 0.25 | 75 |
| completeness | 0.20 | 70 |
| testability | 0.20 | 70 |
| api_contracts | 0.15 | 70 |
| error_handling | 0.10 | 65 |
| implementation_guidance | 0.10 | 60 |

**Code Rubric (7 categories, TDD Section 3.3.6)**:
| Category ID | Weight | Min Score |
|-------------|--------|-----------|
| correctness | 0.20 | 80 |
| test_coverage | 0.15 | 75 |
| code_quality | 0.15 | 70 |
| spec_conformance | 0.15 | 75 |
| error_handling | 0.10 | 70 |
| documentation | 0.10 | 60 |
| performance | 0.15 | 60 |

**Validation invariant**: For every rubric, `categories.reduce((sum, c) => sum + c.weight, 0)` must equal `1.0` (within floating-point tolerance of 0.001).

### Barrel export: `src/pipeline/registry/rubrics/index.ts`

```typescript
export { PRD_RUBRIC } from './prd-rubric';
export { TDD_RUBRIC } from './tdd-rubric';
export { PLAN_RUBRIC } from './plan-rubric';
export { SPEC_RUBRIC } from './spec-rubric';
export { CODE_RUBRIC } from './code-rubric';
```

### Task 5: `src/pipeline/types/review-gate-config.ts`

```typescript
import { DocumentType } from './document-type';

export interface ReviewGateConfig {
  /** Number of reviewer agents on the panel */
  panelSize: number;
  /** Maximum review-revision iterations before escalation */
  maxIterations: number;
  /** Minimum aggregate score to pass the gate (0-100) */
  approvalThreshold: number;
  /** Score delta below which quality regression is flagged */
  regressionMargin: number;
}

/**
 * Default review gate configuration per document type.
 * Values from TDD Section 3.1.3.
 */
export const DEFAULT_REVIEW_GATE_CONFIGS: Record<DocumentType, ReviewGateConfig> = {
  [DocumentType.PRD]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.TDD]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.PLAN]: { panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.SPEC]: { panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
  [DocumentType.CODE]: { panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 },
};
```

## Acceptance Criteria
1. Each rubric file exports a `QualityRubric` constant with the correct category count (PRD:7, TDD:7, Plan:6, Spec:6, Code:7).
2. All category weights within each rubric sum to exactly 1.0 (tolerance 0.001).
3. Every category has an `id`, `name`, `description`, `weight`, `minimumScore`, and non-empty `scoringGuide`.
4. Scoring guide entries cover the full 0-100 range without gaps or overlaps.
5. `DEFAULT_REVIEW_GATE_CONFIGS` has entries for all 5 document types.
6. PRD/TDD/CODE have `panelSize: 2`; PLAN/SPEC have `panelSize: 1`.
7. All types have `maxIterations: 3`, `approvalThreshold: 85`, `regressionMargin: 5`.

## Test Cases

### Unit Tests: `tests/pipeline/registry/rubrics/rubric-validation.test.ts`
- `PRD rubric has 7 categories`
- `TDD rubric has 7 categories`
- `Plan rubric has 6 categories`
- `Spec rubric has 6 categories`
- `Code rubric has 7 categories`
- `PRD rubric weights sum to 1.0`
- `TDD rubric weights sum to 1.0`
- `Plan rubric weights sum to 1.0`
- `Spec rubric weights sum to 1.0`
- `Code rubric weights sum to 1.0`
- `All rubric categories have non-empty scoring guides`
- `All scoring guides cover the full 0-100 range`
- `All minimumScore values are between 0 and 100`
- `PRD rubric uses mean aggregation`

### Unit Tests: `tests/pipeline/types/review-gate-config.test.ts`
- `DEFAULT_REVIEW_GATE_CONFIGS has entries for all 5 types`
- `PRD panelSize is 2`
- `PLAN panelSize is 1`
- `All types have approvalThreshold 85`
- `All types have maxIterations 3`
- `All types have regressionMargin 5`

### Self-consistency validation test
```typescript
// Runs at test time to catch rubric editing errors:
for (const rubric of [PRD_RUBRIC, TDD_RUBRIC, PLAN_RUBRIC, SPEC_RUBRIC, CODE_RUBRIC]) {
  const sum = rubric.categories.reduce((s, c) => s + c.weight, 0);
  expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
  const ids = rubric.categories.map(c => c.id);
  expect(new Set(ids).size).toBe(ids.length); // no duplicate IDs
}
```
