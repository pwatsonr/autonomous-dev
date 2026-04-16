/**
 * Rejection Workflow (SPEC-005-4-4, Task 10).
 *
 * Implements clean rejection of an agent improvement proposal,
 * returning the agent to ACTIVE state. Handles both:
 *   - Human-initiated rejection (operator reviews and rejects).
 *   - Automatic rejection (A/B validation produces negative verdict).
 *
 * Rejection steps:
 *   1. Validate: proposal must exist, agent must be in UNDER_REVIEW or VALIDATING state.
 *   2. Update proposal status to `rejected`.
 *   3. Transition agent state back to ACTIVE.
 *   4. Reset observation tracker (new invocation cycle required before next analysis).
 *   5. Log `agent_proposal_rejected` event to audit log.
 *   6. Emit rejection metric event.
 *
 * Exports: `Rejector`, `RejectionResult`
 */

import type { IAgentRegistry, AgentState } from '../types';
import type { AuditLogger } from '../audit';
import type { ObservationTracker } from '../metrics/observation';
import type { ProposalStore } from '../improvement/proposal-store';

// ---------------------------------------------------------------------------
// RejectionResult
// ---------------------------------------------------------------------------

/** Result of a rejection attempt. */
export interface RejectionResult {
  success: boolean;
  agentName: string;
  version: string;
  reason: string;
  proposalId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Dependencies injected into the Rejector. */
export interface RejectorDependencies {
  registry: IAgentRegistry;
  proposalStore: ProposalStore;
  auditLogger: AuditLogger;
  observationTracker: ObservationTracker;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logRejectorEvent(eventType: string, details: Record<string, unknown>): void {
  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...details,
  };
  process.stderr.write(`[REJECTOR] ${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// Valid states for rejection
// ---------------------------------------------------------------------------

/** Agent states from which rejection is allowed. */
const REJECTABLE_STATES: ReadonlySet<AgentState> = new Set([
  'UNDER_REVIEW',
  'VALIDATING',
]);

// ---------------------------------------------------------------------------
// Rejector
// ---------------------------------------------------------------------------

/**
 * Orchestrates the rejection workflow for agent improvement proposals.
 *
 * Handles both human-initiated and automatic (negative A/B) rejections.
 *
 * Usage:
 * ```ts
 * const rejector = new Rejector(deps);
 *
 * // Human-initiated rejection
 * const result = rejector.reject('code-executor', 'proposal-uuid', 'Quality regression in python domain');
 *
 * // Automatic rejection after negative A/B
 * const result = rejector.reject('code-executor', 'proposal-uuid', 'A/B validation negative verdict');
 * ```
 */
export class Rejector {
  private readonly registry: IAgentRegistry;
  private readonly proposalStore: ProposalStore;
  private readonly auditLogger: AuditLogger;
  private readonly observationTracker: ObservationTracker;

  constructor(deps: RejectorDependencies) {
    this.registry = deps.registry;
    this.proposalStore = deps.proposalStore;
    this.auditLogger = deps.auditLogger;
    this.observationTracker = deps.observationTracker;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Execute the rejection workflow for an agent improvement proposal.
   *
   * @param agentName   The name of the agent whose proposal is being rejected.
   * @param proposalId  The ID of the proposal to reject.
   * @param reason      Human-readable reason for the rejection.
   * @returns           RejectionResult indicating success or failure.
   */
  reject(agentName: string, proposalId: string, reason: string): RejectionResult {
    // Step 1: Validate
    const proposal = this.proposalStore.getById(proposalId);
    if (!proposal) {
      return this.failResult(
        agentName,
        '',
        reason,
        proposalId,
        `Proposal '${proposalId}' not found`,
      );
    }

    // Validate agent state
    const agentState = this.registry.getState(agentName);
    if (!agentState || !REJECTABLE_STATES.has(agentState)) {
      return this.failResult(
        agentName,
        proposal.current_version,
        reason,
        proposalId,
        `Agent must be in UNDER_REVIEW or VALIDATING state, current state: ${agentState ?? 'not found'}`,
      );
    }

    // Step 2: Update proposal status to rejected
    try {
      this.proposalStore.updateStatus(proposalId, 'rejected');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failResult(
        agentName,
        proposal.current_version,
        reason,
        proposalId,
        `Failed to update proposal status: ${message}`,
      );
    }

    // Step 3: Transition agent state back to ACTIVE
    try {
      this.registry.setState(agentName, 'ACTIVE');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logRejectorEvent('rejection_state_transition_failed', {
        agentName,
        proposalId,
        error: message,
      });
      // Continue despite state transition failure -- proposal is already rejected
    }

    // Step 4: Reset observation tracker
    this.observationTracker.resetForPromotion(agentName, proposal.current_version);

    // Step 5: Log agent_proposal_rejected event to audit log
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'agent_state_changed',
      agent_name: agentName,
      details: {
        event: 'agent_proposal_rejected',
        proposalId,
        reason,
        previousState: agentState,
        newState: 'ACTIVE',
        version: proposal.current_version,
      },
    });

    // Step 6: Emit rejection metric event
    logRejectorEvent('agent_proposal_rejected', {
      agentName,
      proposalId,
      reason,
      version: proposal.current_version,
    });

    return {
      success: true,
      agentName,
      version: proposal.current_version,
      reason,
      proposalId,
    };
  }

  /**
   * Automatically reject a proposal following a negative A/B validation verdict.
   *
   * This is a convenience method called by the orchestrator when A/B
   * validation produces a `negative` verdict. No human action is needed.
   *
   * The proposal's status is expected to be `validated_negative` at this point.
   * The status transition is: `validated_negative` -> `rejected`.
   *
   * @param agentName   The name of the agent.
   * @param proposalId  The ID of the proposal with negative A/B result.
   * @returns           RejectionResult indicating success or failure.
   */
  autoRejectOnNegativeAB(agentName: string, proposalId: string): RejectionResult {
    const reason = 'Automatic rejection: A/B validation produced negative verdict';
    return this.reject(agentName, proposalId, reason);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a failed RejectionResult.
   */
  private failResult(
    agentName: string,
    version: string,
    reason: string,
    proposalId: string,
    error: string,
  ): RejectionResult {
    logRejectorEvent('rejection_failed', { agentName, proposalId, error });
    return {
      success: false,
      agentName,
      version,
      reason,
      proposalId,
      error,
    };
  }
}
