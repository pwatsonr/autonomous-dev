/**
 * PipelineAggregator: computes cross-gate aggregate statistics over
 * configurable time windows.
 *
 * Provides observability into review gate effectiveness, including
 * first-pass rates, iteration counts, escalation rates, score
 * distributions, and overall pipeline health metrics.
 *
 * Based on SPEC-004-4-2 section 4.
 */

import { DocumentType, DOCUMENT_TYPES } from '../types';
import {
  ReviewMetricsRecord,
  PipelineAggregates,
  DocumentTypeAggregates,
  OverallAggregates,
  ScoreDistribution,
} from './metrics-types';
import { MetricsStore } from './metrics-store';

// ---------------------------------------------------------------------------
// Statistical helpers
// ---------------------------------------------------------------------------

/**
 * Compute the arithmetic mean of an array of numbers.
 * Returns 0 for empty arrays.
 */
export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/**
 * Compute the median of a sorted array of numbers.
 * Returns 0 for empty arrays.
 */
export function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/**
 * Compute a percentile value from a sorted array using nearest-rank method.
 * Returns 0 for empty arrays.
 *
 * @param sorted - Pre-sorted array of numbers (ascending).
 * @param p - Percentile (0-100).
 */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const index = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  // Linear interpolation
  const weight = index - lower;
  return sorted[lower] + weight * (sorted[upper] - sorted[lower]);
}

/**
 * Compute score distribution statistics for an array of scores.
 */
export function computeDistribution(
  categoryId: string,
  scores: number[]
): ScoreDistribution {
  if (scores.length === 0) {
    return {
      category_id: categoryId,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p25: 0,
      p75: 0,
      sample_count: 0,
    };
  }

  const sorted = [...scores].sort((a, b) => a - b);
  return {
    category_id: categoryId,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: mean(sorted),
    median: median(sorted),
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    sample_count: sorted.length,
  };
}

// ---------------------------------------------------------------------------
// PipelineAggregator
// ---------------------------------------------------------------------------

/**
 * Computes cross-gate aggregate statistics over configurable time windows.
 */
export class PipelineAggregator {
  constructor(private store: MetricsStore) {}

  /**
   * Compute aggregate statistics over the given time window.
   *
   * @param windowDays - Number of days to look back (default: 30).
   * @returns Pipeline aggregates broken down by document type and overall.
   */
  async computeAggregates(windowDays: number = 30): Promise<PipelineAggregates> {
    const windowEnd = new Date().toISOString();
    const windowStart = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000
    ).toISOString();

    const records = await this.store.query({
      from_timestamp: windowStart,
      to_timestamp: windowEnd,
    });

    // Group by document type
    const byType = new Map<DocumentType, ReviewMetricsRecord[]>();
    for (const record of records) {
      if (!byType.has(record.document_type)) {
        byType.set(record.document_type, []);
      }
      byType.get(record.document_type)!.push(record);
    }

    const byDocumentType: Partial<Record<DocumentType, DocumentTypeAggregates>> = {};
    for (const [docType, typeRecords] of byType) {
      byDocumentType[docType] = this.computeTypeAggregates(docType, typeRecords);
    }

    return {
      computed_at: new Date().toISOString(),
      window_start: windowStart,
      window_end: windowEnd,
      by_document_type: byDocumentType,
      overall: this.computeOverallAggregates(records),
    };
  }

  /**
   * Compute aggregates for a single document type.
   */
  private computeTypeAggregates(
    docType: DocumentType,
    records: ReviewMetricsRecord[]
  ): DocumentTypeAggregates {
    const total = records.length;

    // First pass rate: approved on iteration 1
    const firstPassCount = records.filter(
      (r) => r.iteration_count === 1 && r.outcome === 'approved'
    ).length;
    const firstPassRate = total > 0 ? (firstPassCount / total) * 100 : 0;

    // Mean iterations to approval
    const approvedRecords = records.filter((r) => r.outcome === 'approved');
    const meanIterationsToApproval =
      approvedRecords.length > 0
        ? mean(approvedRecords.map((r) => r.iteration_count))
        : 0;

    // Escalation rate
    const escalatedCount = records.filter((r) => r.human_escalation).length;
    const escalationRate = total > 0 ? (escalatedCount / total) * 100 : 0;

    // Mean aggregate score
    const meanAggregateScore = mean(records.map((r) => r.aggregate_score));

    // Stagnation rate
    const stagnationCount = records.filter((r) => r.stagnation_detected).length;
    const stagnationRate = total > 0 ? (stagnationCount / total) * 100 : 0;

    // Category score distributions
    const categoryScoreDistributions = this.computeCategoryDistributions(records);

    return {
      document_type: docType,
      total_gates: total,
      first_pass_rate: firstPassRate,
      mean_iterations_to_approval: meanIterationsToApproval,
      escalation_rate: escalationRate,
      mean_aggregate_score: meanAggregateScore,
      stagnation_rate: stagnationRate,
      smoke_test_pass_rate: 0, // Requires separate smoke test metrics
      backward_cascade_rate: 0, // Requires external backward cascade event data
      category_score_distributions: categoryScoreDistributions,
    };
  }

  /**
   * Compute score distributions for each category that appears in the records.
   */
  private computeCategoryDistributions(
    records: ReviewMetricsRecord[]
  ): Record<string, ScoreDistribution> {
    // Collect all scores per category
    const categoryScores = new Map<string, number[]>();
    for (const record of records) {
      for (const [categoryId, score] of Object.entries(record.category_scores)) {
        if (!categoryScores.has(categoryId)) {
          categoryScores.set(categoryId, []);
        }
        categoryScores.get(categoryId)!.push(score);
      }
    }

    const distributions: Record<string, ScoreDistribution> = {};
    for (const [categoryId, scores] of categoryScores) {
      distributions[categoryId] = computeDistribution(categoryId, scores);
    }

    return distributions;
  }

  /**
   * Compute overall aggregates across all document types.
   */
  private computeOverallAggregates(
    records: ReviewMetricsRecord[]
  ): OverallAggregates {
    const total = records.length;

    return {
      total_gates: total,
      total_approved: records.filter((r) => r.outcome === 'approved').length,
      total_rejected: records.filter((r) => r.outcome === 'rejected').length,
      total_escalated: records.filter((r) => r.human_escalation).length,
      mean_review_duration_ms: mean(records.map((r) => r.review_duration_ms)),
      mean_iterations: mean(records.map((r) => r.iteration_count)),
    };
  }
}
