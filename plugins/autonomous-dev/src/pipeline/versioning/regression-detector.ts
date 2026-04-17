import { DocumentType } from '../types/document-type';
import { PipelineConfig } from '../types/config';

export interface RegressionCheckResult {
  /** Whether this is a regression */
  isRegression: boolean;
  /** New score */
  newScore: number;
  /** Previous score (null if first review) */
  previousScore: number | null;
  /** Score delta (newScore - previousScore), null if first review */
  scoreDelta: number | null;
  /** Configured regression margin */
  regressionMargin: number;
  /** Recommendation: "proceed" or "rollback_suggested" */
  recommendation: 'proceed' | 'rollback_suggested';
}

/**
 * Checks whether a new review score represents a quality regression.
 *
 * Rules (TDD Section 3.5.4):
 *   - If no previous score (first review): NOT a regression.
 *   - If scoreDelta < -regressionMargin: IS a regression.
 *   - If scoreDelta >= -regressionMargin: NOT a regression.
 *   - regressionMargin defaults to 5, configurable via config.yaml.
 *
 * Examples (with margin=5):
 *   previousScore=90, newScore=87: delta=-3, NOT regression
 *   previousScore=90, newScore=85: delta=-5, NOT regression (exact margin)
 *   previousScore=90, newScore=84: delta=-6, IS regression
 *   previousScore=null, newScore=70: first review, NOT regression
 *
 * @param newScore The new aggregate review score (0-100)
 * @param previousScore The previous version's aggregate score (null if first review)
 * @param config Pipeline configuration (for regressionMargin)
 * @param type Document type (for per-type margin override)
 */
export function checkRegression(
  newScore: number,
  previousScore: number | null,
  config: PipelineConfig,
  type: DocumentType,
): RegressionCheckResult {
  // Get margin: per-type override or default
  const typeOverrides = config.reviewGates.overrides[type];
  const margin = typeOverrides?.regressionMargin
    ?? config.reviewGates.defaults.regressionMargin;

  // First review: never a regression
  if (previousScore === null) {
    return {
      isRegression: false,
      newScore,
      previousScore: null,
      scoreDelta: null,
      regressionMargin: margin,
      recommendation: 'proceed',
    };
  }

  const scoreDelta = newScore - previousScore;
  const isRegression = scoreDelta < -margin;

  return {
    isRegression,
    newScore,
    previousScore,
    scoreDelta,
    regressionMargin: margin,
    recommendation: isRegression ? 'rollback_suggested' : 'proceed',
  };
}
