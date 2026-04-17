/**
 * Pipeline Resumption Coordinator for the escalation subsystem
 * (SPEC-009-3-2, Task 5).
 *
 * Incorporates a resolved action into the pipeline execution context and
 * either resumes or terminates the pipeline. This coordinator is transactional:
 * either the pipeline fully resumes or it remains paused -- partial resumption
 * is not possible.
 *
 * Action handling:
 *
 *   Action              | Pipeline Effect
 *   ------------------- | -----------------------------------------------
 *   approve             | Gate passed, pipeline resumes
 *   retry_with_changes  | Guidance injected, phase re-executed
 *   cancel              | Request terminated
 *   override_proceed    | Gate overridden (with justification), pipeline resumes
 *   delegate            | Escalation re-dispatched to new target
 *
 * Transactional semantics: if any step fails, the pipeline remains paused,
 * the escalation chain is NOT cancelled (response not consumed), and the
 * error is returned so the human can retry.
 */

import type { EscalationChainManager } from "./chain-manager";
import type { AuditTrail, ResolvedRoute } from "./types";
import type { ResolvedAction } from "./response-types";
import type { StoredEscalation } from "./response-validator";

// ---------------------------------------------------------------------------
// PipelineExecutor interface
// ---------------------------------------------------------------------------

/**
 * Minimal interface for pipeline control.
 *
 * The resumption coordinator does not need full pipeline access -- only
 * these targeted operations. This keeps the dependency surface small and
 * makes testing straightforward.
 */
export interface PipelineExecutor {
  /** Mark a gate as passed (normal approval). */
  markGatePassed(requestId: string, gate: string): void;

  /** Mark a gate as overridden with a human justification. */
  markGateOverridden(requestId: string, gate: string, justification: string): void;

  /** Inject guidance text into the pipeline context for the next execution. */
  injectGuidance(requestId: string, guidance: string): void;

  /** Re-execute the current phase of the pipeline. */
  reExecutePhase(requestId: string): void;

  /** Terminate the request with a reason. State is preserved for forensics. */
  terminateRequest(requestId: string, reason: string): void;

  /** Resume the paused pipeline. */
  resumePipeline(requestId: string): void;
}

// ---------------------------------------------------------------------------
// ResumeResult
// ---------------------------------------------------------------------------

/** Result of a pipeline resumption attempt. */
export interface ResumeResult {
  /** Whether the resumption succeeded. */
  success: boolean;

  /** The action that was attempted. */
  action: string;

  /** The request ID of the pipeline. */
  requestId: string;

  /** Error message if the resumption failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// PipelineResumptionCoordinator
// ---------------------------------------------------------------------------

/**
 * Coordinates pipeline resumption after a human responds to an escalation.
 *
 * All dependencies are constructor-injected for testability:
 *   - PipelineExecutor:        Controls the pipeline lifecycle.
 *   - EscalationChainManager:  Manages escalation chain timers.
 *   - AuditTrail:              Records audit events for compliance.
 */
export class PipelineResumptionCoordinator {
  constructor(
    private readonly pipelineExecutor: PipelineExecutor,
    private readonly escalationChainManager: EscalationChainManager,
    private readonly auditTrail: AuditTrail,
  ) {}

  /**
   * Resume (or terminate) the pipeline based on the resolved action.
   *
   * This method is transactional: either all steps succeed or the pipeline
   * remains paused with the escalation chain intact.
   *
   * @param escalation  The stored escalation being resolved.
   * @param action      The resolved action from the ActionResolver.
   * @param responder   Who responded (for audit trail).
   * @returns A ResumeResult indicating success or failure.
   */
  resume(
    escalation: StoredEscalation,
    action: ResolvedAction,
    responder: string,
  ): ResumeResult {
    const requestId = escalation.requestId;
    const gate = escalation.gate ?? "unknown";

    try {
      switch (action.action) {
        case "approve":
          return this.handleApprove(escalation, gate, requestId, responder);

        case "retry_with_changes":
          return this.handleRetryWithChanges(
            escalation,
            requestId,
            action.guidance,
            responder,
          );

        case "cancel":
          return this.handleCancel(escalation, requestId, responder);

        case "override_proceed":
          return this.handleOverrideProceed(
            escalation,
            gate,
            requestId,
            action.justification,
            responder,
          );

        case "delegate":
          return this.handleDelegate(
            escalation,
            requestId,
            action.target,
            responder,
          );

        default: {
          const _exhaustive: never = action;
          throw new Error(`Unknown action: ${(_exhaustive as ResolvedAction).action}`);
        }
      }
    } catch (error) {
      // Transactional semantics: pipeline remains paused, chain NOT cancelled.
      // The human can retry their response.
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      return {
        success: false,
        action: action.action,
        requestId,
        error: errorMessage,
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private: action handlers
  // -------------------------------------------------------------------------

  /**
   * Handle "approve" action:
   *   1. Cancel escalation chain timer.
   *   2. Mark gate as passed.
   *   3. Resume pipeline.
   *   4. Emit escalation_resolved audit event.
   */
  private handleApprove(
    escalation: StoredEscalation,
    gate: string,
    requestId: string,
    responder: string,
  ): ResumeResult {
    // 1. Cancel chain timer
    this.escalationChainManager.cancelChain(escalation.escalationId);

    // 2. Mark gate as passed
    this.pipelineExecutor.markGatePassed(requestId, gate);

    // 3. Resume pipeline
    this.pipelineExecutor.resumePipeline(requestId);

    // 4. Emit audit event
    this.auditTrail.append({
      event_type: "escalation_resolved",
      payload: {
        escalation_id: escalation.escalationId,
        request_id: requestId,
        resolution: "approved",
        responder,
        gate,
      },
    });

    return { success: true, action: "approve", requestId };
  }

  /**
   * Handle "retry_with_changes" action:
   *   1. Cancel chain timer.
   *   2. Inject guidance into pipeline context.
   *   3. Re-execute the current phase.
   *   4. Emit escalation_resolved audit event.
   */
  private handleRetryWithChanges(
    escalation: StoredEscalation,
    requestId: string,
    guidance: string,
    responder: string,
  ): ResumeResult {
    // 1. Cancel chain timer
    this.escalationChainManager.cancelChain(escalation.escalationId);

    // 2. Inject guidance
    this.pipelineExecutor.injectGuidance(requestId, guidance);

    // 3. Re-execute phase
    this.pipelineExecutor.reExecutePhase(requestId);

    // 4. Emit audit event
    this.auditTrail.append({
      event_type: "escalation_resolved",
      payload: {
        escalation_id: escalation.escalationId,
        request_id: requestId,
        resolution: "retry_with_changes",
        responder,
        guidance,
      },
    });

    return { success: true, action: "retry_with_changes", requestId };
  }

  /**
   * Handle "cancel" action:
   *   1. Cancel chain timer.
   *   2. Terminate the request (state preserved for forensics).
   *   3. Emit escalation_resolved audit event with resolution: "cancelled".
   */
  private handleCancel(
    escalation: StoredEscalation,
    requestId: string,
    responder: string,
  ): ResumeResult {
    // 1. Cancel chain timer
    this.escalationChainManager.cancelChain(escalation.escalationId);

    // 2. Terminate request
    this.pipelineExecutor.terminateRequest(requestId, "Cancelled by human");

    // 3. Emit audit event
    this.auditTrail.append({
      event_type: "escalation_resolved",
      payload: {
        escalation_id: escalation.escalationId,
        request_id: requestId,
        resolution: "cancelled",
        responder,
      },
    });

    return { success: true, action: "cancel", requestId };
  }

  /**
   * Handle "override_proceed" action:
   *   1. Cancel chain timer.
   *   2. Mark gate as overridden with justification.
   *   3. Resume pipeline.
   *   4. Emit human_override audit event (distinct from escalation_resolved).
   *   5. Emit escalation_resolved audit event.
   */
  private handleOverrideProceed(
    escalation: StoredEscalation,
    gate: string,
    requestId: string,
    justification: string,
    responder: string,
  ): ResumeResult {
    // 1. Cancel chain timer
    this.escalationChainManager.cancelChain(escalation.escalationId);

    // 2. Mark gate as overridden
    this.pipelineExecutor.markGateOverridden(requestId, gate, justification);

    // 3. Resume pipeline
    this.pipelineExecutor.resumePipeline(requestId);

    // 4. Emit human_override audit event
    this.auditTrail.append({
      event_type: "human_override",
      payload: {
        escalation_id: escalation.escalationId,
        request_id: requestId,
        responder,
        justification,
        gate,
      },
    });

    // 5. Emit escalation_resolved audit event
    this.auditTrail.append({
      event_type: "escalation_resolved",
      payload: {
        escalation_id: escalation.escalationId,
        request_id: requestId,
        resolution: "override_proceed",
        responder,
        justification,
        gate,
      },
    });

    return { success: true, action: "override_proceed", requestId };
  }

  /**
   * Handle "delegate" action:
   *   1. Cancel chain timer for current target.
   *   2. Re-dispatch escalation to new target via chain manager.
   *   3. Emit escalation_resolved audit event with resolution: "delegated".
   *
   * Note: the escalation is NOT fully resolved -- it is re-routed to a new
   * target. The chain manager starts a new chain for the new target.
   */
  private handleDelegate(
    escalation: StoredEscalation,
    requestId: string,
    newTarget: string,
    responder: string,
  ): ResumeResult {
    // 1. Cancel chain timer for current target
    this.escalationChainManager.cancelChain(escalation.escalationId);

    // 2. Re-dispatch to new target via chain manager
    //    We construct a minimal EscalationMessage and ResolvedRoute for
    //    the chain manager's startChain method.
    const delegateMessage = {
      schema_version: "v1" as const,
      escalation_id: escalation.escalationId,
      timestamp: new Date().toISOString(),
      request_id: requestId,
      repository: "",
      pipeline_phase: "",
      escalation_type: "product" as const,
      urgency: "soon" as const,
      summary: `Delegated from ${responder} to ${newTarget}`,
      failure_reason: "Delegated escalation",
      options: escalation.options,
      retry_count: 0,
    };

    const delegateRoute: ResolvedRoute = {
      primary: {
        target_id: newTarget,
        display_name: newTarget,
        channel: "default",
      },
      timeoutMinutes: 60,
      timeoutBehavior: "pause",
    };

    this.escalationChainManager.startChain(delegateMessage, delegateRoute);

    // 3. Emit audit event
    this.auditTrail.append({
      event_type: "escalation_resolved",
      payload: {
        escalation_id: escalation.escalationId,
        request_id: requestId,
        resolution: "delegated",
        responder,
        newTarget,
      },
    });

    return { success: true, action: "delegate", requestId };
  }
}
