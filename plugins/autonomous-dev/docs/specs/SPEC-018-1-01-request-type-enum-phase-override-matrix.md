# SPEC-018-1-01: RequestType Enum + PhaseOverrideMatrix + Helper Functions

## Metadata
- **Parent Plan**: PLAN-018-1-request-type-enum-state-schema
- **Tasks Covered**: Task 1 (RequestType enum and helpers), Task 2 (PhaseOverrideConfig + PHASE_OVERRIDE_MATRIX + helpers)
- **Estimated effort**: 3.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-1-01-request-type-enum-phase-override-matrix.md`

## Description
Author the foundational TypeScript types that classify requests and select per-type pipeline behavior. This spec produces two source files: the `RequestType` enum (with type guard and default constant) and the `PhaseOverrideConfig` interface plus the `PHASE_OVERRIDE_MATRIX` constant and three helper functions (`getPhaseSequence`, `isEnhancedPhase`, `getAdditionalGates`). The matrix must match TDD-018 §5.2 verbatim — every cell, every value, every comment-worthy default.

These types are pure data with no I/O, no side effects, and no external dependencies beyond a `PipelinePhase` string union (declared inline if not already present). Subsequent specs (SPEC-018-1-02, SPEC-018-1-04) consume these exports; the daemon (PLAN-018-2) and CLI (PLAN-018-3) consume them downstream. Because this matrix is the canonical contract for pipeline variation, drift detection is built in via a snapshot test.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/types/request-type.ts` | Create | Enum, `isValidRequestType`, `DEFAULT_REQUEST_TYPE` |
| `plugins/autonomous-dev/src/types/phase-override.ts` | Create | `PipelinePhase`, `PhaseOverrideConfig`, `PHASE_OVERRIDE_MATRIX`, three helpers |

## Implementation Details

### `src/types/request-type.ts`

```typescript
/**
 * Supported request types with distinct pipeline optimizations.
 * Canonical source: TDD-018 §5.1.
 */
export enum RequestType {
  /** Standard product feature development (default) */
  FEATURE = 'feature',
  /** Bug fix with structured problem context */
  BUG = 'bug',
  /** Infrastructure changes with enhanced gates */
  INFRA = 'infra',
  /** Code quality improvements */
  REFACTOR = 'refactor',
  /** Critical issue hotfix with expedited processing */
  HOTFIX = 'hotfix',
}

/** Type guard for RequestType validation. */
export function isValidRequestType(value: string): value is RequestType {
  return Object.values(RequestType).includes(value as RequestType);
}

/** Default request type for backward compatibility (v1.0 → v1.1 migration). */
export const DEFAULT_REQUEST_TYPE: RequestType = RequestType.FEATURE;
```

### `src/types/phase-override.ts`

```typescript
import { RequestType } from './request-type';

/**
 * Ordered identifiers for the canonical autonomous-dev pipeline phases.
 * The full feature pipeline runs all 14 in this order.
 */
export type PipelinePhase =
  | 'intake'
  | 'prd' | 'prd_review'
  | 'tdd' | 'tdd_review'
  | 'plan' | 'plan_review'
  | 'spec' | 'spec_review'
  | 'code' | 'code_review'
  | 'integration' | 'deploy' | 'monitor';

export const ALL_PIPELINE_PHASES: readonly PipelinePhase[] = [
  'intake', 'prd', 'prd_review', 'tdd', 'tdd_review',
  'plan', 'plan_review', 'spec', 'spec_review',
  'code', 'code_review', 'integration', 'deploy', 'monitor',
] as const;

/** Per-type pipeline customization. Canonical source: TDD-018 §5.2. */
export interface PhaseOverrideConfig {
  skippedPhases: PipelinePhase[];
  enhancedPhases: PipelinePhase[];
  expeditedReviews: boolean;
  additionalGates: string[];
  maxRetries: number;
  phaseTimeouts: Record<string, number>;
}

/** PHASE_OVERRIDE_MATRIX — must match TDD-018 §5.2 byte-for-byte. */
export const PHASE_OVERRIDE_MATRIX: Record<RequestType, PhaseOverrideConfig> = {
  [RequestType.FEATURE]: {
    skippedPhases: [],
    enhancedPhases: [],
    expeditedReviews: false,
    additionalGates: [],
    maxRetries: 3,
    phaseTimeouts: {},
  },
  [RequestType.BUG]: {
    skippedPhases: ['prd', 'prd_review'],
    enhancedPhases: ['code', 'code_review'],
    expeditedReviews: true,
    additionalGates: ['regression_test_validation'],
    maxRetries: 5,
    phaseTimeouts: { tdd: 30, code: 60 },
  },
  [RequestType.INFRA]: {
    skippedPhases: [],
    enhancedPhases: ['tdd', 'tdd_review', 'plan', 'plan_review'],
    expeditedReviews: false,
    additionalGates: ['security_review', 'cost_analysis', 'rollback_plan'],
    maxRetries: 2,
    phaseTimeouts: { tdd: 120, plan: 90 },
  },
  [RequestType.REFACTOR]: {
    skippedPhases: ['prd', 'prd_review'],
    enhancedPhases: ['code', 'code_review'],
    expeditedReviews: true,
    additionalGates: ['code_quality_metrics', 'performance_benchmarks'],
    maxRetries: 3,
    phaseTimeouts: { code: 90 },
  },
  [RequestType.HOTFIX]: {
    skippedPhases: ['prd', 'prd_review', 'plan_review'],
    enhancedPhases: ['tdd', 'code'],
    expeditedReviews: true,
    additionalGates: ['incident_correlation', 'rollback_validation'],
    maxRetries: 5,
    phaseTimeouts: { tdd: 15, code: 30, deploy: 10 },
  },
};

/** Resolves the ordered phase list for a given request type. */
export function getPhaseSequence(requestType: RequestType): PipelinePhase[] {
  const skipped = new Set(PHASE_OVERRIDE_MATRIX[requestType].skippedPhases);
  return ALL_PIPELINE_PHASES.filter((p) => !skipped.has(p));
}

/** Whether a phase has enhanced validation gates for the given request type. */
export function isEnhancedPhase(requestType: RequestType, phase: PipelinePhase): boolean {
  return PHASE_OVERRIDE_MATRIX[requestType].enhancedPhases.includes(phase);
}

/** Additional gates required for a request type (e.g., security_review). */
export function getAdditionalGates(requestType: RequestType): string[] {
  return [...PHASE_OVERRIDE_MATRIX[requestType].additionalGates];
}
```

### Constraints

- Both files compile cleanly under `tsc --strict --noImplicitAny --noUncheckedIndexedAccess`.
- `getAdditionalGates` returns a defensive copy so callers cannot mutate the matrix.
- `getPhaseSequence` preserves canonical ordering from `ALL_PIPELINE_PHASES`.
- File-level JSDoc on both files cross-references TDD-018 §5.1 / §5.2 to deter divergence.

## Acceptance Criteria

- [ ] `RequestType` enum has exactly five members: `FEATURE`, `BUG`, `INFRA`, `REFACTOR`, `HOTFIX`, with string values matching the lowercase member name.
- [ ] `isValidRequestType('feature')`, `isValidRequestType('bug')`, `isValidRequestType('infra')`, `isValidRequestType('refactor')`, `isValidRequestType('hotfix')` all return `true`.
- [ ] `isValidRequestType('xyz')`, `isValidRequestType('')`, `isValidRequestType('FEATURE')` all return `false`.
- [ ] `DEFAULT_REQUEST_TYPE === RequestType.FEATURE`.
- [ ] `PHASE_OVERRIDE_MATRIX` has entries for all five `RequestType` values; no extra keys.
- [ ] `getPhaseSequence(RequestType.FEATURE)` returns all 14 phases in canonical order.
- [ ] `getPhaseSequence(RequestType.BUG)` returns 12 phases excluding `prd` and `prd_review`.
- [ ] `getPhaseSequence(RequestType.HOTFIX)` returns 11 phases excluding `prd`, `prd_review`, `plan_review`.
- [ ] `getPhaseSequence(RequestType.INFRA)` returns all 14 phases (INFRA skips none).
- [ ] `isEnhancedPhase(RequestType.INFRA, 'tdd')` returns `true`; `isEnhancedPhase(RequestType.FEATURE, 'tdd')` returns `false`.
- [ ] `getAdditionalGates(RequestType.INFRA)` returns `['security_review', 'cost_analysis', 'rollback_plan']` and is not `===` to the matrix slot (defensive copy).
- [ ] `getAdditionalGates(RequestType.FEATURE)` returns `[]`.
- [ ] `tsc --strict` produces zero errors for both files.
- [ ] Snapshot test (created in SPEC-018-1-04) of `PHASE_OVERRIDE_MATRIX` matches the literal in TDD-018 §5.2.

## Dependencies

- No runtime dependencies introduced.
- `PipelinePhase` declared in `phase-override.ts`; if a prior `PipelinePhase` already exists elsewhere in the codebase, replace this declaration with an import from that location and note the path in code review.

## Notes

- The matrix is the canonical contract for pipeline variation. Any change to it requires updating both TDD-018 §5.2 and the snapshot fixture in lockstep.
- `getPhaseSequence` deliberately re-derives order from `ALL_PIPELINE_PHASES` (rather than from `Object.keys`) to guarantee deterministic ordering across V8 versions.
- `phaseTimeouts` is `Record<string, number>` (not `Record<PipelinePhase, number>`) per TDD-018 §5.2 to allow non-phase keys like `'deploy'` that may not be in the canonical phase enum in future revisions.
- Unit tests for these files live in SPEC-018-1-04. This spec produces source only.
