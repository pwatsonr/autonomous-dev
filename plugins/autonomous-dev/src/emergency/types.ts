/**
 * Type definitions for the kill switch and emergency controls subsystem.
 *
 * Defines the kill switch modes, system states, abort reasons, and all
 * supporting result interfaces used by the AbortManager, kill switch
 * commands, and pipeline executors.
 *
 * Based on SPEC-009-4-1 (TDD Section 3.3).
 */

// ---------------------------------------------------------------------------
// Core type unions
// ---------------------------------------------------------------------------

/** Kill mode: graceful waits for phase boundaries, hard aborts immediately. */
export type KillMode = "graceful" | "hard";

/** Top-level system state managed by the kill switch. */
export type SystemState = "running" | "halted" | "paused";

/** Reason attached to an abort signal so listeners can distinguish cause. */
export type AbortReason = "KILL_GRACEFUL" | "KILL_HARD" | "CANCEL" | "PAUSE";

// ---------------------------------------------------------------------------
// Kill result
// ---------------------------------------------------------------------------

/**
 * Returned by the kill switch after a global halt is issued.
 * Contains snapshots of every request that was active at the time.
 */
export interface KillResult {
  mode: KillMode;
  issuedBy: string;
  issuedAt: Date;
  haltedRequests: StateSnapshot[];
  totalActiveRequests: number;
}

// ---------------------------------------------------------------------------
// State snapshot
// ---------------------------------------------------------------------------

/**
 * Point-in-time snapshot of a single pipeline request's state.
 * Captured during kill or cancel for forensic / resume purposes.
 */
export interface StateSnapshot {
  requestId: string;
  pipelinePhase: string;
  phaseStatus: "running" | "completed" | "pending" | "unknown";
  /** Workspace-relative paths to generated artifacts. */
  artifacts: string[];
  pendingEscalationIds: string[];
  trustLevel: number;
}

// ---------------------------------------------------------------------------
// Cancel result
// ---------------------------------------------------------------------------

/** Returned when a single request is cancelled. */
export interface CancelResult {
  requestId: string;
  cancelledBy: string;
  cancelledAt: Date;
  snapshot: StateSnapshot;
}

// ---------------------------------------------------------------------------
// Pause / resume result
// ---------------------------------------------------------------------------

/** Returned when one or all requests are paused or resumed. */
export interface PauseResumeResult {
  /** Undefined when the action applies to all requests. */
  requestId?: string;
  action: "paused" | "resumed";
  issuedBy: string;
  issuedAt: Date;
  affectedRequests: string[];
}

// ---------------------------------------------------------------------------
// Timer handle
// ---------------------------------------------------------------------------

/** Opaque handle for a scheduled timer, used by timeout-based components. */
export interface TimerHandle {
  id: number | NodeJS.Timeout;
}
