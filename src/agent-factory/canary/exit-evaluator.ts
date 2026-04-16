/**
 * Canary Exit Evaluator and Auto-Termination (SPEC-005-5-2, Tasks 3-4).
 *
 * Determines when and how a canary period should end based on accumulated
 * comparison results, and provides the immediate catastrophic regression
 * check that triggers auto-termination without waiting for the full period.
 *
 * Evaluation algorithm:
 *   Step 1: Check for catastrophic regression (immediate, every comparison).
 *   Step 2: Check minimum comparisons met.
 *   Step 3: Compute win/loss rates.
 *   Step 4: Evaluate based on canary period expiry status.
 *
 * Key rules:
 *   - Early promotion is NOT supported -- full period must complete for promote.
 *   - Early rejection IS supported when loss rate >= threshold.
 *   - Catastrophic regression (> threshold delta) triggers immediate termination
 *     regardless of comparison count.
 *   - Inconclusive results at end of period default to rejection.
 *
 * Exports: `CanaryExitEvaluator`, `ExitDecision`, `CanaryExitCriteria`
 */

import type { AgentFactoryConfig } from '../config';
import type { AuditLogger } from '../audit';
import type { CanaryStateManager, CanaryComparison } from './state-manager';

// ---------------------------------------------------------------------------
// ExitDecision
// ---------------------------------------------------------------------------

/**
 * The four possible outcomes of a canary exit evaluation.
 *
 * - `promote`: Canary period complete and proposed version wins. Proceed
 *   to promotion (auto or human depending on config).
 * - `reject`: Proposed version is losing. Stop the canary and reject.
 * - `terminate`: Catastrophic regression detected. Immediate abort with
 *   auto-rollback.
 * - `wait`: Not enough data or canary still in progress. Continue
 *   collecting comparisons.
 */
export type ExitDecision =
  | { action: 'promote'; reason: string }
  | { action: 'reject'; reason: string }
  | { action: 'terminate'; reason: string }
  | { action: 'wait'; reason: string };

// ---------------------------------------------------------------------------
// CanaryExitCriteria
// ---------------------------------------------------------------------------

/**
 * Configurable thresholds for canary exit evaluation.
 */
export interface CanaryExitCriteria {
  /**
   * Minimum win rate (proposed_wins / total) for promotion.
   * Default: 0.60 (60%).
   */
  winThreshold: number;

  /**
   * Loss rate (current_wins / total) that triggers rejection.
   * Default: 0.40 (40%).
   */
  lossThreshold: number;

  /**
   * Maximum negative delta that triggers immediate termination.
   * A comparison with `delta < -catastrophicRegressionDelta` is
   * considered catastrophic. Uses strict less-than (not <=).
   * Default: 1.5.
   */
  catastrophicRegressionDelta: number;

  /**
   * Minimum number of comparisons before win/loss evaluation applies.
   * Does NOT apply to catastrophic regression checks.
   * Default: 3.
   */
  minComparisons: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_EXIT_CRITERIA: CanaryExitCriteria = {
  winThreshold: 0.60,
  lossThreshold: 0.40,
  catastrophicRegressionDelta: 1.5,
  minComparisons: 3,
};

// ---------------------------------------------------------------------------
// CanaryExitEvaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates canary comparison data to determine exit decisions.
 *
 * Two evaluation modes:
 *   - `evaluateImmediate()`: Called after EVERY comparison. Checks only for
 *     catastrophic regression. Returns `terminate` or `wait`.
 *   - `evaluate()`: Full evaluation including win/loss rates and period
 *     expiry. Called when checking for canary completion.
 *
 * Usage:
 * ```ts
 * const evaluator = new CanaryExitEvaluator(canaryManager, config, auditLogger);
 *
 * // After each comparison:
 * const immediate = evaluator.evaluateImmediate('code-executor', comparison);
 * if (immediate.action === 'terminate') { ... }
 *
 * // On period check:
 * const decision = evaluator.evaluate('code-executor');
 * switch (decision.action) { ... }
 * ```
 */
export class CanaryExitEvaluator {
  private readonly canaryManager: CanaryStateManager;
  private readonly config: AgentFactoryConfig;
  private readonly auditLogger: AuditLogger;
  private readonly criteria: CanaryExitCriteria;

  constructor(
    canaryManager: CanaryStateManager,
    config: AgentFactoryConfig,
    auditLogger: AuditLogger,
    criteriaOverrides?: Partial<CanaryExitCriteria>,
  ) {
    this.canaryManager = canaryManager;
    this.config = config;
    this.auditLogger = auditLogger;

    // Merge overrides with defaults, then check config for any
    // canary exit criteria settings.
    this.criteria = {
      ...DEFAULT_EXIT_CRITERIA,
      ...this.resolveConfigCriteria(),
      ...criteriaOverrides,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Full canary exit evaluation.
   *
   * Runs the complete 4-step evaluation algorithm:
   *   1. Catastrophic regression check on all comparisons.
   *   2. Minimum comparisons check.
   *   3. Win/loss rate computation.
   *   4. Period-aware decision (promote only if expired, early reject allowed).
   *
   * @param agentName  The agent to evaluate.
   * @returns          ExitDecision with action and reason.
   */
  evaluate(agentName: string): ExitDecision {
    const canaryState = this.canaryManager.getActiveCanary(agentName);
    if (!canaryState) {
      // Also check non-active canaries for a final evaluation on expiry
      const anyCanary = this.canaryManager.getCanary(agentName);
      if (!anyCanary) {
        return { action: 'wait', reason: `No canary found for '${agentName}'` };
      }
      // If the canary is already completed/terminated, return wait (no action needed)
      return {
        action: 'wait',
        reason: `Canary for '${agentName}' is in '${anyCanary.status}' state, not active`,
      };
    }

    const comparisons = canaryState.comparisons;

    // Step 1: Check for catastrophic regression across all comparisons
    for (const comparison of comparisons) {
      if (comparison.delta < -this.criteria.catastrophicRegressionDelta) {
        return {
          action: 'terminate',
          reason: `Catastrophic regression: proposed scored ${Math.abs(comparison.delta).toFixed(1)} points below current on input ${comparison.input_hash.substring(0, 8)}`,
        };
      }
    }

    // Step 2: Check minimum comparisons
    if (comparisons.length < this.criteria.minComparisons) {
      return {
        action: 'wait',
        reason: `Minimum comparisons not met: ${comparisons.length}/${this.criteria.minComparisons}`,
      };
    }

    // Step 3: Compute win/loss rates
    const proposedWins = comparisons.filter(
      (c) => c.outcome === 'proposed_wins',
    ).length;
    const currentWins = comparisons.filter(
      (c) => c.outcome === 'current_wins',
    ).length;
    const total = comparisons.length;
    const winRate = proposedWins / total;
    const lossRate = currentWins / total;

    // Step 4: Evaluate based on canary period
    const isExpired = this.canaryManager.isExpired(agentName);

    if (isExpired) {
      // Canary period complete -- make final decision
      if (winRate >= this.criteria.winThreshold) {
        return {
          action: 'promote',
          reason: `Canary complete: proposed wins ${(winRate * 100).toFixed(0)}% of comparisons`,
        };
      } else if (lossRate >= this.criteria.lossThreshold) {
        return {
          action: 'reject',
          reason: `Canary complete: proposed loses ${(lossRate * 100).toFixed(0)}% of comparisons`,
        };
      } else {
        // Inconclusive results at end of period -> reject
        const ties = total - proposedWins - currentWins;
        return {
          action: 'reject',
          reason: `Canary complete: inconclusive results (${proposedWins}W/${currentWins}L/${ties}T)`,
        };
      }
    }

    // Canary still active -- check for early rejection
    if (lossRate >= this.criteria.lossThreshold) {
      return {
        action: 'reject',
        reason: `Early rejection: proposed losing ${(lossRate * 100).toFixed(0)}% of comparisons`,
      };
    }

    // Continue canary -- no early promotion allowed
    return {
      action: 'wait',
      reason: `Canary in progress: ${proposedWins}W/${currentWins}L, ${total} comparisons`,
    };
  }

  /**
   * Immediate catastrophic regression check.
   *
   * Called after EVERY comparison, regardless of minimum comparison count.
   * A single catastrophic regression (delta < -threshold) triggers
   * immediate termination.
   *
   * @param agentName         The agent being evaluated.
   * @param latestComparison  The most recent comparison result.
   * @returns                 `terminate` if catastrophic, `wait` otherwise.
   */
  evaluateImmediate(
    agentName: string,
    latestComparison: CanaryComparison,
  ): ExitDecision {
    if (latestComparison.delta < -this.criteria.catastrophicRegressionDelta) {
      const reason = `Catastrophic regression: proposed scored ${Math.abs(latestComparison.delta).toFixed(1)} points below current on input ${latestComparison.input_hash.substring(0, 8)}`;

      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'agent_state_changed',
        agent_name: agentName,
        details: {
          event: 'canary_catastrophic_regression_detected',
          comparison_id: latestComparison.comparison_id,
          current_score: latestComparison.current_score,
          proposed_score: latestComparison.proposed_score,
          delta: latestComparison.delta,
          threshold: -this.criteria.catastrophicRegressionDelta,
          input_hash: latestComparison.input_hash,
        },
      });

      return { action: 'terminate', reason };
    }

    return {
      action: 'wait',
      reason: `No catastrophic regression (delta: ${latestComparison.delta.toFixed(2)}, threshold: -${this.criteria.catastrophicRegressionDelta})`,
    };
  }

  /**
   * Get the current exit criteria (for testing and inspection).
   */
  getCriteria(): Readonly<CanaryExitCriteria> {
    return { ...this.criteria };
  }

  // -------------------------------------------------------------------------
  // Private: configuration resolution
  // -------------------------------------------------------------------------

  /**
   * Resolve exit criteria from the AgentFactoryConfig.
   *
   * Looks for `config.canary.exitCriteria.*` fields if present.
   */
  private resolveConfigCriteria(): Partial<CanaryExitCriteria> {
    const partial: Partial<CanaryExitCriteria> = {};
    const configAny = this.config as Record<string, unknown>;
    const canaryConfig = configAny['canary'] as
      | Record<string, unknown>
      | undefined;

    if (!canaryConfig) return partial;

    const exitCriteria = canaryConfig['exitCriteria'] as
      | Record<string, unknown>
      | undefined;

    if (!exitCriteria) return partial;

    if (typeof exitCriteria['winThreshold'] === 'number') {
      partial.winThreshold = exitCriteria['winThreshold'];
    }
    if (typeof exitCriteria['lossThreshold'] === 'number') {
      partial.lossThreshold = exitCriteria['lossThreshold'];
    }
    if (typeof exitCriteria['catastrophicRegressionDelta'] === 'number') {
      partial.catastrophicRegressionDelta =
        exitCriteria['catastrophicRegressionDelta'];
    }
    if (typeof exitCriteria['minComparisons'] === 'number') {
      partial.minComparisons = exitCriteria['minComparisons'];
    }

    return partial;
  }
}
