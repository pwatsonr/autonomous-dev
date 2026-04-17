/**
 * Iteration controller for the create-review-revise-re-review loop.
 *
 * Manages iteration state, enforces termination conditions (max iterations,
 * stagnation, identical revisions), delegates to the ConvergenceTracker
 * and QualityRegressionDetector for analysis, and provides checkpoint/restore
 * for crash recovery.
 *
 * Based on SPEC-004-3-1 section 1.
 */

import * as crypto from 'crypto';
import { MergedFinding, QualityRegression } from './types';
import { ConvergenceTracker } from './convergence-tracker';
import { QualityRegressionDetector } from './quality-regression-detector';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IterationState {
  gate_id: string;
  document_id: string;
  current_iteration: number;
  max_iterations: number;
  score_history: { iteration: number; aggregate_score: number }[];
  finding_history: { iteration: number; findings: MergedFinding[] }[];
  content_hashes: { iteration: number; hash: string }[];
  outcome_history: {
    iteration: number;
    outcome: 'approved' | 'changes_requested' | 'rejected';
  }[];
  stagnation_count: number;
  checkpoints: IterationCheckpoint[];
}

export interface IterationCheckpoint {
  iteration: number;
  stage:
    | 'validation'
    | 'review_started'
    | 'review_completed'
    | 'aggregation'
    | 'decision';
  timestamp: string;
  state_snapshot: Partial<IterationState>;
}

export interface IterationDecision {
  should_continue: boolean;
  outcome: 'approved' | 'changes_requested' | 'rejected' | null;
  reason: string;
  stagnation_warning: boolean;
  quality_regression: QualityRegression | null;
  identical_revision: boolean;
}

export interface IterationControllerConfig {
  max_iterations: number;
  auto_rollback_on_regression: boolean;
}

// ---------------------------------------------------------------------------
// Content hash utility
// ---------------------------------------------------------------------------

/**
 * Computes a whitespace-normalized SHA-256 hash of document content.
 * Collapses multiple whitespace characters into a single space and trims.
 */
export function computeContentHash(content: string): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ---------------------------------------------------------------------------
// IterationController
// ---------------------------------------------------------------------------

export class IterationController {
  private readonly config: IterationControllerConfig;
  private readonly convergenceTracker: ConvergenceTracker;
  private readonly regressionDetector: QualityRegressionDetector;

  /** In-memory store of checkpoints keyed by gate_id. */
  private checkpointStore: Map<string, IterationState> = new Map();

  constructor(
    config: Partial<IterationControllerConfig> = {}
  ) {
    this.config = {
      max_iterations: config.max_iterations ?? 3,
      auto_rollback_on_regression: config.auto_rollback_on_regression ?? false,
    };
    this.convergenceTracker = new ConvergenceTracker();
    this.regressionDetector = new QualityRegressionDetector();
  }

  /**
   * Creates a new iteration state for a gate.
   * Initializes with current_iteration: 0 and empty histories.
   */
  initializeGate(gateId: string, documentId: string): IterationState {
    return {
      gate_id: gateId,
      document_id: documentId,
      current_iteration: 0,
      max_iterations: this.config.max_iterations,
      score_history: [],
      finding_history: [],
      content_hashes: [],
      outcome_history: [],
      stagnation_count: 0,
      checkpoints: [],
    };
  }

  /**
   * Starts a new iteration by incrementing the iteration counter.
   * Throws if the current iteration would exceed max_iterations.
   */
  startIteration(state: IterationState): IterationState {
    const nextIteration = state.current_iteration + 1;
    if (nextIteration > state.max_iterations) {
      throw new Error(
        `Cannot start iteration ${nextIteration}: exceeds max_iterations (${state.max_iterations}).`
      );
    }
    return {
      ...state,
      current_iteration: nextIteration,
    };
  }

  /**
   * Records the result of the current iteration and decides the next action.
   *
   * Decision logic (in order):
   * 1. Record score, findings, content hash, outcome in history.
   * 2. Identical revision check (content hash matches any previous).
   * 3. If approved or rejected, terminate.
   * 4. Convergence/stagnation check.
   * 5. Quality regression check.
   * 6. Max iterations check.
   * 7. Otherwise continue with changes_requested.
   */
  recordReviewOutcome(
    state: IterationState,
    aggregateScore: number,
    findings: MergedFinding[],
    contentHash: string,
    approvalOutcome: 'approved' | 'changes_requested' | 'rejected'
  ): IterationDecision {
    // 1. Record in history
    state.score_history.push({
      iteration: state.current_iteration,
      aggregate_score: aggregateScore,
    });
    state.finding_history.push({
      iteration: state.current_iteration,
      findings,
    });
    state.outcome_history.push({
      iteration: state.current_iteration,
      outcome: approvalOutcome,
    });

    // 2. Identical revision check
    const previousHashMatch = state.content_hashes.find(
      (h) => h.hash === contentHash
    );
    state.content_hashes.push({
      iteration: state.current_iteration,
      hash: contentHash,
    });

    if (previousHashMatch) {
      return {
        should_continue: false,
        outcome: 'changes_requested',
        reason:
          'Revision is identical to a previous version. No changes were made.',
        stagnation_warning: false,
        quality_regression: null,
        identical_revision: true,
      };
    }

    // 3. Approved or rejected -- terminate
    if (approvalOutcome === 'approved') {
      return {
        should_continue: false,
        outcome: 'approved',
        reason: 'Document approved.',
        stagnation_warning: false,
        quality_regression: null,
        identical_revision: false,
      };
    }

    if (approvalOutcome === 'rejected') {
      return {
        should_continue: false,
        outcome: 'rejected',
        reason: 'Document rejected.',
        stagnation_warning: false,
        quality_regression: null,
        identical_revision: false,
      };
    }

    // 4. Convergence/stagnation check
    let stagnationWarning = false;
    const convergence = this.convergenceTracker.analyze({
      current_iteration: state.current_iteration,
      score_history: state.score_history,
      finding_history: state.finding_history,
    });

    if (convergence.stagnation_detected) {
      state.stagnation_count++;

      if (state.stagnation_count >= 2) {
        return {
          should_continue: false,
          outcome: 'rejected',
          reason: 'Stagnation persisted for 2 consecutive iterations.',
          stagnation_warning: true,
          quality_regression: null,
          identical_revision: false,
        };
      }

      stagnationWarning = true;
    } else {
      // Reset stagnation count when no stagnation detected
      state.stagnation_count = 0;
    }

    // 5. Quality regression check
    let qualityRegression: QualityRegression | null = null;
    const regression = this.regressionDetector.detect({
      current_iteration: state.current_iteration,
      score_history: state.score_history,
    });

    if (regression) {
      if (this.config.auto_rollback_on_regression) {
        return {
          should_continue: true,
          outcome: 'changes_requested',
          reason:
            'Quality regression detected. Rolling back to previous version.',
          stagnation_warning: stagnationWarning,
          quality_regression: regression,
          identical_revision: false,
        };
      }
      qualityRegression = regression;
    }

    // 6. Max iterations check
    if (state.current_iteration >= state.max_iterations) {
      return {
        should_continue: false,
        outcome: 'rejected',
        reason: `Maximum iterations (${state.max_iterations}) reached without approval.`,
        stagnation_warning: stagnationWarning,
        quality_regression: qualityRegression,
        identical_revision: false,
      };
    }

    // 7. Continue with changes_requested
    return {
      should_continue: true,
      outcome: 'changes_requested',
      reason: 'Document requires revisions.',
      stagnation_warning: stagnationWarning,
      quality_regression: qualityRegression,
      identical_revision: false,
    };
  }

  /**
   * Saves a checkpoint with the current state snapshot for crash recovery.
   */
  checkpoint(
    state: IterationState,
    stage:
      | 'validation'
      | 'review_started'
      | 'review_completed'
      | 'aggregation'
      | 'decision'
  ): void {
    const cp: IterationCheckpoint = {
      iteration: state.current_iteration,
      stage,
      timestamp: new Date().toISOString(),
      state_snapshot: { ...state },
    };
    state.checkpoints.push(cp);
    this.checkpointStore.set(state.gate_id, { ...state, checkpoints: [...state.checkpoints] });
  }

  /**
   * Restores state from the last checkpoint for a given gate.
   * Returns null if no checkpoint exists.
   */
  restoreFromCheckpoint(gateId: string): IterationState | null {
    return this.checkpointStore.get(gateId) ?? null;
  }
}
