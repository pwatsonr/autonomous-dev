/**
 * Aggregate Decision Engine (SPEC-005-4-3, Task 6).
 *
 * Determines the overall A/B validation verdict from per-input
 * ComparisonResult entries. Applies the threshold rules:
 *   - POSITIVE: proposed wins >= 60% of inputs AND mean_delta > 0
 *   - NEGATIVE: current wins >= 40% of inputs OR mean_delta < -0.2
 *   - INCONCLUSIVE: everything else
 *
 * Also computes per-dimension summaries and a human-readable
 * recommendation string.
 *
 * Exports: `DecisionEngine`
 */

import type {
  ComparisonResult,
  ABAggregate,
  ABVerdict,
  DimensionSummary,
} from '../improvement/types';

// ---------------------------------------------------------------------------
// Statistics helper
// ---------------------------------------------------------------------------

/**
 * Compute the arithmetic mean of a number array.
 * Returns 0 for empty arrays.
 */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Recommendation generation
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable recommendation string for the verdict.
 */
function generateRecommendation(
  verdict: ABVerdict,
  proposedWins: number,
  currentWins: number,
  ties: number,
  total: number,
  meanDelta: number,
  perDimensionSummary: Record<string, DimensionSummary>,
): string {
  switch (verdict) {
    case 'positive': {
      const improvedDims = Object.values(perDimensionSummary)
        .filter((d) => d.improved)
        .map((d) => d.dimension_name);
      const dimNote =
        improvedDims.length > 0
          ? ` Improved dimensions: ${improvedDims.join(', ')}.`
          : '';
      return (
        `Proposed version wins on ${proposedWins}/${total} inputs ` +
        `with mean quality improvement of ${meanDelta.toFixed(3)}.` +
        ` Recommend proceeding to promotion.${dimNote}`
      );
    }

    case 'negative': {
      const regressedDims = Object.values(perDimensionSummary)
        .filter((d) => !d.improved)
        .map((d) => d.dimension_name);
      const dimNote =
        regressedDims.length > 0
          ? ` Regressed dimensions: ${regressedDims.join(', ')}.`
          : '';
      return (
        `Proposed version loses on ${currentWins}/${total} inputs ` +
        `with mean quality delta of ${meanDelta.toFixed(3)}.` +
        ` Recommend rejecting this proposal.${dimNote}`
      );
    }

    case 'inconclusive': {
      return (
        `Results are inconclusive (${proposedWins}/${currentWins}/${ties}).` +
        ` Consider increasing input count or manual review.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// DecisionEngine
// ---------------------------------------------------------------------------

/**
 * Aggregate decision engine for A/B validation.
 *
 * Takes the per-input comparison results and produces an aggregate
 * verdict with per-dimension breakdowns and a recommendation.
 */
export class DecisionEngine {
  /**
   * Produce an aggregate verdict from per-input comparison results.
   *
   * @param comparisons  Array of ComparisonResult, one per evaluated input.
   * @returns            ABAggregate with verdict, counts, deltas, summaries.
   * @throws             Error if comparisons array is empty.
   */
  decide(comparisons: ComparisonResult[]): ABAggregate {
    if (comparisons.length === 0) {
      throw new Error('Cannot decide with zero comparisons');
    }

    const total = comparisons.length;
    const proposedWins = comparisons.filter(
      (c) => c.outcome === 'proposed_wins',
    ).length;
    const currentWins = comparisons.filter(
      (c) => c.outcome === 'current_wins',
    ).length;
    const ties = comparisons.filter((c) => c.outcome === 'tie').length;
    const meanDelta = mean(comparisons.map((c) => c.overall_delta));

    // --- Verdict determination ---

    let verdict: ABVerdict;

    // POSITIVE: proposed wins on 60%+ of inputs AND mean delta > 0
    if (proposedWins / total >= 0.6 && meanDelta > 0) {
      verdict = 'positive';
    }
    // NEGATIVE: proposed loses on 40%+ of inputs OR mean delta < -0.2
    else if (currentWins / total >= 0.4 || meanDelta < -0.2) {
      verdict = 'negative';
    }
    // INCONCLUSIVE: everything else
    else {
      verdict = 'inconclusive';
    }

    // --- Per-dimension summary ---

    const dimensions = new Set<string>(
      comparisons.flatMap((c) => Object.keys(c.per_dimension_delta)),
    );

    const perDimensionSummary: Record<string, DimensionSummary> = {};
    for (const dim of dimensions) {
      const deltas = comparisons
        .map((c) => c.per_dimension_delta[dim])
        .filter((d): d is number => d !== undefined);
      const dimMeanDelta = mean(deltas);
      perDimensionSummary[dim] = {
        mean_delta: dimMeanDelta,
        improved: dimMeanDelta > 0,
        dimension_name: dim,
      };
    }

    // --- Recommendation ---

    const recommendation = generateRecommendation(
      verdict,
      proposedWins,
      currentWins,
      ties,
      total,
      meanDelta,
      perDimensionSummary,
    );

    return {
      verdict,
      proposed_wins: proposedWins,
      current_wins: currentWins,
      ties,
      total_inputs: total,
      mean_delta: meanDelta,
      per_dimension_summary: perDimensionSummary,
      recommendation,
    };
  }
}
