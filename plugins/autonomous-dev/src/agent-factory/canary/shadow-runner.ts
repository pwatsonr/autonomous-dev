/**
 * Canary Shadow Runner (SPEC-005-5-1 Task 2, SPEC-005-5-2 Tasks 3-4).
 *
 * Executes the proposed agent version alongside the current version on
 * every new production invocation during the canary period. The shadow
 * runner has zero production impact: only the current agent's output is
 * returned to the pipeline.
 *
 * Shadow execution flow:
 *   1. Check for active canary.
 *   2. If canary expired: trigger exit evaluation (promote/reject/terminate).
 *   3. Run current version (primary) -- output returned to pipeline.
 *   4. Run proposed version (shadow) -- output discarded from pipeline.
 *   5. Score both outputs using the appropriate reviewer agent.
 *   6. Record comparison with delta and per-dimension deltas.
 *   7. Call exitEvaluator.evaluateImmediate() for catastrophic regression check.
 *   8. On terminate: set auto_rollback, transition to REJECTED, update proposal,
 *      send critical notification.
 *
 * Token cost: Shadow runs double the per-invocation cost during canary.
 * Shadow invocations are tagged `environment: 'canary'` for separate tracking.
 *
 * Exports: `CanaryShadowRunner`, `ShadowResult`
 */

import * as crypto from 'crypto';

import type { AgentRecord, AgentRole, IAgentRegistry, ParsedAgent, RuntimeContext } from '../types';
import type { IMetricsEngine, InvocationMetric, ToolCallRecord } from '../metrics/types';
import type { AuditLogger } from '../audit';
import type { ProposalStore } from '../improvement/proposal-store';
import type {
  CanaryStateManager,
  CanaryComparison,
} from './state-manager';
import { generateComparisonId } from './state-manager';
import type { CanaryExitEvaluator, ExitDecision } from './exit-evaluator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a shadow invocation intercept. */
export interface ShadowResult {
  /** Whether a canary was active and shadow execution occurred. */
  canary_active: boolean;
  /** Output from the current agent version -- always used by the pipeline. */
  current_output: string;
  /** Output from the proposed agent version (shadow). Discarded from pipeline. */
  proposed_output?: string;
  /** Comparison result if shadow execution occurred. */
  comparison?: CanaryComparison;
  /** Exit decision from the evaluator, if one was triggered (SPEC-005-5-2). */
  exit_decision?: ExitDecision;
}

// ---------------------------------------------------------------------------
// Notification service interface (SPEC-005-5-2)
// ---------------------------------------------------------------------------

/**
 * Notification sent to operators on critical canary events.
 */
export interface CanaryNotification {
  severity: 'info' | 'warning' | 'critical';
  message: string;
}

/**
 * Interface for sending operator notifications.
 * The shadow runner sends notifications on catastrophic regression
 * and canary completion/rejection events.
 */
export interface NotificationService {
  send(notification: CanaryNotification): void;
}

// ---------------------------------------------------------------------------
// Agent invoker interface
// ---------------------------------------------------------------------------

/**
 * Abstraction over agent invocation. The shadow runner delegates actual
 * execution to an implementation of this interface, keeping the runner
 * testable without real model calls.
 */
export interface ShadowAgentInvoker {
  invoke(
    agent: AgentRecord,
    input: string,
    environment: 'production' | 'canary',
  ): Promise<ShadowInvokeResult>;
}

/** Raw result from the agent invoker. */
export interface ShadowInvokeResult {
  success: boolean;
  output: string;
  input_tokens: number;
  output_tokens: number;
  wall_clock_ms: number;
  turn_count: number;
  tool_calls: ToolCallRecord[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Reviewer invoker interface
// ---------------------------------------------------------------------------

/**
 * Abstraction for invoking a reviewer agent to score outputs.
 * Single scoring round (not median-of-3) to limit token cost during canary.
 */
export interface ShadowReviewerInvoker {
  /**
   * Score two outputs against an evaluation rubric.
   *
   * @param reviewerName  The reviewer agent to invoke.
   * @param input         The original input that produced both outputs.
   * @param output1       First output (labels stripped; no version info).
   * @param output2       Second output (labels stripped; no version info).
   * @param rubric        The evaluation rubric dimensions.
   * @returns             Per-dimension scores for each output and overall scores.
   */
  score(
    reviewerName: string,
    input: string,
    output1: string,
    output2: string,
    rubric: Array<{ name: string; weight: number; description: string }>,
  ): Promise<ScoringOutput>;
}

/** Structured scoring output from the reviewer. */
export interface ScoringOutput {
  output_1_scores: Record<string, number>;
  output_1_overall: number;
  output_2_scores: Record<string, number>;
  output_2_overall: number;
}

// ---------------------------------------------------------------------------
// Reviewer selection map (matches blind-scorer.ts pattern)
// ---------------------------------------------------------------------------

const REVIEWER_MAP: Record<AgentRole, string> = {
  author: 'doc-reviewer',
  executor: 'quality-reviewer',
  reviewer: 'architecture-reviewer',
  meta: 'architecture-reviewer',
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tie threshold: absolute delta must exceed this for a win/loss. */
const TIE_THRESHOLD = 0.2;

// ---------------------------------------------------------------------------
// CanaryShadowRunner
// ---------------------------------------------------------------------------

export class CanaryShadowRunner {
  private readonly canaryManager: CanaryStateManager;
  private readonly exitEvaluator: CanaryExitEvaluator;
  private readonly registry: IAgentRegistry;
  private readonly metricsEngine: IMetricsEngine;
  private readonly auditLogger: AuditLogger;
  private readonly proposalStore: ProposalStore;
  private readonly agentInvoker: ShadowAgentInvoker;
  private readonly reviewerInvoker: ShadowReviewerInvoker;
  private readonly notificationService: NotificationService | null;

  constructor(
    canaryManager: CanaryStateManager,
    exitEvaluator: CanaryExitEvaluator,
    registry: IAgentRegistry,
    metricsEngine: IMetricsEngine,
    auditLogger: AuditLogger,
    proposalStore: ProposalStore,
    agentInvoker: ShadowAgentInvoker,
    reviewerInvoker: ShadowReviewerInvoker,
    notificationService?: NotificationService,
  ) {
    this.canaryManager = canaryManager;
    this.exitEvaluator = exitEvaluator;
    this.registry = registry;
    this.metricsEngine = metricsEngine;
    this.auditLogger = auditLogger;
    this.proposalStore = proposalStore;
    this.agentInvoker = agentInvoker;
    this.reviewerInvoker = reviewerInvoker;
    this.notificationService = notificationService ?? null;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Hook into agent invocation: check if canary is active, run shadow if so.
   *
   * This method should be called on every production invocation of an agent.
   * If a canary is active, it runs the proposed version in shadow mode
   * alongside the current version and records the comparison.
   *
   * The current agent's output is ALWAYS returned as `current_output`,
   * regardless of canary status. The proposed output is never used by the
   * pipeline.
   *
   * @param agentName  The name of the agent being invoked.
   * @param input      The input text for the agent.
   * @param context    The runtime context for the invocation.
   * @returns          ShadowResult with current output and optional comparison.
   */
  async interceptInvocation(
    agentName: string,
    input: string,
    context: RuntimeContext,
  ): Promise<ShadowResult> {
    // Step 1: Check for active canary
    const canaryState = this.canaryManager.getActiveCanary(agentName);

    if (!canaryState) {
      // No active canary -- pass through without shadow run.
      const currentAgent = this.registry.get(agentName);
      if (!currentAgent) {
        return { canary_active: false, current_output: '' };
      }

      const currentResult = await this.agentInvoker.invoke(
        currentAgent,
        input,
        'production',
      );

      return {
        canary_active: false,
        current_output: currentResult.output,
      };
    }

    // Check if canary has expired -- trigger exit evaluation (SPEC-005-5-2)
    if (this.canaryManager.isExpired(agentName)) {
      const decision = this.exitEvaluator.evaluate(agentName);
      await this.handleExitDecision(agentName, canaryState.proposal_id, decision);

      // Run current version only (no more shadow runs after expiry)
      const currentAgent = this.registry.get(agentName);
      if (!currentAgent) {
        return { canary_active: false, current_output: '', exit_decision: decision };
      }

      const currentResult = await this.agentInvoker.invoke(
        currentAgent,
        input,
        'production',
      );

      return {
        canary_active: false,
        current_output: currentResult.output,
        exit_decision: decision,
      };
    }

    // Active canary: run both versions
    const currentAgent = this.registry.get(agentName);
    if (!currentAgent) {
      return { canary_active: false, current_output: '' };
    }

    // Step 2: Run current version (primary)
    const currentResult = await this.agentInvoker.invoke(
      currentAgent,
      input,
      'production',
    );

    // Record current invocation metric with environment: 'production'
    this.recordInvocationMetric(
      agentName,
      canaryState.current_version,
      input,
      currentResult,
      'production',
      context,
    );

    // Step 3: Run proposed version (shadow)
    const proposedAgent = this.buildProposedAgentRecord(
      currentAgent,
      canaryState.proposed_version,
    );

    let proposedResult: ShadowInvokeResult;
    let shadowFailed = false;
    try {
      proposedResult = await this.agentInvoker.invoke(
        proposedAgent,
        input,
        'canary',
      );
    } catch (err) {
      // Shadow run failure does NOT affect production
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Shadow run failed for '${agentName}': ${message}\n`,
      );
      shadowFailed = true;
      proposedResult = {
        success: false,
        output: '',
        input_tokens: 0,
        output_tokens: 0,
        wall_clock_ms: 0,
        turn_count: 0,
        tool_calls: [],
        error: message,
      };
    }

    // Record proposed invocation metric with environment: 'canary'
    this.recordInvocationMetric(
      agentName,
      canaryState.proposed_version,
      input,
      proposedResult,
      'canary',
      context,
    );

    // Step 4 & 5: Score both outputs and record comparison
    let comparison: CanaryComparison;

    if (shadowFailed || !proposedResult.success) {
      // Shadow failure: record as proposed_loss with score 0
      const inputHash = hashString(input);
      comparison = {
        comparison_id: generateComparisonId(),
        timestamp: new Date().toISOString(),
        input_hash: inputHash,
        current_score: 0,
        proposed_score: 0,
        delta: 0,
        per_dimension: {},
        outcome: 'current_wins',
      };

      // If we at least got the current output scored, use that
      if (currentResult.success) {
        comparison.current_score = 3.0; // neutral default for comparison
        comparison.proposed_score = 1.0; // minimum for failed output
        comparison.delta = -2.0;
        comparison.outcome = 'current_wins';
      }
    } else {
      // Both succeeded: score with reviewer
      comparison = await this.scoreAndCompare(
        agentName,
        currentAgent,
        input,
        currentResult.output,
        proposedResult.output,
      );
    }

    // Record the comparison in the canary state
    try {
      this.canaryManager.addComparison(agentName, comparison);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Failed to record comparison for '${agentName}': ${message}\n`,
      );
    }

    // Step 7: Call evaluateImmediate for catastrophic regression check (SPEC-005-5-2)
    const immediate = this.exitEvaluator.evaluateImmediate(agentName, comparison);
    let exitDecision: ExitDecision | undefined;

    if (immediate.action === 'terminate') {
      await this.handleTermination(agentName, canaryState.proposal_id, comparison, immediate);
      exitDecision = immediate;
    }

    return {
      canary_active: true,
      current_output: currentResult.output,
      proposed_output: proposedResult.output,
      comparison,
      exit_decision: exitDecision,
    };
  }

  // -------------------------------------------------------------------------
  // Private: scoring and comparison
  // -------------------------------------------------------------------------

  /**
   * Score both outputs using the appropriate reviewer agent and build
   * the comparison result.
   *
   * Uses a single scoring round (not median-of-3) to limit token cost.
   */
  private async scoreAndCompare(
    agentName: string,
    currentAgent: AgentRecord,
    input: string,
    currentOutput: string,
    proposedOutput: string,
  ): Promise<CanaryComparison> {
    const inputHash = hashString(input);
    const role = currentAgent.agent.role;
    const reviewerName = REVIEWER_MAP[role];
    const rubric = currentAgent.agent.evaluation_rubric;

    try {
      const scoringResult = await this.reviewerInvoker.score(
        reviewerName,
        input,
        currentOutput,
        proposedOutput,
        rubric,
      );

      const currentScore = scoringResult.output_1_overall;
      const proposedScore = scoringResult.output_2_overall;
      const delta = proposedScore - currentScore;

      // Compute per-dimension deltas
      const perDimension: Record<string, number> = {};
      for (const dim of rubric) {
        const currentDimScore = scoringResult.output_1_scores[dim.name] ?? 0;
        const proposedDimScore = scoringResult.output_2_scores[dim.name] ?? 0;
        perDimension[dim.name] = proposedDimScore - currentDimScore;
      }

      // Classify outcome using 0.2 threshold
      let outcome: 'proposed_wins' | 'current_wins' | 'tie';
      if (delta > TIE_THRESHOLD) {
        outcome = 'proposed_wins';
      } else if (delta < -TIE_THRESHOLD) {
        outcome = 'current_wins';
      } else {
        outcome = 'tie';
      }

      return {
        comparison_id: generateComparisonId(),
        timestamp: new Date().toISOString(),
        input_hash: inputHash,
        current_score: currentScore,
        proposed_score: proposedScore,
        delta,
        per_dimension: perDimension,
        outcome,
      };
    } catch (err) {
      // Scoring failure: record with default scores
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Scoring failed for '${agentName}': ${message}\n`,
      );

      return {
        comparison_id: generateComparisonId(),
        timestamp: new Date().toISOString(),
        input_hash: inputHash,
        current_score: 0,
        proposed_score: 0,
        delta: 0,
        per_dimension: {},
        outcome: 'tie',
      };
    }
  }

  // -------------------------------------------------------------------------
  // Private: exit decision handling (SPEC-005-5-2)
  // -------------------------------------------------------------------------

  /**
   * Handle a canary exit decision from the full evaluator.
   *
   * Called when the canary period has expired and the evaluator
   * produces a promote, reject, or terminate decision.
   */
  private async handleExitDecision(
    agentName: string,
    proposalId: string,
    decision: ExitDecision,
  ): Promise<void> {
    switch (decision.action) {
      case 'promote':
        this.canaryManager.completeCanary(agentName, 'completed_positive');

        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          event_type: 'agent_state_changed',
          agent_name: agentName,
          details: {
            event: 'canary_promote_decision',
            proposal_id: proposalId,
            reason: decision.reason,
          },
        });

        if (this.notificationService) {
          this.notificationService.send({
            severity: 'info',
            message: `Canary completed for ${agentName}: ${decision.reason}. Proceed to promotion.`,
          });
        }
        break;

      case 'reject':
        this.canaryManager.completeCanary(agentName, 'completed_negative');
        this.registry.setState(agentName, 'REJECTED');
        this.safeUpdateProposalStatus(proposalId, 'rejected');

        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          event_type: 'agent_state_changed',
          agent_name: agentName,
          details: {
            event: 'canary_reject_decision',
            proposal_id: proposalId,
            reason: decision.reason,
          },
        });

        if (this.notificationService) {
          this.notificationService.send({
            severity: 'warning',
            message: `Canary rejected for ${agentName}: ${decision.reason}`,
          });
        }
        break;

      case 'terminate':
        // Should not normally happen via full evaluation (catastrophic is caught
        // in evaluateImmediate), but handle gracefully.
        this.canaryManager.terminateCanary(agentName);
        this.registry.setState(agentName, 'REJECTED');
        this.safeUpdateProposalStatus(proposalId, 'rejected');

        if (this.notificationService) {
          this.notificationService.send({
            severity: 'critical',
            message: `Canary terminated for ${agentName}: ${decision.reason}`,
          });
        }
        break;

      case 'wait':
        // Should not happen for expired canary, log and skip.
        process.stderr.write(
          `[CANARY] Unexpected 'wait' decision for expired canary of '${agentName}': ${decision.reason}\n`,
        );
        break;
    }
  }

  /**
   * Handle catastrophic regression termination (SPEC-005-5-2).
   *
   * Called by interceptInvocation when evaluateImmediate returns 'terminate'.
   * Performs the full termination sequence:
   *   - Terminate canary (sets auto_rollback_triggered = true)
   *   - Transition agent to REJECTED
   *   - Update proposal status to 'rejected'
   *   - Log canary_catastrophic_regression audit event
   *   - Send critical operator notification
   */
  private async handleTermination(
    agentName: string,
    proposalId: string,
    comparison: CanaryComparison,
    decision: ExitDecision,
  ): Promise<void> {
    process.stderr.write(
      `[CANARY] CATASTROPHIC REGRESSION detected for '${agentName}': ` +
      `delta=${comparison.delta.toFixed(2)}\n`,
    );

    // Terminate the canary (sets auto_rollback_triggered = true)
    try {
      this.canaryManager.terminateCanary(agentName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Failed to terminate canary for '${agentName}': ${message}\n`,
      );
    }

    // Transition agent to REJECTED state (AC-7)
    try {
      this.registry.setState(agentName, 'REJECTED');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Failed to transition '${agentName}' to REJECTED: ${message}\n`,
      );
    }

    // Update proposal status to rejected (AC-8)
    this.safeUpdateProposalStatus(proposalId, 'rejected');

    // Critical audit event logged on catastrophic regression (AC-9)
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'agent_state_changed',
      agent_name: agentName,
      details: {
        event: 'canary_catastrophic_regression',
        comparison_id: comparison.comparison_id,
        current_score: comparison.current_score,
        proposed_score: comparison.proposed_score,
        delta: comparison.delta,
        reason: decision.reason,
        proposal_id: proposalId,
      },
    });

    // Operator notification sent on catastrophic regression (AC-10)
    if (this.notificationService) {
      this.notificationService.send({
        severity: 'critical',
        message: `Canary terminated for ${agentName}: ${decision.reason}`,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Private: proposal store helper
  // -------------------------------------------------------------------------

  /**
   * Safely update proposal status to 'rejected'.
   *
   * Catches errors since proposal store may enforce state machine rules
   * and the proposal may already be in a terminal state.
   */
  private safeUpdateProposalStatus(
    proposalId: string,
    status: 'rejected',
  ): void {
    try {
      this.proposalStore.updateStatus(proposalId, status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Failed to update proposal '${proposalId}' to '${status}': ${message}\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: metrics recording
  // -------------------------------------------------------------------------

  /**
   * Record an invocation metric for either the current or proposed run.
   */
  private recordInvocationMetric(
    agentName: string,
    agentVersion: string,
    input: string,
    result: ShadowInvokeResult,
    environment: 'production' | 'canary',
    context: RuntimeContext,
  ): void {
    try {
      const metric: InvocationMetric = {
        invocation_id: crypto.randomUUID(),
        agent_name: agentName,
        agent_version: agentVersion,
        pipeline_run_id: null,
        input_hash: hashString(input),
        input_domain: '',
        input_tokens: result.input_tokens,
        output_hash: hashString(result.output),
        output_tokens: result.output_tokens,
        output_quality_score: 0,
        quality_dimensions: [],
        review_iteration_count: 0,
        review_outcome: 'not_reviewed',
        reviewer_agent: null,
        wall_clock_ms: result.wall_clock_ms,
        turn_count: result.turn_count,
        tool_calls: result.tool_calls,
        timestamp: new Date().toISOString(),
        environment,
      };

      this.metricsEngine.record(metric);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[CANARY] Failed to record metric for '${agentName}' (${environment}): ${message}\n`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private: proposed agent construction
  // -------------------------------------------------------------------------

  /**
   * Build a temporary AgentRecord for the proposed version.
   *
   * Uses the current agent's definition as a base and updates the version.
   * The proposed definition is loaded from the proposal store via the
   * canary state.
   */
  private buildProposedAgentRecord(
    currentAgent: AgentRecord,
    proposedVersion: string,
  ): AgentRecord {
    const proposedParsed: ParsedAgent = {
      ...currentAgent.agent,
      version: proposedVersion,
    };

    return {
      agent: proposedParsed,
      state: 'CANARY',
      loadedAt: new Date(),
      diskHash: '',
      filePath: currentAgent.filePath,
    };
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of a string.
 */
function hashString(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf-8').digest('hex');
}
