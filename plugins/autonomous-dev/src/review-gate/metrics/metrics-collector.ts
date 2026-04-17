/**
 * MetricsCollector: records per-gate and per-reviewer metrics for every
 * review gate execution.
 *
 * Implements the observer pattern via ReviewGateEventListener. The
 * ReviewGateService calls onGateCompleted after each gate execution,
 * and the collector assembles and persists a ReviewMetricsRecord.
 *
 * Based on SPEC-004-4-2 section 3.
 */

import {
  ReviewGateRecord,
  ReviewOutput,
  MergedFinding,
  CategoryAggregate,
} from '../types';
import { ReviewMetricsRecord, ReviewerMetric } from './metrics-types';
import { MetricsStore, writeWithRetry } from './metrics-store';

// ---------------------------------------------------------------------------
// Observer interface
// ---------------------------------------------------------------------------

/** Observer interface for review gate completion events. */
export interface ReviewGateEventListener {
  /** Called when a gate execution completes. */
  onGateCompleted(gateRecord: ReviewGateRecord, executionTimeMs: number): void;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Build a category_id -> aggregate_score map from category aggregates.
 */
export function buildCategoryScoreMap(
  categoryAggregates: CategoryAggregate[]
): Record<string, number> {
  const map: Record<string, number> = {};
  for (const cat of categoryAggregates) {
    map[cat.category_id] = cat.aggregate_score;
  }
  return map;
}

/**
 * Count findings by severity level.
 */
export function countFindingsBySeverity(
  findings: MergedFinding[]
): { critical: number; major: number; minor: number; suggestion: number } {
  const counts = { critical: 0, major: 0, minor: 0, suggestion: 0 };
  for (const finding of findings) {
    if (finding.severity in counts) {
      counts[finding.severity]++;
    }
  }
  return counts;
}

/**
 * Compute a simple weighted score for a reviewer.
 *
 * Uses the mean of all category scores as a proxy when rubric weights
 * are not available at metrics collection time. The actual weighted score
 * from the aggregation pipeline is preferred when available via
 * category_aggregates, but for per-reviewer delta computation we use
 * the mean of category scores.
 */
export function computeWeightedScore(output: ReviewOutput): number {
  if (output.category_scores.length === 0) {
    return 0;
  }
  const total = output.category_scores.reduce((sum, cs) => sum + cs.score, 0);
  return Math.round((total / output.category_scores.length) * 100) / 100;
}

/**
 * Build per-reviewer metrics including outlier detection.
 *
 * A reviewer is flagged as an outlier if their weighted score deviates
 * more than 1.5 standard deviations from the panel mean. With 2 reviewers,
 * both are always equidistant from the mean, so the maximum z-score is 1.0,
 * meaning outlier detection is only meaningful with 3+ reviewers.
 */
export function buildReviewerMetrics(
  reviewerOutputs: ReviewOutput[],
  aggregateScore: number
): ReviewerMetric[] {
  if (reviewerOutputs.length === 0) {
    return [];
  }

  const weightedScores = reviewerOutputs.map((r) => computeWeightedScore(r));
  const mean = weightedScores.reduce((a, b) => a + b, 0) / weightedScores.length;
  const stdDev = Math.sqrt(
    weightedScores.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) /
      weightedScores.length
  );

  return reviewerOutputs.map((output, i) => {
    const weightedScore = weightedScores[i];
    const delta = weightedScore - aggregateScore;
    const deviation = stdDev > 0 ? Math.abs(weightedScore - mean) / stdDev : 0;

    return {
      reviewer_id: output.reviewer_id,
      reviewer_role: output.reviewer_role,
      weighted_score: Math.round(weightedScore * 100) / 100,
      score_vs_aggregate_delta: Math.round(delta * 100) / 100,
      finding_count: output.findings.length,
      critical_finding_count: output.findings.filter(
        (f) => f.severity === 'critical'
      ).length,
      is_outlier: deviation > 1.5,
    };
  });
}

/**
 * Assemble a complete ReviewMetricsRecord from a gate record and execution time.
 */
export function buildMetricsRecord(
  gateRecord: ReviewGateRecord,
  executionTimeMs: number
): ReviewMetricsRecord {
  return {
    gate_id: gateRecord.gate_id,
    document_id: gateRecord.document_id,
    document_type: gateRecord.document_type,
    pipeline_id: gateRecord.pipeline_id,
    timestamp: new Date().toISOString(),

    outcome: gateRecord.outcome,
    aggregate_score: gateRecord.aggregate_score,
    iteration_count: gateRecord.iteration,
    review_duration_ms: executionTimeMs,
    reviewer_count: gateRecord.reviewer_outputs.length,
    disagreement_count: gateRecord.disagreements.length,
    stagnation_detected: gateRecord.stagnation_warning,
    quality_regression_detected: gateRecord.quality_regression !== null,
    human_escalation: gateRecord.human_escalation,

    category_scores: buildCategoryScoreMap(gateRecord.category_aggregates),
    finding_counts: countFindingsBySeverity(gateRecord.merged_findings),
    reviewer_metrics: buildReviewerMetrics(
      gateRecord.reviewer_outputs,
      gateRecord.aggregate_score
    ),
  };
}

// ---------------------------------------------------------------------------
// MetricsCollector
// ---------------------------------------------------------------------------

/**
 * Records per-gate and per-reviewer metrics for review gate executions.
 *
 * Implements ReviewGateEventListener so it can be registered as an observer
 * on the ReviewGateService.
 */
export class MetricsCollector implements ReviewGateEventListener {
  constructor(private store: MetricsStore) {}

  /**
   * Record metrics for a completed gate execution.
   *
   * Assembles a ReviewMetricsRecord and writes it to the store with retry logic.
   * Write failures are handled gracefully and never block the pipeline.
   */
  async recordGateMetrics(
    gateRecord: ReviewGateRecord,
    executionTimeMs: number
  ): Promise<void> {
    const record = buildMetricsRecord(gateRecord, executionTimeMs);
    await writeWithRetry(this.store, record);
  }

  /**
   * Observer callback: called when a gate execution completes.
   * Delegates to recordGateMetrics (fire-and-forget).
   */
  onGateCompleted(gateRecord: ReviewGateRecord, executionTimeMs: number): void {
    // Fire-and-forget: do not await, do not throw
    this.recordGateMetrics(gateRecord, executionTimeMs).catch(() => {
      // Swallow errors -- writeWithRetry already handles logging
    });
  }
}
