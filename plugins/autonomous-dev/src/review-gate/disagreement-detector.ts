/**
 * DisagreementDetector: identifies rubric categories where reviewers diverge
 * significantly, providing signal about subjective or underdeveloped areas.
 *
 * Uses maximum pairwise difference (not standard deviation) as the variance
 * metric, per TDD-004 section 3.4.4.
 *
 * Based on SPEC-004-2-4.
 */

import type { ReviewOutput, Rubric, RubricCategory, Disagreement } from './types';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DisagreementConfig {
  /** Maximum pairwise score difference threshold to flag disagreement. Default: 15 */
  variance_threshold: number;
  /** Panel sizes at or below this value get a lower confidence note. Default: 2 */
  low_confidence_panel_size: number;
}

export const DEFAULT_DISAGREEMENT_CONFIG: DisagreementConfig = {
  variance_threshold: 15,
  low_confidence_panel_size: 2,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Retrieves the score for a given category from a reviewer's output.
 * Returns 0 if the category is not present (missing categories are already
 * handled by the output validator upstream).
 */
function getCategoryScore(output: ReviewOutput, categoryId: string): number {
  const cs = output.category_scores.find((c) => c.category_id === categoryId);
  if (!cs) return 0;
  return cs.score;
}

/**
 * Generates a human-readable note describing the disagreement.
 *
 * - Always states the variance and category name.
 * - Appends a low-confidence caveat for small panels (<= low_confidence_panel_size).
 * - Appends a significant divergence warning for variance >= 30.
 */
function generateNote(
  category: RubricCategory,
  variance: number,
  panelSize: number,
  config: DisagreementConfig,
): string {
  let note = `Reviewers disagreed by ${variance} points on '${category.name}'.`;
  if (panelSize <= config.low_confidence_panel_size) {
    note += ` Note: With only ${panelSize} reviewers, this disagreement is based on limited data and should be interpreted with lower confidence.`;
  }
  if (variance >= 30) {
    note += ` This is a significant divergence that may indicate fundamentally different interpretations of the rubric category.`;
  }
  return note;
}

// ---------------------------------------------------------------------------
// DisagreementDetector
// ---------------------------------------------------------------------------

export class DisagreementDetector {
  /**
   * Detects scoring disagreements across reviewers for each rubric category.
   *
   * Algorithm:
   * 1. If <= 1 reviewer, return empty (no disagreement possible).
   * 2. For each rubric category, compute max pairwise score difference.
   * 3. Flag categories where max pairwise difference >= variance_threshold.
   * 4. Sort flagged disagreements by variance descending.
   *
   * @param reviewerOutputs - Outputs from each reviewer on the panel
   * @param rubric - The rubric used for this review
   * @param config - Optional partial config overrides
   * @returns Array of Disagreement objects, sorted by variance descending
   */
  detect(
    reviewerOutputs: ReviewOutput[],
    rubric: Rubric,
    config?: Partial<DisagreementConfig>,
  ): Disagreement[] {
    const mergedConfig: DisagreementConfig = {
      ...DEFAULT_DISAGREEMENT_CONFIG,
      ...config,
    };

    // No disagreements possible with 0 or 1 reviewer
    if (reviewerOutputs.length <= 1) {
      return [];
    }

    const panelSize = reviewerOutputs.length;
    const disagreements: Disagreement[] = [];

    for (const category of rubric.categories) {
      // Collect scores for this category from each reviewer
      const reviewerScores = reviewerOutputs.map((r) => ({
        reviewer_id: r.reviewer_id,
        score: getCategoryScore(r, category.id),
      }));

      // Compute maximum pairwise difference
      let maxVariance = 0;
      for (let i = 0; i < reviewerScores.length; i++) {
        for (let j = i + 1; j < reviewerScores.length; j++) {
          const diff = Math.abs(reviewerScores[i].score - reviewerScores[j].score);
          if (diff > maxVariance) {
            maxVariance = diff;
          }
        }
      }

      // Flag if at or above threshold (inclusive: >= not >)
      if (maxVariance >= mergedConfig.variance_threshold) {
        disagreements.push({
          category_id: category.id,
          variance: maxVariance,
          reviewer_scores: reviewerScores,
          note: generateNote(category, maxVariance, panelSize, mergedConfig),
        });
      }
    }

    // Sort by variance descending (highest disagreement first)
    disagreements.sort((a, b) => b.variance - a.variance);

    return disagreements;
  }
}
