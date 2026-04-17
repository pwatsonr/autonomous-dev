/**
 * EscalationEngine facade (SPEC-009-2-4, Task 6).
 *
 * Orchestrates the classifier, formatter, routing engine, and chain manager
 * into a unified `raise()` entry point. This is the primary API surface
 * that the pipeline orchestrator interacts with when a failure requires
 * human intervention.
 *
 * The facade also provides `cancelPending()` and `cancelAllPending()` for
 * lifecycle management of in-flight escalations.
 *
 * Pipeline behavior enforcement (TDD Section 3.2.1):
 *   security       -> halt_immediately
 *   infrastructure -> pause_immediately
 *   cost           -> pause_before_incurring
 *   product        -> pause_at_boundary
 *   technical      -> pause_at_boundary
 *   quality        -> pause_at_boundary
 */

import type { EscalationClassifier } from "./classifier";
import type { FailureContext } from "./classifier";
import type { EscalationFormatter } from "./formatter";
import type { RoutingEngine } from "./routing-engine";
import type { EscalationChainManager } from "./chain-manager";
import type {
  AuditTrail,
  EscalationMessage,
  EscalationOption,
  EscalationResult,
  EscalationType,
  EscalationUrgency,
  PipelineBehavior,
  RequestContext,
} from "./types";

// ---------------------------------------------------------------------------
// Pipeline behavior resolution
// ---------------------------------------------------------------------------

/**
 * Map an escalation type to its pipeline behavior per TDD Section 3.2.1.
 */
export function resolvePipelineBehavior(type: EscalationType): PipelineBehavior {
  switch (type) {
    case "security":
      return "halt_immediately";
    case "infrastructure":
      return "pause_immediately";
    case "cost":
      return "pause_before_incurring";
    case "product":
    case "technical":
    case "quality":
      return "pause_at_boundary";
  }
}

// ---------------------------------------------------------------------------
// Options builder
// ---------------------------------------------------------------------------

/**
 * Build default response options based on escalation type and urgency.
 *
 * Every escalation requires at least 2 options. These are sensible defaults
 * that cover the most common response patterns for each type.
 */
function buildOptionsForType(
  type: EscalationType,
  urgency: EscalationUrgency,
): EscalationOption[] {
  switch (type) {
    case "security":
      return [
        { option_id: "opt-1", label: "Investigate and remediate", action: "investigate" },
        { option_id: "opt-2", label: "Accept risk and continue", action: "accept_risk" },
        { option_id: "opt-3", label: "Roll back changes", action: "rollback" },
      ];
    case "infrastructure":
      return [
        { option_id: "opt-1", label: "Retry with different configuration", action: "retry_reconfigure" },
        { option_id: "opt-2", label: "Investigate infrastructure issue", action: "investigate" },
        { option_id: "opt-3", label: "Skip and continue manually", action: "skip" },
      ];
    case "cost":
      return [
        { option_id: "opt-1", label: "Approve additional spend", action: "approve_cost" },
        { option_id: "opt-2", label: "Cancel to avoid cost", action: "cancel" },
        { option_id: "opt-3", label: "Find cheaper alternative", action: "alternative" },
      ];
    case "quality":
      return [
        { option_id: "opt-1", label: "Review and provide feedback", action: "review" },
        { option_id: "opt-2", label: "Accept current quality", action: "accept" },
        { option_id: "opt-3", label: "Request re-implementation", action: "redo" },
      ];
    case "technical":
      return [
        { option_id: "opt-1", label: "Provide guidance for retry", action: "guide_retry" },
        { option_id: "opt-2", label: "Take over implementation", action: "manual_takeover" },
        { option_id: "opt-3", label: "Skip this task", action: "skip" },
      ];
    case "product":
    default:
      return [
        { option_id: "opt-1", label: "Clarify requirements", action: "clarify" },
        { option_id: "opt-2", label: "Proceed with best interpretation", action: "proceed" },
      ];
  }
}

// ---------------------------------------------------------------------------
// EscalationEngine
// ---------------------------------------------------------------------------

/**
 * Main facade that orchestrates the full escalation flow:
 * classify -> build options -> format -> route -> start chain.
 *
 * All dependencies are constructor-injected for testability.
 */
export class EscalationEngine {
  constructor(
    private readonly classifier: EscalationClassifier,
    private readonly formatter: EscalationFormatter,
    private readonly routingEngine: RoutingEngine,
    private readonly chainManager: EscalationChainManager,
    private readonly auditTrail: AuditTrail,
  ) {}

  /**
   * Raise an escalation for a pipeline failure.
   *
   * Algorithm (per SPEC-009-2-4):
   *   1. Classify the failure context into type + urgency.
   *   2. Build default response options for the type.
   *   3. Resolve pipeline behavior for the type.
   *   4. Format the escalation message.
   *   5. Resolve routing target(s).
   *   6. Start the escalation chain (dispatch + timer).
   *   7. Return the result (message + pipeline behavior) to the caller.
   *
   * The caller (pipeline orchestrator) should act on `result.pipelineBehavior`.
   */
  raise(
    failureContext: FailureContext,
    requestContext: RequestContext,
  ): EscalationResult {
    // Step 1: Classify
    const { type, urgency } = this.classifier.classify(failureContext);

    // Step 2: Build options
    const options = buildOptionsForType(type, urgency);

    // Step 3: Resolve pipeline behavior
    const pipelineBehavior = resolvePipelineBehavior(type);

    // Step 4: Format the message
    const message = this.formatter.format({
      requestId: requestContext.requestId,
      repository: requestContext.repository,
      pipelinePhase: requestContext.pipelinePhase,
      escalationType: type,
      urgency,
      failureReason: failureContext.errorMessage,
      options,
      previousEscalationId: requestContext.previousEscalationId,
      retryCount: requestContext.retryCount,
      costImpact: failureContext.costData
        ? {
            estimated_cost: failureContext.costData.estimated,
            currency: "USD",
            threshold_exceeded:
              failureContext.costData.estimated > failureContext.costData.threshold,
          }
        : undefined,
    });

    // Step 5: Resolve routing
    const route = this.routingEngine.resolveRouting(type);

    // Step 6: Start the chain
    this.chainManager.startChain(message, route);

    // Step 7: Return result
    return { message, pipelineBehavior };
  }

  /**
   * Cancel all pending escalation chains for a given request ID.
   */
  cancelPending(requestId: string): void {
    this.chainManager.cancelAllPendingForRequest(requestId);
  }

  /**
   * Cancel all pending escalation chains globally.
   */
  cancelAllPending(): void {
    this.chainManager.cancelAllPending();
  }
}
