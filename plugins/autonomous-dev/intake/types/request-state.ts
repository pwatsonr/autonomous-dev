/**
 * RequestState v1.0 / v1.1 contracts + migration (SPEC-018-1-02, Tasks 3 & 4).
 *
 * Defines the persisted-state shape for an autonomous-dev request, the
 * lossless migration from v1.0 to v1.1, and the type predicate used by the
 * loader to decide whether migration is required.
 *
 * v1.1 adds:
 *   - request_type: RequestType (defaults to 'feature' on migration)
 *   - bug_context:  optional structured BugReport (populated by PLAN-018-3)
 *   - phase_overrides: computed phase sequence (string[])
 *   - type_config:  full PhaseOverrideConfig snapshot
 *
 * Note on existing types: `intake/state/state_validator.ts` defines
 * `StateJsonV10` / `StateJsonV11` for source-tracking (the v1.1 there adds
 * `source` + `adapter_metadata`, NOT a numeric `schema_version`). Those
 * shapes are independent of this file's `RequestStateV1_0` /
 * `RequestStateV1_1`, which carry the numeric `schema_version` discriminant
 * that PLAN-018-1 introduces. Both can coexist on the same on-disk JSON
 * without conflict — the source-tracking fields appear at the top level
 * via the open `[k: string]: unknown` index signature on v1.0 / v1.1.
 *
 * `BugReport` is a stub here (PLAN-018-3 supplies the full sub-schema).
 *
 * @module intake/types/request-state
 */

import {
  DEFAULT_REQUEST_TYPE,
  RequestType,
} from './request-type';
import {
  PHASE_OVERRIDE_MATRIX,
  type PhaseOverrideConfig,
  getPhaseSequence,
} from './phase-override';

// ---------------------------------------------------------------------------
// BugReport stub (filled in by PLAN-018-3)
// ---------------------------------------------------------------------------

/**
 * Stub BugReport. PLAN-018-3 supplies the full sub-schema; until then
 * `bug_context` is loosely typed so the migration code compiles without
 * a hard dependency on a not-yet-landed module.
 *
 * TODO(PLAN-018-3): Replace with the canonical BugReport interface from
 * `intake/types/bug-report.ts` once that module exists.
 */
export interface BugReport {
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// v1.0 (legacy) shape
// ---------------------------------------------------------------------------

/**
 * v1.0 RequestState (legacy). Intentionally open: PLAN-002-1 did not lock a
 * full schema, so we model only the fields the migrator and loader need to
 * reason about (`schema_version`, `id`) and pass the rest through unchanged.
 *
 * Implementation note: this is a compatible local declaration. If/when an
 * authoritative `RequestStateV1_0` is published elsewhere in the codebase,
 * replace this with a re-export and document the change in the PR.
 */
export interface RequestStateV1_0 {
  schema_version: 1.0;
  id: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// v1.1 shape
// ---------------------------------------------------------------------------

/**
 * v1.1 RequestState — adds request typing and computed pipeline metadata.
 *
 * Uses `Omit<RequestStateV1_0, 'schema_version'>` because the literal types
 * `1.0` and `1.1` are not assignable to each other; we cannot extend
 * RequestStateV1_0 without overriding the discriminant.
 *
 * Canonical source: TDD-018 §7.1.
 */
export interface RequestStateV1_1
  extends Omit<RequestStateV1_0, 'schema_version'> {
  schema_version: 1.1;
  /**
   * Request type classification. Optional on disk for forward-compat;
   * defaults to {@link DEFAULT_REQUEST_TYPE} when migrating from v1.0.
   */
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

// ---------------------------------------------------------------------------
// Migration + predicates
// ---------------------------------------------------------------------------

/**
 * Lossless migration from v1.0 to v1.1.
 *
 * Defaults `request_type` to {@link DEFAULT_REQUEST_TYPE} (FEATURE).
 * Spreads input first so all original fields survive, including any unknown
 * additional fields. `bug_context` is set to `undefined` (own property) so
 * downstream code can distinguish "migrated, no bug context" from "field
 * never existed".
 */
export function migrateStateV1_0ToV1_1(
  state: RequestStateV1_0,
): RequestStateV1_1 {
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
 *
 * A state is v1.0 iff `schema_version === 1.0` AND it has no own
 * `request_type` property. The own-property check guards against
 * forward-compat shims that backport `request_type` onto v1.0.
 */
export function isLegacyState(state: unknown): state is RequestStateV1_0 {
  if (state === null || typeof state !== 'object') return false;
  const s = state as Record<string, unknown>;
  return (
    s.schema_version === 1.0
    && !Object.prototype.hasOwnProperty.call(s, 'request_type')
  );
}

/**
 * Convenience: assert and migrate if needed. Returns a guaranteed v1.1
 * object. Throws if the input is not a recognized state shape.
 */
export function requireV1_1(state: RequestState): RequestStateV1_1 {
  if (state.schema_version === 1.1) return state;
  if (state.schema_version === 1.0) return migrateStateV1_0ToV1_1(state);
  // Unreachable per the union; defensive throw for runtime garbage.
  throw new Error(
    `Unrecognized state schema_version: ${String(
      (state as { schema_version: unknown }).schema_version,
    )}`,
  );
}
