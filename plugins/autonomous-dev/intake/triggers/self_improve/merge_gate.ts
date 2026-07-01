/**
 * TASK-011 — Merge-gate helpers for self-improvement requests.
 *
 * Self-improvement fix requests MUST NEVER be automatically merged (ADR-006,
 * FR-MERGE-01). This module provides the gate check so every auto-merge code
 * path can enforce the invariant before calling `gh pr merge`.
 *
 * The gate is state-based (reads `state.source`), NOT label-based. A label
 * alone cannot reliably prevent auto-merge if the state file is absent or
 * the label is removed; the source field in state.json is written at
 * submission time and is immutable.
 *
 * @module intake/triggers/self_improve/merge_gate
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal shape of a request state object. */
export interface StateShape {
  source?: unknown;
  self_improve?: { sourceIssue?: { repoId?: string; issueNumber?: number } };
}

/** Result of `checkAutoMergeAllowed`. */
export interface AutoMergeDecision {
  allow: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Return `true` when a state object belongs to a self-improvement request.
 *
 * A state is a self-improvement request when:
 * - `state.source === 'self-improve'`, OR
 * - `state.self_improve.sourceIssue.issueNumber` is a positive integer.
 *
 * @param state - The request state object to inspect.
 * @returns `true` if the request is a self-improvement request.
 */
export function isSelfImproveRequest(state: StateShape): boolean {
  if (state?.source === 'self-improve') return true;
  const issueNumber = state?.self_improve?.sourceIssue?.issueNumber;
  return typeof issueNumber === 'number' && Number.isInteger(issueNumber) && issueNumber > 0;
}

/**
 * Determine whether automatic merging is allowed for a request.
 *
 * Self-improvement requests are ALWAYS blocked from auto-merge regardless of
 * any PR labels (ADR-006). This function is the canonical enforcement point
 * that every auto-merge helper MUST invoke before proceeding.
 *
 * @param state - The raw state.json content (or `null`/non-object).
 * @param prLabels - Labels on the PR (inspected ONLY for non-self-improve logic;
 *   ignored for self-improve — the gate is state-based).
 * @returns An `AutoMergeDecision` indicating whether auto-merge is allowed.
 */
export function checkAutoMergeAllowed(
  state: unknown,
  prLabels: readonly string[],
): AutoMergeDecision {
  // Null or non-object state → not a self-improve request; allow.
  if (state === null || typeof state !== 'object' || Array.isArray(state)) {
    return { allow: true };
  }

  const shaped = state as StateShape;

  if (isSelfImproveRequest(shaped)) {
    return {
      allow: false,
      reason: 'self-improve request never auto-merges (FR-MERGE-01)',
    };
  }

  // Non-self-improve request — allow (labels are not our concern here).
  void prLabels; // intentionally unused; reserved for future label-based rules
  return { allow: true };
}
