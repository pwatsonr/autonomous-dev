/**
 * TASK-009 — Typed event emitter for the self-improvement loop.
 *
 * All events are routed through the existing audit sink (`deps.audit`). The
 * `createEmitter` factory auto-populates `ts` from `deps.now()` when the
 * caller does not supply it.
 *
 * @module intake/triggers/self_improve/events
 */

import type { ActionableClassId } from './actionable';
import type { GuardId } from './guards';

// ---------------------------------------------------------------------------
// Event union type
// ---------------------------------------------------------------------------

/** All events emitted by the self-improvement loop. */
export type SelfImproveEvent =
  | { type: 'self_improve_disabled'; ts: string }
  | {
      type: 'self_improve_issue_detected';
      ts: string;
      repoId: string;
      issueNumber: number;
      class: ActionableClassId;
    }
  | {
      type: 'self_improve_issue_skipped';
      ts: string;
      repoId: string;
      issueNumber: number;
      guard: GuardId;
      evidence: unknown;
    }
  | {
      type: 'self_improve_request_submitted';
      ts: string;
      repoId: string;
      issueNumber: number;
      requestId: string;
      class: ActionableClassId;
    }
  | {
      type: 'self_improve_body_truncated';
      ts: string;
      repoId: string;
      issueNumber: number;
      originalBytes: number;
      truncatedBytes: number;
    }
  | {
      type: 'self_improve_tick_summary';
      ts: string;
      scanned: number;
      submitted: number;
      skipped: Record<GuardId, number>;
      errors: number;
    }
  | {
      type: 'self_improve_error';
      ts: string;
      error: string;
      code?: string;
      repoId?: string;
      issueNumber?: number;
    }
  | {
      type: 'self_improve_config_invalid';
      ts: string;
      envVar: string;
      raw: string;
      fallback: string;
    };

/** Callable event emitter signature. */
export type EventEmitter = (ev: SelfImproveEvent) => void;

/** Injectable dependencies for the event emitter factory. */
export interface EmitterDeps {
  /** Existing audit sink (same as `runWatchTick`'s `deps.audit`). */
  audit: (record: object) => void;
  /** Used to auto-populate `ts` when the caller omits it. */
  now: () => number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a typed event emitter backed by an audit sink.
 *
 * Auto-fills `ts` (ISO-8601) from `deps.now()` when the caller-provided event
 * does not include one (i.e., when `ts` is absent / empty string).
 *
 * @param deps - Audit sink and clock injection.
 * @returns A callable `EventEmitter`.
 */
export function createEmitter(deps: EmitterDeps): EventEmitter {
  return function emitEvent(ev: SelfImproveEvent): void {
    const ts = ev.ts || new Date(deps.now()).toISOString();
    const record = { ...ev, ts };
    deps.audit(record);
  };
}
