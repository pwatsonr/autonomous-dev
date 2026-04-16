/**
 * Observation Trigger (SPEC-005-3-1, Task 1).
 *
 * Detects when an agent crosses the invocation threshold and produces
 * a TriggerDecision indicating whether performance analysis should be
 * initiated.  This is the entry point to the improvement lifecycle.
 *
 * Guard conditions:
 *   - FROZEN agents never trigger analysis.
 *   - Agents already UNDER_REVIEW, VALIDATING, or in CANARY state
 *     do not trigger duplicate analysis.
 *   - The threshold (global or per-agent override) must be reached.
 *
 * The trigger itself does not execute analysis; it only signals that
 * analysis should begin.  The MetricsEngine emits an 'analysis_triggered'
 * event which is handled by the analysis orchestrator (SPEC-005-3-2).
 *
 * Exports: `ObservationTrigger`
 */

import type { ObservationTracker } from '../metrics/observation';
import type { IAgentRegistry, AgentState } from '../types';
import type { AgentFactoryConfig } from '../config';
import type { AuditLogger } from '../audit';
import type { TriggerDecision } from './types';

// ---------------------------------------------------------------------------
// States that indicate analysis is already in progress
// ---------------------------------------------------------------------------

const IN_PROGRESS_STATES: ReadonlySet<AgentState> = new Set([
  'UNDER_REVIEW',
  'VALIDATING',
  'CANARY',
]);

// ---------------------------------------------------------------------------
// ObservationTrigger
// ---------------------------------------------------------------------------

export class ObservationTrigger {
  private readonly observationTracker: ObservationTracker;
  private readonly registry: IAgentRegistry;
  private readonly config: AgentFactoryConfig;
  private readonly auditLogger: AuditLogger;

  constructor(
    observationTracker: ObservationTracker,
    registry: IAgentRegistry,
    config: AgentFactoryConfig,
    auditLogger: AuditLogger,
  ) {
    this.observationTracker = observationTracker;
    this.registry = registry;
    this.config = config;
    this.auditLogger = auditLogger;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Check whether an agent should trigger performance analysis.
   *
   * Called after each metric record.  Steps:
   *   1. Record the invocation in the observation tracker.
   *   2. Guard: agent must not be FROZEN.
   *   3. Guard: no analysis already in progress.
   *   4. Check if threshold has been reached.
   *   5. Return a TriggerDecision.
   *
   * @param agentName     The name of the agent.
   * @param agentVersion  The current version of the agent.
   * @returns             A TriggerDecision indicating the outcome.
   */
  check(agentName: string, agentVersion: string): TriggerDecision {
    // Step 1: Record the invocation in the observation tracker
    const state = this.observationTracker.recordInvocation(
      agentName,
      agentVersion,
    );

    // Step 2: Guard — agent must not be FROZEN
    const agentState = this.registry.getState(agentName);
    if (agentState === 'FROZEN') {
      return {
        triggered: false,
        reason: 'agent is FROZEN',
        agentName,
        invocationCount: state.invocations_since_promotion,
        threshold: state.threshold,
      };
    }

    // Step 3: Guard — no analysis already in progress
    if (agentState !== undefined && IN_PROGRESS_STATES.has(agentState)) {
      return {
        triggered: false,
        reason: 'analysis already in progress',
        agentName,
        invocationCount: state.invocations_since_promotion,
        threshold: state.threshold,
      };
    }

    // Step 4: Check threshold
    if (state.status !== 'threshold_reached') {
      return {
        triggered: false,
        reason: 'threshold not reached',
        agentName,
        invocationCount: state.invocations_since_promotion,
        threshold: state.threshold,
      };
    }

    // Step 5: Threshold reached — trigger analysis
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'domain_gap_detected',
      agent_name: agentName,
      details: {
        trigger: 'observation_threshold_reached',
        invocation_count: state.invocations_since_promotion,
        threshold: state.threshold,
        agent_version: agentVersion,
      },
    });

    return {
      triggered: true,
      reason: 'threshold reached',
      agentName,
      invocationCount: state.invocations_since_promotion,
      threshold: state.threshold,
    };
  }

  /**
   * Force an analysis trigger, bypassing the invocation threshold.
   *
   * Used by `agent analyze --force` CLI command.  Still respects the
   * FROZEN guard (frozen agents cannot be force-analyzed).
   *
   * @param agentName  The name of the agent.
   * @returns          A TriggerDecision indicating the outcome.
   */
  forceCheck(agentName: string): TriggerDecision {
    // Guard: FROZEN agents cannot be force-analyzed
    const agentState = this.registry.getState(agentName);
    if (agentState === 'FROZEN') {
      return {
        triggered: false,
        reason: 'agent is FROZEN (cannot force frozen agents)',
        agentName,
        invocationCount: this.observationTracker.getState(agentName)
          .invocations_since_promotion,
        threshold: this.observationTracker.getState(agentName).threshold,
      };
    }

    // Force the threshold reached state
    const state = this.observationTracker.forceThresholdReached(agentName);

    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'domain_gap_detected',
      agent_name: agentName,
      details: {
        trigger: 'forced_by_operator',
        invocation_count: state.invocations_since_promotion,
        threshold: state.threshold,
      },
    });

    return {
      triggered: true,
      reason: 'forced by operator',
      agentName,
      invocationCount: state.invocations_since_promotion,
      threshold: state.threshold,
    };
  }
}
