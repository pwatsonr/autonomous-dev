# SPEC-003-1-01: Document Type Enum, Registry, and Rubric Interfaces

## Metadata
- **Parent Plan**: PLAN-003-1
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 8 hours

## Description
Implement the foundational type system for the document pipeline: the `DocumentType` enum with pipeline ordering, the `DocumentTypeDefinition` interface and its five-entry registry, and the `RubricCategory`/`QualityRubric` interfaces. These are the root types that every other subsystem imports.

## Files to Create/Modify

| File | Action |
|------|--------|
| `src/pipeline/types/document-type.ts` | Create |
| `src/pipeline/types/document-type-definition.ts` | Create |
| `src/pipeline/registry/document-type-registry.ts` | Create |
| `src/pipeline/types/quality-rubric.ts` | Create |
| `src/pipeline/types/index.ts` | Create (barrel export) |

## Implementation Details

### Task 1: `src/pipeline/types/document-type.ts`

```typescript
/**
 * The five document types in the pipeline, ordered by depth.
 * Depth 0 = PRD (root), Depth 4 = CODE (leaf).
 */
export enum DocumentType {
  PRD = 'PRD',
  TDD = 'TDD',
  PLAN = 'PLAN',
  SPEC = 'SPEC',
  CODE = 'CODE',
}

/**
 * Pipeline ordering array. Index = depth.
 * PIPELINE_ORDER[0] = PRD, PIPELINE_ORDER[4] = CODE.
 */
export const PIPELINE_ORDER: readonly DocumentType[] = [
  DocumentType.PRD,
  DocumentType.TDD,
  DocumentType.PLAN,
  DocumentType.SPEC,
  DocumentType.CODE,
] as const;

/**
 * Returns the depth (0-based) for a given document type.
 * @throws Error if type is not in PIPELINE_ORDER.
 */
export function getDepth(type: DocumentType): number {
  const idx = PIPELINE_ORDER.indexOf(type);
  if (idx === -1) throw new Error(`Unknown document type: ${type}`);
  return idx;
}

/**
 * Returns the child type for a given document type, or null for CODE.
 */
export function getChildType(type: DocumentType): DocumentType | null {
  const depth = getDepth(type);
  return depth < PIPELINE_ORDER.length - 1 ? PIPELINE_ORDER[depth + 1] : null;
}

/**
 * Returns the parent type for a given document type, or null for PRD.
 */
export function getParentType(type: DocumentType): DocumentType | null {
  const depth = getDepth(type);
  return depth > 0 ? PIPELINE_ORDER[depth - 1] : null;
}
```

### Task 2: `src/pipeline/types/document-type-definition.ts`

```typescript
import { DocumentType } from './document-type';
import { QualityRubric } from './quality-rubric';

export type DecompositionStrategy = 'domain' | 'phase' | 'task' | 'direct';

export interface ReviewGateDefaults {
  panelSize: number;
  maxIterations: number;
  approvalThreshold: number;
  regressionMargin: number;
}

export interface DocumentTypeDefinition {
  /** The document type enum value */
  type: DocumentType;
  /** Human-readable label */
  label: string;
  /** Depth in the pipeline (0 = PRD, 4 = CODE) */
  depth: number;
  /** The type of children produced by decomposition, null for CODE */
  childType: DocumentType | null;
  /** The type of the parent, null for PRD */
  parentType: DocumentType | null;
  /** Template ID for rendering blank documents */
  templateId: string;
  /** Quality rubric for review scoring */
  rubric: QualityRubric;
  /** Default review gate configuration */
  reviewConfig: ReviewGateDefaults;
  /** Strategy used when decomposing this type into children */
  decompositionStrategy: DecompositionStrategy | null;
}
```

### Task 2 continued: `src/pipeline/registry/document-type-registry.ts`

```typescript
import { DocumentType } from '../types/document-type';
import { DocumentTypeDefinition } from '../types/document-type-definition';
// Rubrics imported from per-type rubric files (SPEC-003-1-02)

export class DocumentTypeRegistry {
  private definitions: Map<DocumentType, DocumentTypeDefinition>;

  constructor() {
    this.definitions = new Map();
    this.registerAll();
  }

  /**
   * Returns the definition for the given document type.
   * @throws Error if type is not registered.
   */
  getDefinition(type: DocumentType): DocumentTypeDefinition { ... }

  /**
   * Returns all five registered definitions.
   */
  getAllDefinitions(): DocumentTypeDefinition[] { ... }

  /**
   * Internal: registers all five document type definitions.
   * Called by constructor.
   */
  private registerAll(): void {
    // PRD: depth 0, childType TDD, parentType null, decomposition 'domain'
    // TDD: depth 1, childType PLAN, parentType PRD, decomposition 'phase'
    // PLAN: depth 2, childType SPEC, parentType TDD, decomposition 'task'
    // SPEC: depth 3, childType CODE, parentType PLAN, decomposition 'direct'
    // CODE: depth 4, childType null, parentType SPEC, decomposition null
  }
}

/** Singleton instance for global access */
export const documentTypeRegistry = new DocumentTypeRegistry();
```

Review gate defaults per type (from TDD Section 3.1.3):
- PRD: `{ panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }`
- TDD: `{ panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }`
- PLAN: `{ panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }`
- SPEC: `{ panelSize: 1, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }`
- CODE: `{ panelSize: 2, maxIterations: 3, approvalThreshold: 85, regressionMargin: 5 }`

### Task 3: `src/pipeline/types/quality-rubric.ts`

```typescript
export type AggregationMethod = 'mean' | 'median' | 'min';

export interface RubricCategory {
  /** Unique category identifier, e.g. 'completeness' */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this category measures */
  description: string;
  /** Weight in the aggregate score. All weights in a rubric must sum to 1.0 */
  weight: number;
  /** Minimum acceptable score for this category (0-100) */
  minimumScore: number;
  /** Scoring guide: maps score ranges to descriptions */
  scoringGuide: ScoringGuideEntry[];
}

export interface ScoringGuideEntry {
  /** Inclusive lower bound of the score range */
  min: number;
  /** Inclusive upper bound of the score range */
  max: number;
  /** Description of what this score range means */
  description: string;
}

export interface QualityRubric {
  /** Document type this rubric applies to */
  documentType: string;
  /** Version of the rubric for evolution tracking */
  version: string;
  /** All scoring categories */
  categories: RubricCategory[];
  /** How to aggregate category scores into a single score */
  aggregationMethod: AggregationMethod;
}
```

### Barrel export: `src/pipeline/types/index.ts`

```typescript
export * from './document-type';
export * from './document-type-definition';
export * from './quality-rubric';
```

## Acceptance Criteria
1. `DocumentType` enum has exactly 5 values: PRD, TDD, PLAN, SPEC, CODE.
2. `PIPELINE_ORDER` array maps index 0-4 to the types in depth order.
3. `getDepth()`, `getChildType()`, `getParentType()` return correct values for all 5 types.
4. `DocumentTypeRegistry` stores 5 definitions accessible via `getDefinition(type)` and `getAllDefinitions()`.
5. Each definition has correct `depth`, `childType`, `parentType`, and `decompositionStrategy`.
6. CODE has `childType: null` and `decompositionStrategy: null`; PRD has `parentType: null`.
7. `QualityRubric` supports `mean`, `median`, and `min` aggregation methods.
8. All rubric weights within a rubric sum to exactly 1.0 (validated by test).

## Test Cases

### Unit Tests: `tests/pipeline/types/document-type.test.ts`
- `DocumentType enum has exactly 5 values`
- `PIPELINE_ORDER has length 5 and correct order`
- `getDepth returns 0 for PRD, 4 for CODE`
- `getChildType returns TDD for PRD, null for CODE`
- `getParentType returns null for PRD, SPEC for CODE`
- `getDepth throws for unknown type`

### Unit Tests: `tests/pipeline/registry/document-type-registry.test.ts`
- `getDefinition returns correct definition for each type`
- `getDefinition throws for unknown type`
- `getAllDefinitions returns exactly 5 definitions`
- `PRD definition: depth=0, childType=TDD, parentType=null, decomposition=domain`
- `CODE definition: depth=4, childType=null, parentType=SPEC, decomposition=null`
- `All definitions have valid reviewConfig with approvalThreshold 85`
- `PRD and TDD have panelSize 2; PLAN and SPEC have panelSize 1; CODE has panelSize 2`

### Unit Tests: `tests/pipeline/types/quality-rubric.test.ts`
- `RubricCategory interface accepts all required fields`
- `QualityRubric supports mean aggregation`
- `QualityRubric supports median aggregation`
- `QualityRubric supports min aggregation`
