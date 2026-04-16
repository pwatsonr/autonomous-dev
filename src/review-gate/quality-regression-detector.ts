/**
 * Quality regression detection between review iterations.
 *
 * Identifies when a document revision's score drops below the previous
 * iteration's score by more than a configurable margin, and recommends
 * rollback when appropriate. The detector produces the QualityRegression
 * object but does NOT perform the rollback -- that decision belongs to
 * the IterationController.
 *
 * Based on SPEC-004-3-1 section 3.
 */

import { QualityRegression } from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RegressionConfig {
  /** Minimum score drop (in points) to trigger regression. Default: 5. */
  margin: number;
}

const DEFAULT_REGRESSION_CONFIG: RegressionConfig = {
  margin: 5,
};

// ---------------------------------------------------------------------------
// State type used by the detector (subset of IterationState)
// ---------------------------------------------------------------------------

export interface ScoreHistoryEntry {
  iteration: number;
  aggregate_score: number;
}

export interface RegressionDetectorState {
  current_iteration: number;
  score_history: ScoreHistoryEntry[];
}

// ---------------------------------------------------------------------------
// QualityRegressionDetector
// ---------------------------------------------------------------------------

export class QualityRegressionDetector {
  private readonly config: RegressionConfig;

  constructor(config?: Partial<RegressionConfig>) {
    this.config = { ...DEFAULT_REGRESSION_CONFIG, ...config };
  }

  /**
   * Detects quality regression between the current and previous iteration.
   *
   * Returns a QualityRegression object when the current score drops below
   * (previous_score - margin). Returns null on the first iteration or
   * when no regression is detected.
   *
   * Key behavior:
   * - A drop of exactly `margin` points is NOT a regression (strictly greater).
   * - First iteration always returns null.
   * - Score improvements return null.
   */
  detect(
    state: RegressionDetectorState,
    config?: Partial<RegressionConfig>
  ): QualityRegression | null {
    const effectiveMargin = config?.margin ?? this.config.margin;

    // First iteration cannot have regression
    if (state.current_iteration < 2 || state.score_history.length < 2) {
      return null;
    }

    const currentEntry = state.score_history.find(
      (h) => h.iteration === state.current_iteration
    );
    const previousEntry = state.score_history.find(
      (h) => h.iteration === state.current_iteration - 1
    );

    if (!currentEntry || !previousEntry) {
      return null;
    }

    const currentScore = currentEntry.aggregate_score;
    const previousScore = previousEntry.aggregate_score;
    const delta = currentScore - previousScore;

    // Regression: current < previous - margin (strictly greater drop)
    if (currentScore < previousScore - effectiveMargin) {
      return {
        previous_score: previousScore,
        current_score: currentScore,
        delta,
        rollback_recommended: true,
      };
    }

    return null;
  }
}
