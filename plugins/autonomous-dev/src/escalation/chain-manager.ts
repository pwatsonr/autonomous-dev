/**
 * Escalation Chain Manager for the escalation subsystem.
 *
 * Manages timeout-based escalation chains with secondary routing and
 * configurable timeout behaviors. Each chain follows this lifecycle:
 *
 *   1. Dispatch to PRIMARY target, start timeout timer.
 *   2. On primary timeout: if secondary exists, dispatch to secondary
 *      and start another timer; otherwise apply timeout behavior.
 *   3. On secondary timeout: apply timeout behavior.
 *
 * Timeout behaviors:
 *   - pause:  Pipeline stays paused indefinitely. Escalation remains open.
 *   - retry:  Signal pipeline to re-execute the failed phase.
 *   - skip:   Proceed past the gate. ONLY for "informational" urgency;
 *             otherwise falls back to "pause".
 *   - cancel: Terminate the request. Preserve state for forensics.
 *
 * Based on SPEC-009-2-3 (TDD-009 Sections 3.3, 3.4).
 */

import type {
  AuditTrail,
  ChainState,
  DeliveryAdapter,
  EscalationMessage,
  ResolvedRoute,
  Timer,
  TimerHandle,
} from "./types";

// ---------------------------------------------------------------------------
// Internal state for tracking active timers
// ---------------------------------------------------------------------------

/** Internal bookkeeping attached to each chain. */
interface ActiveChain {
  state: ChainState;
  message: EscalationMessage;
  timerHandle: TimerHandle | null;
}

// ---------------------------------------------------------------------------
// Timeout behavior result (returned to caller for pipeline coordination)
// ---------------------------------------------------------------------------

/**
 * Describes the action the pipeline should take after a chain exhausts
 * all targets and the timeout behavior is applied.
 */
export interface TimeoutBehaviorResult {
  escalationId: string;
  requestId: string;
  behavior: "pause" | "retry" | "skip" | "cancel";
}

// ---------------------------------------------------------------------------
// EscalationChainManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of escalation chains: dispatching messages to
 * primary and secondary targets, running timeout timers, and applying
 * the configured timeout behavior when the chain is exhausted.
 *
 * All dependencies are constructor-injected for testability:
 *   - Timer:           Abstracted setTimeout/clearTimeout for deterministic tests.
 *   - DeliveryAdapter: Sends messages to targets (Slack, CLI, etc.).
 *   - AuditTrail:      Records escalation events for compliance.
 *
 * An optional `onTimeoutBehavior` callback is invoked when a chain's
 * timeout behavior is applied, allowing the pipeline orchestrator to react.
 */
export class EscalationChainManager {
  /** All active chains, keyed by escalation ID. */
  private readonly chains = new Map<string, ActiveChain>();

  /** Optional callback invoked when a timeout behavior is applied. */
  onTimeoutBehavior?: (result: TimeoutBehaviorResult) => void;

  constructor(
    private readonly timer: Timer,
    private readonly deliveryAdapter: DeliveryAdapter,
    private readonly auditTrail: AuditTrail,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start an escalation chain: dispatch to the primary target and begin
   * the timeout countdown.
   *
   * @returns The initial ChainState snapshot.
   */
  startChain(escalation: EscalationMessage, route: ResolvedRoute): ChainState {
    const now = new Date();

    const state: ChainState = {
      escalationId: escalation.escalation_id,
      requestId: escalation.request_id,
      status: "primary_dispatched",
      primaryTarget: route.primary,
      secondaryTarget: route.secondary,
      primaryDispatchedAt: now,
      secondaryDispatchedAt: undefined,
      timeoutBehavior: route.timeoutBehavior,
      timeoutMinutes: route.timeoutMinutes,
    };

    // Dispatch to primary target
    this.deliveryAdapter.deliver(escalation, route.primary);

    // Emit audit: escalation_raised
    this.auditTrail.append({
      event_type: "escalation_raised",
      payload: {
        escalation_id: escalation.escalation_id,
        request_id: escalation.request_id,
        escalation_type: escalation.escalation_type,
        urgency: escalation.urgency,
        target: route.primary.target_id,
      },
    });

    // Start primary timeout timer
    const timeoutMs = route.timeoutMinutes * 60 * 1000;
    const handle = this.timer.setTimeout(() => {
      this.onPrimaryTimeout(escalation, route);
    }, timeoutMs);

    // Track the chain
    this.chains.set(escalation.escalation_id, {
      state,
      message: escalation,
      timerHandle: handle,
    });

    // Return a snapshot (not a reference to internal state)
    return { ...state };
  }

  /**
   * Cancel a specific escalation chain.
   *
   * Cancelling an already-resolved or already-cancelled chain is a no-op
   * (idempotent).
   */
  cancelChain(escalationId: string): void {
    const chain = this.chains.get(escalationId);
    if (!chain) {
      return; // No-op: unknown chain
    }

    if (chain.state.status === "resolved" || chain.state.status === "cancelled") {
      return; // No-op: already terminal
    }

    // Clear any pending timer
    if (chain.timerHandle !== null) {
      this.timer.clearTimeout(chain.timerHandle);
      chain.timerHandle = null;
    }

    chain.state.status = "cancelled";
  }

  /**
   * Cancel all pending chains for a specific request ID.
   */
  cancelAllPendingForRequest(requestId: string): void {
    for (const [escalationId, chain] of this.chains) {
      if (chain.state.requestId === requestId) {
        this.cancelChain(escalationId);
      }
    }
  }

  /**
   * Cancel all pending chains globally (for kill switch).
   */
  cancelAllPending(): void {
    for (const escalationId of this.chains.keys()) {
      this.cancelChain(escalationId);
    }
  }

  /**
   * Get the current chain state for an escalation.
   *
   * @returns A snapshot of the chain state, or null if not found.
   */
  getChainState(escalationId: string): ChainState | null {
    const chain = this.chains.get(escalationId);
    if (!chain) {
      return null;
    }
    return { ...chain.state };
  }

  // -------------------------------------------------------------------------
  // Private: timeout handlers
  // -------------------------------------------------------------------------

  /**
   * Called when the primary target's timeout expires.
   *
   * If a secondary target exists, dispatch to it and start a new timer.
   * Otherwise, apply the timeout behavior directly.
   */
  private onPrimaryTimeout(
    escalation: EscalationMessage,
    route: ResolvedRoute,
  ): void {
    const chain = this.chains.get(escalation.escalation_id);
    if (!chain) {
      return; // Chain was removed or never existed
    }

    // If chain was already cancelled/resolved, do nothing
    if (chain.state.status === "cancelled" || chain.state.status === "resolved") {
      return;
    }

    if (route.secondary) {
      // Dispatch to secondary target
      chain.state.status = "secondary_dispatched";
      chain.state.secondaryDispatchedAt = new Date();

      this.deliveryAdapter.deliver(escalation, route.secondary);

      // Emit audit: escalation_timeout (primary -> secondary)
      this.auditTrail.append({
        event_type: "escalation_timeout",
        payload: {
          escalation_id: escalation.escalation_id,
          request_id: escalation.request_id,
          target: "primary",
          chainedTo: "secondary",
        },
      });

      // Start secondary timeout timer (same duration)
      const timeoutMs = route.timeoutMinutes * 60 * 1000;
      chain.timerHandle = this.timer.setTimeout(() => {
        this.onSecondaryTimeout(escalation, route);
      }, timeoutMs);
    } else {
      // No secondary target -- apply timeout behavior directly
      this.auditTrail.append({
        event_type: "escalation_timeout",
        payload: {
          escalation_id: escalation.escalation_id,
          request_id: escalation.request_id,
          target: "primary",
          behavior: chain.state.timeoutBehavior,
        },
      });

      this.applyTimeoutBehavior(chain);
    }
  }

  /**
   * Called when the secondary target's timeout expires.
   * Always applies the timeout behavior.
   */
  private onSecondaryTimeout(
    escalation: EscalationMessage,
    _route: ResolvedRoute,
  ): void {
    const chain = this.chains.get(escalation.escalation_id);
    if (!chain) {
      return;
    }

    if (chain.state.status === "cancelled" || chain.state.status === "resolved") {
      return;
    }

    // Emit audit: escalation_timeout (secondary)
    this.auditTrail.append({
      event_type: "escalation_timeout",
      payload: {
        escalation_id: escalation.escalation_id,
        request_id: escalation.request_id,
        target: "secondary",
        behavior: chain.state.timeoutBehavior,
      },
    });

    this.applyTimeoutBehavior(chain);
  }

  // -------------------------------------------------------------------------
  // Private: timeout behavior application
  // -------------------------------------------------------------------------

  /**
   * Apply the configured timeout behavior to a chain.
   *
   * - pause:  Pipeline stays paused. Escalation remains open. No status change
   *           to "timeout_behavior_applied" -- it stays as-is so the escalation
   *           is still considered "open" for response handling.
   * - retry:  Signal pipeline to re-execute. Mark as timeout_behavior_applied.
   * - skip:   Proceed past the gate. ONLY for "informational" urgency.
   *           Non-informational urgency falls back to "pause" with a warning.
   * - cancel: Terminate the request. Mark as timeout_behavior_applied.
   */
  private applyTimeoutBehavior(chain: ActiveChain): void {
    chain.timerHandle = null; // Timer has already fired

    let effectiveBehavior = chain.state.timeoutBehavior;

    // Skip is only allowed for informational urgency
    if (effectiveBehavior === "skip" && chain.message.urgency !== "informational") {
      console.warn(
        `[EscalationChainManager] Timeout behavior "skip" is only allowed for ` +
          `"informational" urgency (got "${chain.message.urgency}"). ` +
          `Falling back to "pause".`,
      );
      effectiveBehavior = "pause";
    }

    switch (effectiveBehavior) {
      case "pause":
        // Pipeline stays paused indefinitely. Escalation remains open.
        // Status stays as-is (primary_dispatched or secondary_dispatched)
        // to indicate the escalation is still awaiting a human response.
        chain.state.status = "timeout_behavior_applied";
        break;

      case "retry":
        chain.state.status = "timeout_behavior_applied";
        break;

      case "skip":
        chain.state.status = "timeout_behavior_applied";
        break;

      case "cancel":
        chain.state.status = "timeout_behavior_applied";
        break;
    }

    // Notify the pipeline orchestrator (if callback is registered)
    if (this.onTimeoutBehavior) {
      this.onTimeoutBehavior({
        escalationId: chain.state.escalationId,
        requestId: chain.state.requestId,
        behavior: effectiveBehavior,
      });
    }
  }
}
