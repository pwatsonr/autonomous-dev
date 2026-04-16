/**
 * Trust Level Change State Machine (SPEC-009-1-3, Task 4).
 *
 * Manages mid-pipeline trust level changes. Trust changes are requested at
 * any time but applied only at gate boundaries, ensuring that in-flight
 * phases are never retroactively affected.
 *
 * State machine:
 *   CURRENT_LEVEL --[requestChange()]--> CHANGE_PENDING --[resolveAtGateBoundary()]--> NEW_LEVEL
 *                                             |
 *                                        (if upgrade)
 *                                             |
 *                                   AWAITING_CONFIRMATION --[confirm()]--> CHANGE_PENDING
 *                                             |
 *                                        [reject()]--> CURRENT_LEVEL (change discarded)
 *
 * Key rules:
 *   - Downgrades (toLevel < fromLevel): immediately "pending", applied at next boundary.
 *   - Upgrades (toLevel > fromLevel): "awaiting_confirmation" until confirmed.
 *   - Same-level: no-op (logged but no state change).
 *   - Concurrent changes: last-write-wins; superseded change is logged.
 *   - All transitions emit audit events via the injected AuditTrail.
 */

import type { TrustLevel, TrustLevelChangeRequest } from "./types";

// ---------------------------------------------------------------------------
// AuditTrail interface (minimal, per SPEC-009-5-7)
// ---------------------------------------------------------------------------

/**
 * Minimal audit trail interface consumed by trust subsystem components.
 *
 * The full AuditTrailEngine (SPEC-009-5-7) implements this interface plus
 * replay and verification. This minimal version is all that PLAN-009-1
 * subsystems depend on.
 */
export interface AuditTrail {
  append(event: {
    event_type: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// PendingChange
// ---------------------------------------------------------------------------

/**
 * Internal state for a pending trust level change.
 */
export interface PendingChange {
  requestId: string;
  fromLevel: TrustLevel;
  toLevel: TrustLevel;
  status: "pending" | "awaiting_confirmation";
  requestedBy: string;
  requestedAt: Date;
  reason: string;
}

// ---------------------------------------------------------------------------
// TrustChangeManager
// ---------------------------------------------------------------------------

/**
 * State machine that manages mid-pipeline trust level changes.
 *
 * Changes are requested via `requestChange()` and applied only at gate
 * boundaries via `resolveAtGateBoundary()`. Downgrades are immediate;
 * upgrades require confirmation. Concurrent changes use last-write-wins.
 * All transitions emit audit events via the injected `AuditTrail`.
 */
export class TrustChangeManager {
  private pendingChanges: Map<string, PendingChange> = new Map();

  constructor(private readonly auditTrail: AuditTrail) {}

  /**
   * Request a trust level change.
   *
   * - Downgrade (toLevel < fromLevel): status set to "pending" immediately.
   * - Upgrade (toLevel > fromLevel): status set to "awaiting_confirmation".
   * - Same level (toLevel === fromLevel): no-op. Logged but no state change.
   * - If a previous change exists for this requestId, it is superseded
   *   (last-write-wins) and a superseded audit event is emitted.
   *
   * @returns The PendingChange created, or null if same-level no-op.
   */
  requestChange(
    requestId: string,
    change: TrustLevelChangeRequest,
  ): PendingChange | null {
    // Same-level request is a no-op
    if (change.fromLevel === change.toLevel) {
      this.auditTrail.append({
        event_type: "trust_level_change_requested",
        payload: {
          requestId,
          fromLevel: change.fromLevel,
          toLevel: change.toLevel,
          requestedBy: change.requestedBy,
          reason: change.reason,
          noop: true,
        },
      });
      return null;
    }

    // Check for concurrent change (last-write-wins)
    const existing = this.pendingChanges.get(requestId);
    if (existing) {
      this.auditTrail.append({
        event_type: "trust_level_change_superseded",
        payload: {
          requestId,
          supersededChange: {
            fromLevel: existing.fromLevel,
            toLevel: existing.toLevel,
            status: existing.status,
            requestedBy: existing.requestedBy,
            reason: existing.reason,
          },
          newChange: {
            fromLevel: change.fromLevel,
            toLevel: change.toLevel,
            requestedBy: change.requestedBy,
            reason: change.reason,
          },
        },
      });
    }

    const isUpgrade = change.toLevel > change.fromLevel;

    const pendingChange: PendingChange = {
      requestId,
      fromLevel: change.fromLevel,
      toLevel: change.toLevel,
      status: isUpgrade ? "awaiting_confirmation" : "pending",
      requestedBy: change.requestedBy,
      requestedAt: change.requestedAt,
      reason: change.reason,
    };

    this.pendingChanges.set(requestId, pendingChange);

    this.auditTrail.append({
      event_type: "trust_level_change_requested",
      payload: {
        requestId,
        fromLevel: change.fromLevel,
        toLevel: change.toLevel,
        requestedBy: change.requestedBy,
        reason: change.reason,
      },
    });

    return pendingChange;
  }

  /**
   * Called at each gate boundary. If a pending change exists with status
   * "pending", applies it and returns the new level. If the change is
   * "awaiting_confirmation", it is not applied. If no pending change
   * exists, returns the current level unchanged.
   *
   * @param requestId    The request/pipeline identifier.
   * @param currentLevel The current effective trust level.
   * @returns The effective trust level after this gate boundary.
   */
  resolveAtGateBoundary(
    requestId: string,
    currentLevel: TrustLevel,
  ): TrustLevel {
    const pending = this.pendingChanges.get(requestId);

    if (!pending) {
      return currentLevel;
    }

    // Only apply changes that are in "pending" status
    if (pending.status !== "pending") {
      return currentLevel;
    }

    // Apply the change
    const newLevel = pending.toLevel;

    // Clear the pending change
    this.pendingChanges.delete(requestId);

    // Emit audit event
    this.auditTrail.append({
      event_type: "trust_level_changed",
      payload: {
        requestId,
        fromLevel: pending.fromLevel,
        toLevel: newLevel,
        appliedAtGate: true,
      },
    });

    return newLevel;
  }

  /**
   * Confirm a pending upgrade (Phase 1 requirement).
   *
   * Transitions the change from "awaiting_confirmation" to "pending" so
   * it will be applied at the next gate boundary.
   *
   * @throws Error if no pending change exists or if the change is not
   *         in "awaiting_confirmation" status.
   */
  confirmUpgrade(requestId: string): void {
    const pending = this.pendingChanges.get(requestId);

    if (!pending) {
      throw new Error(
        `No pending change found for requestId: ${requestId}`,
      );
    }

    if (pending.status !== "awaiting_confirmation") {
      throw new Error(
        `Change for requestId ${requestId} is not awaiting confirmation (status: ${pending.status})`,
      );
    }

    pending.status = "pending";

    this.auditTrail.append({
      event_type: "trust_upgrade_confirmed",
      payload: {
        requestId,
        toLevel: pending.toLevel,
      },
    });
  }

  /**
   * Reject a pending upgrade.
   *
   * Discards the pending change. The current level remains unchanged.
   *
   * @throws Error if no pending change exists or if the change is not
   *         in "awaiting_confirmation" status.
   */
  rejectUpgrade(requestId: string): void {
    const pending = this.pendingChanges.get(requestId);

    if (!pending) {
      throw new Error(
        `No pending change found for requestId: ${requestId}`,
      );
    }

    if (pending.status !== "awaiting_confirmation") {
      throw new Error(
        `Change for requestId ${requestId} is not awaiting confirmation (status: ${pending.status})`,
      );
    }

    const toLevel = pending.toLevel;

    // Discard the change
    this.pendingChanges.delete(requestId);

    this.auditTrail.append({
      event_type: "trust_upgrade_rejected",
      payload: {
        requestId,
        toLevel,
        reason: "Upgrade rejected",
      },
    });
  }

  /**
   * Get the current pending change for a request, if any.
   *
   * @returns The pending change, or null if none exists.
   */
  getPendingChange(requestId: string): PendingChange | null {
    return this.pendingChanges.get(requestId) ?? null;
  }
}
