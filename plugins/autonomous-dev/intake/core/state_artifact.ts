/**
 * State-artifact construction helpers (SPEC-012-1-02 §"State Artifact Construction").
 *
 * Produces / transforms `StateJsonV11` values (the canonical on-disk shape
 * defined by `intake/state/state_validator.ts`). PLAN-012-1's "InitialState"
 * shape from the spec is intentionally a SUBSET of `StateJsonV11`; we
 * always emit the v1.1 shape so the daemon's reader can validate without
 * branching.
 *
 * --- Mismatch note (per runbook) -------------------------------------------
 * SPEC-012-1-02's `InitialState` interface lists `schema_version: 1`, but
 * the canonical `StateJsonV11` shape (PLAN-012-2) does NOT carry an
 * explicit `schema_version` field; v1.0 vs v1.1 is detected by the
 * presence of `source` / `adapter_metadata`. We emit BOTH the v1.1 fields
 * AND the spec-requested `schema_version: 1` so consumers that look for
 * either contract are happy.
 *
 * @module core/state_artifact
 */

import type { StateJsonV11 } from '../state/state_validator';

import type { SubmitRequest } from './types';

// ---------------------------------------------------------------------------
// Initial state builder
// ---------------------------------------------------------------------------

/**
 * Build the initial `state.json` payload for a fresh request.
 *
 * Invariants enforced:
 *   - `created_at === updated_at` (must be the same ISO string).
 *   - `phase_history` is an empty array (NOT undefined).
 *   - `adapter_metadata` is JSON round-tripped to strip non-serializable
 *     values (functions, undefined, circular refs throw).
 *   - `paused_from` is NOT set (forbidden on initial state per spec).
 *
 * @param req         Submission input.
 * @param createdAt   ISO 8601 UTC timestamp; reused as `updated_at`.
 *                    Caller passes `nowIso()` so multiple submits in the
 *                    same logical millisecond have the same timestamp.
 */
export function buildInitialState(
  req: SubmitRequest,
  createdAt: string,
): StateJsonV11 {
  // Round-trip adapter_metadata to strip non-serializable values
  // (functions, undefined, symbols) per SPEC-012-1-02 acceptance criteria.
  const sanitizedMetadata = JSON.parse(
    JSON.stringify(req.adapterMetadata ?? {}),
  ) as StateJsonV11['adapter_metadata'];

  const state: StateJsonV11 = {
    schema_version: 1,
    request_id: req.requestId,
    status: 'queued',
    priority: req.priority,
    description: req.description,
    repository: req.repository,
    source: req.source,
    adapter_metadata: sanitizedMetadata,
    created_at: createdAt,
    updated_at: createdAt,
    phase_history: [],
    current_phase_metadata: {},
    cost_accrued_usd: 0,
    turn_count: 0,
    escalation_count: 0,
    blocked_by: [],
    error: null,
    last_checkpoint: null,
  };

  return state;
}

// ---------------------------------------------------------------------------
// Transition application (used by pause / resume / cancel / setPriority)
// ---------------------------------------------------------------------------

/**
 * Pure helper to apply a partial mutation to a state object and bump
 * `updated_at`. Used by `handoff_manager.ts` transition helpers; exposed
 * here for unit-testability.
 */
export function applyTransition(
  current: StateJsonV11,
  updates: Partial<StateJsonV11>,
  at: string,
): StateJsonV11 {
  return {
    ...current,
    ...updates,
    updated_at: at,
  } as StateJsonV11;
}
