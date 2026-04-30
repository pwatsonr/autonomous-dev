# SPEC-018-1-02: RequestStateV1_1 Interface + Migration Function + isLegacyState

## Metadata
- **Parent Plan**: PLAN-018-1-request-type-enum-state-schema
- **Tasks Covered**: Task 3 (extend RequestState to v1.1), Task 4 (migration function and predicate)
- **Estimated effort**: 3.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-018-1-02-request-state-v1-1-interface-migration.md`

## Description
Extend the persisted state contract to schema version 1.1. This spec defines `RequestStateV1_1` (a discriminated extension of the existing `RequestStateV1_0`), publishes a `RequestState` union alias for callers that handle either version, and adds two pure functions to `request-state.ts`: `migrateStateV1_0ToV1_1()` (lossless upgrade defaulting to `feature` type) and `isLegacyState()` (predicate detecting v1.0 shapes). All inputs and outputs are in-memory objects — no I/O, no filesystem, no async work. Atomic disk writes during loader auto-migration are SPEC-018-1-04's concern.

The migration must be lossless: every field on the input v1.0 object survives onto the output v1.1 object via spread. Unknown extra fields are preserved. New v1.1-only fields (`schema_version`, `request_type`, `phase_overrides`, `type_config`) are populated from the matrix; `bug_context` is left `undefined` because migrated requests have no recorded bug shape.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/types/request-state.ts` | Modify or create | Adds v1.1 interface, union alias, migration, predicate; preserves existing v1.0 |

## Implementation Details

### Existing v1.0 Interface (Assumed Present)

If `RequestStateV1_0` already exists from PLAN-002-1, leave it untouched. If absent, declare a minimal stub here and flag it in the PR description for the orchestrator. The migration logic does not depend on knowing every v1.0 field — it spreads the entire input object.

### `src/types/request-state.ts` (additions)

```typescript
import type { BugReport } from './bug-report'; // declared in PLAN-018-3; type-only import is safe
import {
  RequestType,
  DEFAULT_REQUEST_TYPE,
} from './request-type';
import {
  PHASE_OVERRIDE_MATRIX,
  PhaseOverrideConfig,
  getPhaseSequence,
} from './phase-override';

/**
 * State schema v1.1 — adds request typing and computed pipeline metadata.
 * Canonical source: TDD-018 §7.1.
 */
export interface RequestStateV1_1 extends Omit<RequestStateV1_0, 'schema_version'> {
  schema_version: 1.1;
  /** Request type classification. Optional on disk for forward-compat; defaults to feature when migrating. */
  request_type?: RequestType;
  /** Structured bug context. Present only when request_type === 'bug'. */
  bug_context?: BugReport;
  /** Computed phase sequence based on request type. */
  phase_overrides: string[];
  /** Type-specific configuration applied to this request. */
  type_config: PhaseOverrideConfig;
}

/** Discriminated union for callers that handle either schema version. */
export type RequestState = RequestStateV1_0 | RequestStateV1_1;

/**
 * Lossless migration from v1.0 to v1.1. Defaults request_type to 'feature'
 * (DEFAULT_REQUEST_TYPE). Spreads input first so all original fields survive,
 * including any unknown additional fields.
 */
export function migrateStateV1_0ToV1_1(state: RequestStateV1_0): RequestStateV1_1 {
  const requestType = DEFAULT_REQUEST_TYPE;
  return {
    ...state,
    schema_version: 1.1,
    request_type: requestType,
    bug_context: undefined,
    phase_overrides: getPhaseSequence(requestType),
    type_config: PHASE_OVERRIDE_MATRIX[requestType],
  };
}

/**
 * Predicate: returns true if the input is a v1.0 state.
 * A state is v1.0 iff schema_version === 1.0 AND it has no own 'request_type' property.
 * (The own-property check guards against forward-compat shims that backport request_type onto v1.0.)
 */
export function isLegacyState(state: unknown): state is RequestStateV1_0 {
  if (state === null || typeof state !== 'object') return false;
  const s = state as Record<string, unknown>;
  return s.schema_version === 1.0 && !Object.prototype.hasOwnProperty.call(s, 'request_type');
}

/**
 * Convenience: assert and migrate if needed. Returns a guaranteed v1.1 object.
 * Throws if the input is not a recognized state shape.
 */
export function requireV1_1(state: RequestState): RequestStateV1_1 {
  if (state.schema_version === 1.1) return state as RequestStateV1_1;
  if (state.schema_version === 1.0) return migrateStateV1_0ToV1_1(state as RequestStateV1_0);
  throw new Error(
    `Unrecognized state schema_version: ${(state as { schema_version: unknown }).schema_version}`,
  );
}
```

### Constraints

- The `RequestState` union narrows correctly via `state.schema_version === 1.0` / `=== 1.1` in switch statements (verified by a TypeScript type-narrowing test in SPEC-018-1-04).
- `migrateStateV1_0ToV1_1` performs no validation of the input — it trusts the caller (the JSON-schema validator at the loader boundary in SPEC-018-1-04 handles invalid inputs).
- `isLegacyState` is intentionally permissive on `unknown` so it can be the first guard a caller uses on a freshly-parsed JSON blob.
- `BugReport` is a type-only import; this file remains compilable even if `bug-report.ts` does not yet exist (PLAN-018-3 supplies it). If TypeScript flags the missing module, declare a stub `export interface BugReport { [k: string]: unknown }` in this file with a TODO referencing PLAN-018-3.

## Acceptance Criteria

- [ ] `tsc --strict` compiles `request-state.ts` cleanly.
- [ ] `RequestStateV1_1` has `schema_version: 1.1` (literal type), required `phase_overrides: string[]`, required `type_config: PhaseOverrideConfig`, optional `request_type?: RequestType`, optional `bug_context?: BugReport`.
- [ ] A switch on `state.schema_version` narrows `state` to `RequestStateV1_0` in the `case 1.0:` branch and to `RequestStateV1_1` in the `case 1.1:` branch (compile-time check).
- [ ] `migrateStateV1_0ToV1_1` preserves all input fields: given `{ schema_version: 1.0, id: 'X', custom_field: 42 } as RequestStateV1_0`, the output contains `id: 'X'` and `custom_field: 42`.
- [ ] After migration: `result.schema_version === 1.1`, `result.request_type === 'feature'`, `result.bug_context === undefined`, `result.phase_overrides.length === 14`, `result.type_config === PHASE_OVERRIDE_MATRIX[RequestType.FEATURE]` (referential equality is acceptable; if the matrix is frozen the reference is shared).
- [ ] `isLegacyState({ schema_version: 1.0 })` returns `true`.
- [ ] `isLegacyState({ schema_version: 1.1 })` returns `false`.
- [ ] `isLegacyState({ schema_version: 1.0, request_type: 'feature' })` returns `false` (own-property guard).
- [ ] `isLegacyState(null)`, `isLegacyState(undefined)`, `isLegacyState('string')`, `isLegacyState(42)` all return `false`.
- [ ] `requireV1_1` returns the input unchanged when given a v1.1 state; migrates when given a v1.0 state; throws on `schema_version: 2.0` or other unknowns.
- [ ] All unit tests in SPEC-018-1-04 pass against this file.

## Dependencies

- SPEC-018-1-01 (`RequestType`, `DEFAULT_REQUEST_TYPE`, `PHASE_OVERRIDE_MATRIX`, `getPhaseSequence`).
- Existing `RequestStateV1_0` from PLAN-002-1. If absent, see Notes.
- `BugReport` from PLAN-018-3 — type-only; stub if missing.

## Notes

- The `Omit<RequestStateV1_0, 'schema_version'> & { schema_version: 1.1; ... }` pattern is required because the literal types `1.0` and `1.1` are not assignable to each other; you cannot simply extend without overriding the discriminant.
- The migration is intentionally idempotent at the source level: calling it on an already-v1.1 input is a programming error and TypeScript will reject it. Idempotency at the *file* level is handled by the loader (SPEC-018-1-04) and migration script (SPEC-018-1-03).
- `requireV1_1` is the recommended call site for the daemon and any downstream consumer that wants to ignore the version distinction.
- If `RequestStateV1_0` is absent in the codebase, declare a minimal placeholder:
  ```typescript
  export interface RequestStateV1_0 {
    schema_version: 1.0;
    id: string;
    [k: string]: unknown;
  }
  ```
  and document the gap in the PR.
