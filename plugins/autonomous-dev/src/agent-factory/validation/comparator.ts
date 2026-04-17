/**
 * De-randomizer and Comparator (SPEC-005-4-2, Task 5).
 *
 * Maps blind scores back to version labels (version_a = current,
 * version_b = proposed) using the stored RandomizationMapping, then
 * computes per-dimension deltas and win/loss/tie classification.
 *
 * The de-randomization step is the ONLY place where scoring results
 * are linked back to actual agent versions. This ensures the scorer
 * never had access to version identity.
 *
 * Exports: `Comparator`
 */

import type {
  ScoringResult,
  RandomizationMapping,
  ComparisonResult,
  DimensionScores,
} from '../improvement/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Win/loss/tie classification threshold.
 *
 * - proposed_wins: overall_delta > THRESHOLD
 * - current_wins:  overall_delta < -THRESHOLD
 * - tie:           -THRESHOLD <= overall_delta <= THRESHOLD
 */
const TIE_THRESHOLD = 0.2;

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface ComparatorLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const defaultLogger: ComparatorLogger = {
  info: (msg: string) => console.log(`[comparator] ${msg}`),
  warn: (msg: string) => console.warn(`[comparator] ${msg}`),
  error: (msg: string) => console.error(`[comparator] ${msg}`),
};

// ---------------------------------------------------------------------------
// Comparator
// ---------------------------------------------------------------------------

export interface ComparatorOptions {
  logger?: ComparatorLogger;
}

/**
 * De-randomizes scoring results and computes version-level comparison.
 *
 * Usage:
 * ```ts
 * const comparator = new Comparator();
 * const result = comparator.compare(scoringResult, mapping);
 * // result.outcome: 'proposed_wins' | 'current_wins' | 'tie'
 * ```
 */
export class Comparator {
  private readonly logger: ComparatorLogger;

  constructor(opts?: ComparatorOptions) {
    this.logger = opts?.logger ?? defaultLogger;
  }

  /**
   * De-randomize scoring results and compute the comparison.
   *
   * Steps:
   *   1. Map median scores back to version_a (current) and version_b (proposed).
   *   2. Compute per-dimension deltas (proposed - current).
   *   3. Compute overall delta (mean of dimension deltas).
   *   4. Classify outcome using 0.2 threshold.
   *
   * @param scoringResult  The blind scoring result (uses "output_1" / "output_2").
   * @param mapping        The randomization mapping that reveals which output is which.
   * @returns              ComparisonResult with version-level scores and outcome.
   */
  compare(
    scoringResult: ScoringResult,
    mapping: RandomizationMapping,
  ): ComparisonResult {
    this.logger.info(
      `De-randomizing scores for input ${scoringResult.input_id} ` +
      `(output_1 is ${mapping.output_1_is})`,
    );

    // Step 1: De-randomize -- map output_1/output_2 to version_a/version_b
    const { versionAScores, versionBScores } = derandomizeScores(
      scoringResult.median_scores,
      mapping,
    );

    // Step 2: Compute per-dimension deltas (proposed - current)
    const perDimensionDelta = computePerDimensionDelta(
      versionAScores,
      versionBScores,
    );

    // Step 3: Compute overall delta (mean of dimension deltas)
    const overallDelta = computeOverallDelta(perDimensionDelta);

    // Step 4: Classify outcome
    const outcome = classifyOutcome(overallDelta);

    this.logger.info(
      `Comparison for input ${scoringResult.input_id}: ` +
      `overall_delta=${overallDelta.toFixed(4)}, outcome=${outcome}`,
    );

    return {
      input_id: scoringResult.input_id,
      version_a_scores: versionAScores,
      version_b_scores: versionBScores,
      per_dimension_delta: perDimensionDelta,
      overall_delta: overallDelta,
      outcome,
      scoring_variance: scoringResult.scoring_variance,
    };
  }
}

// ---------------------------------------------------------------------------
// De-randomization
// ---------------------------------------------------------------------------

/**
 * Map output_1/output_2 median scores back to version_a/version_b
 * using the randomization mapping.
 *
 * If output_1_is === 'version_a':
 *   version_a_scores = median_scores.output_1
 *   version_b_scores = median_scores.output_2
 * Else:
 *   version_a_scores = median_scores.output_2
 *   version_b_scores = median_scores.output_1
 */
export function derandomizeScores(
  medianScores: { output_1: DimensionScores; output_2: DimensionScores },
  mapping: RandomizationMapping,
): { versionAScores: DimensionScores; versionBScores: DimensionScores } {
  if (mapping.output_1_is === 'version_a') {
    return {
      versionAScores: medianScores.output_1,
      versionBScores: medianScores.output_2,
    };
  } else {
    return {
      versionAScores: medianScores.output_2,
      versionBScores: medianScores.output_1,
    };
  }
}

// ---------------------------------------------------------------------------
// Delta computation
// ---------------------------------------------------------------------------

/**
 * Compute per-dimension deltas: proposed (version_b) minus current (version_a).
 *
 * For each dimension present in both version scores, compute:
 *   delta[dimension] = version_b_scores[dimension] - version_a_scores[dimension]
 *
 * Positive delta means the proposed version scored higher on that dimension.
 */
export function computePerDimensionDelta(
  versionAScores: DimensionScores,
  versionBScores: DimensionScores,
): Record<string, number> {
  const delta: Record<string, number> = {};

  // Use the union of dimensions from both versions
  const allDimensions = new Set([
    ...Object.keys(versionAScores.scores),
    ...Object.keys(versionBScores.scores),
  ]);

  for (const dim of allDimensions) {
    const aScore = versionAScores.scores[dim] ?? 0;
    const bScore = versionBScores.scores[dim] ?? 0;
    delta[dim] = bScore - aScore;
  }

  return delta;
}

/**
 * Compute overall delta as the mean of all per-dimension deltas.
 *
 * Returns 0 if there are no dimensions.
 */
export function computeOverallDelta(
  perDimensionDelta: Record<string, number>,
): number {
  const values = Object.values(perDimensionDelta);
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------

/**
 * Classify the outcome based on overall delta and the 0.2 threshold.
 *
 * - proposed_wins: overall_delta > 0.2  (strictly greater)
 * - current_wins:  overall_delta < -0.2 (strictly less)
 * - tie:           -0.2 <= overall_delta <= 0.2
 */
export function classifyOutcome(
  overallDelta: number,
): 'proposed_wins' | 'current_wins' | 'tie' {
  if (overallDelta > TIE_THRESHOLD) {
    return 'proposed_wins';
  }
  if (overallDelta < -TIE_THRESHOLD) {
    return 'current_wins';
  }
  return 'tie';
}
