/**
 * Re-Escalation Manager (SPEC-009-3-3, Task 6).
 *
 * Tracks chains of re-escalations that occur when a phase fails again
 * after human guidance was applied. Detects escalation loops when the
 * same issue has been re-escalated 3 or more times, at which point it
 * raises a meta-escalation routed to a secondary target with full
 * guidance history and a cancellation option.
 */

import type { EscalationEngine } from "./escalation-engine";
import type { FailureContext } from "./classifier";
import type {
  AuditTrail,
  EscalationMessage,
  EscalationOption,
  RequestContext,
} from "./types";

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single guidance attempt and its outcome. */
export interface GuidanceAttempt {
  escalationId: string;
  guidanceApplied: string;
  failureReason: string;
  timestamp: Date;
}

/** Tracks the full chain of re-escalations from an original escalation. */
export interface ReEscalationChain {
  originalEscalationId: string;
  /** Chronological list of all escalation IDs in the chain. */
  escalationIds: string[];
  /** Number of re-escalations (incremented each time guidance fails). */
  count: number;
  guidanceHistory: GuidanceAttempt[];
}

// ---------------------------------------------------------------------------
// Loop detection threshold
// ---------------------------------------------------------------------------

/** Re-escalation count at which loop detection triggers. */
const LOOP_DETECTION_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// ReEscalationManager
// ---------------------------------------------------------------------------

/**
 * Manages re-escalation chains and detects escalation loops.
 *
 * When a pipeline phase fails after human guidance was applied, this
 * manager creates a new escalation linked to the previous one. If the
 * same original escalation has been re-escalated 3+ times, a loop is
 * detected and a meta-escalation is raised that:
 *   - Routes to the secondary target (bypasses primary)
 *   - Includes the full guidance history
 *   - Offers a cancellation option
 *   - Emits a `re_escalation_loop_detected` audit event
 */
export class ReEscalationManager {
  private chains: Map<string, ReEscalationChain> = new Map();

  constructor(
    private readonly escalationEngine: EscalationEngine,
    private readonly auditTrail: AuditTrail,
  ) {}

  /**
   * Called when a phase fails after human guidance was applied.
   *
   * @param originalEscalationId  The ID of the first escalation in the chain.
   * @param failureContext        The failure that occurred after guidance.
   * @param requestContext        Pipeline request context.
   * @param guidanceApplied       Description of the guidance that was applied.
   * @returns The new escalation message (either normal or loop-detected).
   */
  handlePostGuidanceFailure(
    originalEscalationId: string,
    failureContext: FailureContext,
    requestContext: RequestContext,
    guidanceApplied: string,
  ): EscalationMessage {
    // Step 1: Get or create chain
    const chain = this.getOrCreateChain(originalEscalationId);

    // Step 2: Increment count
    chain.count++;

    // Step 3: Record the guidance attempt
    const latestEscalationId =
      chain.escalationIds.length > 0
        ? chain.escalationIds[chain.escalationIds.length - 1]
        : originalEscalationId;

    chain.guidanceHistory.push({
      escalationId: latestEscalationId,
      guidanceApplied,
      failureReason: failureContext.errorMessage,
      timestamp: new Date(),
    });

    // Step 4: Check for loop detection
    if (chain.count >= LOOP_DETECTION_THRESHOLD) {
      return this.raiseLoopDetectedEscalation(chain, failureContext, requestContext);
    }

    // Step 5-9: Normal re-escalation
    const enrichedContext: RequestContext = {
      ...requestContext,
      previousEscalationId: latestEscalationId,
    };

    const result = this.escalationEngine.raise(failureContext, enrichedContext);
    chain.escalationIds.push(result.message.escalation_id);

    return result.message;
  }

  /**
   * Get the re-escalation count for an escalation chain.
   *
   * @param originalEscalationId  The ID of the first escalation in the chain.
   * @returns The number of re-escalations, or 0 if no chain exists.
   */
  getReEscalationCount(originalEscalationId: string): number {
    const chain = this.chains.get(originalEscalationId);
    return chain ? chain.count : 0;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Get an existing chain or create a new one for the given original ID.
   */
  private getOrCreateChain(originalEscalationId: string): ReEscalationChain {
    let chain = this.chains.get(originalEscalationId);
    if (!chain) {
      chain = {
        originalEscalationId,
        escalationIds: [originalEscalationId],
        count: 0,
        guidanceHistory: [],
      };
      this.chains.set(originalEscalationId, chain);
    }
    return chain;
  }

  /**
   * Raise a loop-detected meta-escalation.
   *
   * This bypasses normal primary routing by enriching the context with
   * loop metadata. The escalation engine handles routing, but the
   * summary and options are overridden here.
   */
  private raiseLoopDetectedEscalation(
    chain: ReEscalationChain,
    failureContext: FailureContext,
    requestContext: RequestContext,
  ): EscalationMessage {
    const latestEscalationId =
      chain.escalationIds[chain.escalationIds.length - 1];

    // Build the enriched context for the meta-escalation
    const enrichedContext: RequestContext = {
      ...requestContext,
      previousEscalationId: latestEscalationId,
    };

    // Raise the base escalation through the engine
    const result = this.escalationEngine.raise(failureContext, enrichedContext);
    const message = result.message;

    // Override summary with loop detection notice
    message.summary =
      `[LOOP DETECTED] This issue has been escalated ${chain.count} times without resolution.`;

    // Build guidance history text for technical_details
    const guidanceHistoryText = chain.guidanceHistory
      .map(
        (attempt, index) =>
          `Attempt ${index + 1}: Applied "${attempt.guidanceApplied}" -> Failed: "${attempt.failureReason}"`,
      )
      .join("\n");

    message.technical_details =
      `Re-escalation loop detected after ${chain.count} attempts.\n\n` +
      `Guidance History:\n${guidanceHistoryText}`;

    // Ensure cancellation option is present
    const hasCancelOption = message.options.some(
      (opt) => opt.action === "cancel",
    );
    if (!hasCancelOption) {
      message.options.push({
        option_id: "opt-cancel",
        label: "Cancel this request",
        action: "cancel",
        description: "Stop attempting to resolve this issue",
      });
    }

    // Track the new escalation in the chain
    chain.escalationIds.push(message.escalation_id);

    // Emit audit event
    void this.auditTrail.append({
      event_type: "re_escalation_loop_detected",
      payload: {
        originalEscalationId: chain.originalEscalationId,
        count: chain.count,
        guidanceHistory: chain.guidanceHistory.map((attempt) => ({
          escalationId: attempt.escalationId,
          guidanceApplied: attempt.guidanceApplied,
          failureReason: attempt.failureReason,
          timestamp: attempt.timestamp.toISOString(),
        })),
      },
    });

    return message;
  }
}
