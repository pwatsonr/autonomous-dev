import { QualityRubric, AggregationMethod } from '../pipeline/types/quality-rubric';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Score for a single section within a category (per-section scoring mode).
 */
export interface SectionScore {
  section_id: string;
  score: number;
}

/**
 * Score for a single rubric category, optionally with per-section breakdown.
 */
export interface CategoryScore {
  category_id: string;
  /** Overall score for this category. Used when section_scores is null. */
  score: number;
  /**
   * Per-section scores. When non-null, the effective category score is
   * the minimum of all section scores (multi-section category minimum rule).
   * When null, document-level scoring is used and `score` is the value.
   */
  section_scores: SectionScore[] | null;
}

/**
 * Output from a single reviewer.
 */
export interface ReviewOutput {
  reviewer_id: string;
  category_scores: CategoryScore[];
  findings: Finding[];
}

/**
 * A review finding (issue, suggestion, etc.).
 */
export interface Finding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  /** Sub-classification for critical findings. */
  critical_sub?: 'blocking' | 'reject';
  section_id: string;
  category_id: string;
  description: string;
  evidence: string;
  suggested_resolution: string;
}

/**
 * Aggregated score for a single category across reviewers.
 */
export interface CategoryAggregate {
  category_id: string;
  aggregate_score: number;
  per_reviewer_scores: { reviewer_id: string; score: number }[];
  threshold_violated: boolean;
}

/**
 * Result of aggregating multiple reviewer scores.
 */
export interface AggregationResult {
  aggregate_score: number;
  per_reviewer_scores: { reviewer_id: string; weighted_score: number }[];
  category_aggregates: CategoryAggregate[];
}

// ---------------------------------------------------------------------------
// ScoreAggregator
// ---------------------------------------------------------------------------

export class ScoreAggregator {
  /**
   * Resolves the effective score for a category.
   *
   * - If section_scores is null (document-level), returns categoryScore.score.
   * - If section_scores is non-null (per-section), returns the minimum of section scores.
   */
  resolveCategoryScore(categoryScore: CategoryScore): number {
    if (categoryScore.section_scores === null) {
      return categoryScore.score;
    }
    if (categoryScore.section_scores.length === 0) {
      return categoryScore.score;
    }
    return Math.min(...categoryScore.section_scores.map((s) => s.score));
  }

  /**
   * Computes the weighted score for a single reviewer.
   *
   * Formula: SUM(resolved_score_i * weight_i)
   * Categories with weight 0 are skipped with a warning logged.
   * Result is rounded to 2 decimal places.
   */
  computeWeightedScore(categoryScores: CategoryScore[], rubric: QualityRubric): number {
    let score = 0;

    for (const category of rubric.categories) {
      if (category.weight === 0) {
        console.warn(
          `ScoreAggregator: Category '${category.id}' has weight 0; skipping in weighted sum.`
        );
        continue;
      }

      const catScore = categoryScores.find((cs) => cs.category_id === category.id);
      if (!catScore) {
        continue;
      }

      const resolved = this.resolveCategoryScore(catScore);
      score += resolved * category.weight;
    }

    return Math.round(score * 100) / 100;
  }

  /**
   * Aggregates scores from multiple reviewers.
   *
   * Computes per-reviewer weighted scores, then aggregates using the
   * specified method (mean, median, min). Also computes per-category
   * aggregates across reviewers.
   */
  aggregateScores(
    reviewerOutputs: ReviewOutput[],
    rubric: QualityRubric,
    method: AggregationMethod
  ): AggregationResult {
    if (reviewerOutputs.length === 0) {
      return {
        aggregate_score: NaN,
        per_reviewer_scores: [],
        category_aggregates: [],
      };
    }

    // Compute per-reviewer weighted scores
    const perReviewerScores = reviewerOutputs.map((output) => ({
      reviewer_id: output.reviewer_id,
      weighted_score: this.computeWeightedScore(output.category_scores, rubric),
    }));

    // Aggregate weighted scores
    const weightedValues = perReviewerScores.map((r) => r.weighted_score);
    const aggregateScore = this.aggregate(weightedValues, method);

    // Per-category aggregation
    const categoryAggregates = this.computeCategoryAggregates(reviewerOutputs, rubric, method);

    return {
      aggregate_score: aggregateScore,
      per_reviewer_scores: perReviewerScores,
      category_aggregates: categoryAggregates,
    };
  }

  /**
   * Aggregates an array of numbers using the specified method.
   * Result is rounded to 2 decimal places.
   */
  private aggregate(values: number[], method: AggregationMethod): number {
    if (values.length === 0) {
      return NaN;
    }

    let result: number;

    switch (method) {
      case 'mean':
        result = values.reduce((sum, v) => sum + v, 0) / values.length;
        break;

      case 'median': {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        if (sorted.length % 2 === 0) {
          result = (sorted[mid - 1] + sorted[mid]) / 2;
        } else {
          result = sorted[mid];
        }
        break;
      }

      case 'min':
        result = Math.min(...values);
        break;

      default:
        throw new Error(`Unknown aggregation method: ${method}`);
    }

    return Math.round(result * 100) / 100;
  }

  /**
   * Computes per-category aggregate scores across all reviewers.
   */
  private computeCategoryAggregates(
    reviewerOutputs: ReviewOutput[],
    rubric: QualityRubric,
    method: AggregationMethod
  ): CategoryAggregate[] {
    const aggregates: CategoryAggregate[] = [];

    for (const category of rubric.categories) {
      const perReviewerScores: { reviewer_id: string; score: number }[] = [];

      for (const output of reviewerOutputs) {
        const catScore = output.category_scores.find(
          (cs) => cs.category_id === category.id
        );
        if (catScore) {
          perReviewerScores.push({
            reviewer_id: output.reviewer_id,
            score: this.resolveCategoryScore(catScore),
          });
        }
      }

      const scores = perReviewerScores.map((r) => r.score);
      const aggregateScore = scores.length > 0 ? this.aggregate(scores, method) : NaN;

      aggregates.push({
        category_id: category.id,
        aggregate_score: aggregateScore,
        per_reviewer_scores: perReviewerScores,
        threshold_violated:
          category.minimumScore !== undefined &&
          category.minimumScore !== null &&
          aggregateScore < category.minimumScore,
      });
    }

    return aggregates;
  }
}
