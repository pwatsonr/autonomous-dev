/**
 * Core Kill Switch with graceful/hard modes (SPEC-009-4-2, Task 4).
 *
 * Provides emergency shutdown capability for the autonomous development
 * pipeline. Supports two kill modes:
 *   - KILL_GRACEFUL: Executors finish their current atomic operation, then stop.
 *   - KILL_HARD: Executors stop immediately.
 *
 * Key guarantees:
 *   - State snapshot is captured BEFORE abort signal is sent.
 *   - Idempotent: a second kill while halted returns the previous result.
 *   - cancel() aborts a single request without changing global state.
 *   - reenable() restores the system to "running" after a kill.
 *
 * All audit events follow the format expected by the trust subsystem's
 * AuditTrail interface.
 */

import type { StateSnapshotCapture } from "./state-snapshot";
import type {
  KillMode,
  SystemState,
  AbortReason,
  KillResult,
  CancelResult,
  StateSnapshot,
} from "./types";

// ---------------------------------------------------------------------------
// Types (supplementary -- core types imported from ./types)
// ---------------------------------------------------------------------------

/** Notification payload emitted on kill. */
export interface NotificationPayload {
  type: string;
  urgency: string;
  mode: KillMode;
  issuedBy: string;
  issuedAt: Date;
  totalActiveRequests: number;
}

// ---------------------------------------------------------------------------
// Injectable interfaces
// ---------------------------------------------------------------------------

/**
 * Manages per-request abort signals. The kill switch delegates abort
 * signaling to this interface rather than managing AbortControllers directly.
 *
 * The concrete implementation is `AbortManager` from `./abort-manager.ts`.
 * This interface exists so the kill switch can be tested with mocks.
 */
export interface AbortManagerPort {
  /** Returns IDs of all currently active (non-aborted) requests. */
  getActiveRequestIds(): string[];

  /** Abort all active requests with the given reason. */
  abortAll(reason: AbortReason): void;

  /** Abort a single request with the given reason. */
  abortRequest(requestId: string, reason: AbortReason): void;

  /** Reset the abort manager, creating fresh controllers for new registrations. */
  reset(): void;
}

/**
 * Minimal audit trail interface consumed by the kill switch.
 *
 * Compatible with both trust and escalation subsystem AuditTrail interfaces.
 */
export interface AuditTrail {
  append(event: {
    event_type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Escalation engine interface -- only the cancelAllPending method is needed
 * by the kill switch.
 */
export interface EscalationCanceller {
  cancelAllPending(): void;
}

/**
 * Notification emitter for kill switch events.
 */
export interface Notifier {
  emit(payload: NotificationPayload): void;
}

// ---------------------------------------------------------------------------
// KillSwitch
// ---------------------------------------------------------------------------

/**
 * Core kill switch with graceful and hard kill modes.
 *
 * Lifecycle:
 *   running --[kill()]--> halted --[reenable()]--> running
 *
 * The kill() method:
 *   1. Checks idempotency (returns previous result if already halted).
 *   2. Captures state snapshots BEFORE signaling abort.
 *   3. Persists the kill snapshot atomically.
 *   4. Signals abort to all active requests.
 *   5. Cancels all pending escalation chains.
 *   6. Updates global state to "halted".
 *   7. Emits audit events and notifications.
 *
 * All dependencies are constructor-injected for testability.
 */
export class KillSwitch {
  private state: SystemState = "running";
  private lastKill: KillResult | null = null;

  constructor(
    private readonly abortManager: AbortManagerPort,
    private readonly snapshotCapture: StateSnapshotCapture,
    private readonly escalationEngine: EscalationCanceller,
    private readonly auditTrail: AuditTrail,
    private readonly notifier: Notifier,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Kill all active requests.
   *
   * @param mode "graceful" (KILL_GRACEFUL) or "hard" (KILL_HARD)
   * @param issuedBy Identity of the person/system issuing the kill
   * @returns KillResult with snapshot data
   */
  async kill(mode: KillMode, issuedBy: string): Promise<KillResult> {
    // Step 1: Idempotency check
    if (this.state === "halted") {
      this.auditTrail.append({
        event_type: "kill_issued_duplicate",
        payload: { mode, issuedBy },
      });
      return this.lastKill!;
    }

    // Step 2: Get active request IDs
    const activeIds = this.abortManager.getActiveRequestIds();

    // Step 3: Capture state BEFORE signaling (snapshot-before-signal ordering)
    const snapshots = this.snapshotCapture.captureAll(activeIds);

    // Step 4: Persist kill snapshot atomically
    const snapshotPath = await this.snapshotCapture.persistKillSnapshot(
      snapshots,
      mode,
      issuedBy,
    );

    // Step 5: Signal abort
    const abortReason: AbortReason =
      mode === "graceful" ? "KILL_GRACEFUL" : "KILL_HARD";
    this.abortManager.abortAll(abortReason);

    // Step 6: Cancel all pending escalations
    this.escalationEngine.cancelAllPending();

    // Step 7: Update state
    this.state = "halted";

    // Step 8: Build result
    const result: KillResult = {
      mode,
      issuedBy,
      issuedAt: new Date(),
      haltedRequests: snapshots,
      totalActiveRequests: activeIds.length,
    };

    // Step 9: Store for idempotency
    this.lastKill = result;

    // Step 10: Audit
    this.auditTrail.append({
      event_type: "kill_issued",
      payload: {
        mode,
        issuedBy,
        snapshotPath,
        totalRequests: activeIds.length,
      },
    });

    // Step 11: Notification
    this.notifier.emit({
      type: "kill_switch_activated",
      urgency: "immediate",
      mode,
      issuedBy,
      issuedAt: result.issuedAt,
      totalActiveRequests: activeIds.length,
    });

    // Step 12: Return result
    return result;
  }

  /**
   * Cancel a single request without changing global system state.
   *
   * @param requestId The request to cancel.
   * @param issuedBy Identity of the person/system issuing the cancel.
   * @returns CancelResult with the pre-cancel snapshot.
   */
  async cancel(requestId: string, issuedBy: string): Promise<CancelResult> {
    // Step 1: Capture state for the single request
    const snapshot = this.snapshotCapture.captureOne(requestId);

    // Step 2: Abort the single request
    this.abortManager.abortRequest(requestId, "CANCEL");

    // Step 3: Audit
    this.auditTrail.append({
      event_type: "cancel_issued",
      payload: { requestId, issuedBy },
    });

    // Step 4: Return result
    return {
      requestId,
      cancelledBy: issuedBy,
      cancelledAt: new Date(),
      snapshot,
    };
  }

  /**
   * Returns true if the system is in the "halted" state.
   */
  isHalted(): boolean {
    return this.state === "halted";
  }

  /**
   * Returns the last kill result.
   *
   * Used by HaltedGate to include kill context in rejection errors.
   * Throws if no kill has been issued (caller should check isHalted() first).
   */
  getLastKillResult(): KillResult {
    if (!this.lastKill) {
      throw new Error("No kill result available: system has not been killed");
    }
    return this.lastKill;
  }

  /**
   * Returns the current global system state.
   */
  getState(): SystemState {
    return this.state;
  }

  /**
   * Re-enable the system after a kill.
   *
   * @param issuedBy Identity of the person/system re-enabling the system.
   * @throws Error if the system is not currently halted.
   */
  reenable(issuedBy: string): void {
    // Step 1: Guard -- must be halted
    if (this.state !== "halted") {
      throw new Error("Cannot re-enable: system is not halted");
    }

    // Step 2: Reset abort manager (fresh controllers for new registrations)
    this.abortManager.reset();

    // Step 3: Restore running state
    this.state = "running";

    // Step 4: Clear last kill for idempotency
    this.lastKill = null;

    // Step 5: Audit
    this.auditTrail.append({
      event_type: "system_reenabled",
      payload: { issuedBy },
    });
  }
}
