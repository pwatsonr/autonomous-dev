/**
 * Three-factor weighted confidence scoring (SPEC-007-3-5, Task 13).
 *
 * Computes a composite confidence score for each candidate observation
 * based on three weighted factors per TDD section 3.8:
 *   1. Evidence strength (0.50 weight) -- data source coverage
 *   2. Deduplication quality (0.25 weight) -- fingerprint match status
 *   3. Historical triage outcome (0.25 weight) -- false positive rate
 *
 * Each factor produces a score in [0.0, 1.0]. The composite is the
 * weighted sum, also in [0.0, 1.0].
 */

import type { CandidateObservation } from './types';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Breakdown of the three-factor confidence score.
 */
export interface ConfidenceScore {
  /** Weighted composite score in [0.0, 1.0]. */
  composite: number;

  /** Evidence strength score in [0.0, 1.0]. */
  evidence_score: number;

  /** Deduplication match quality score in [0.0, 1.0]. */
  dedup_score: number;

  /** Historical triage outcome score in [0.0, 1.0]. */
  history_score: number;
}

/**
 * Possible dedup actions from the deduplication engine.
 */
export type DeduplicationAction =
  | 'related_to_promoted'
  | 'new'
  | 'auto_dismiss'
  | 'merge_intra_run'
  | 'update_inter_run';

/**
 * Result from the deduplication engine used as input to confidence scoring.
 */
export interface DeduplicationResult {
  /** The action the dedup engine decided on. */
  action: DeduplicationAction;

  /** Optional similarity score for fuzzy matches. */
  similarity?: number;
}

/**
 * Summary of historical triage decisions for similar observations.
 */
export interface TriageHistorySummary {
  /** Total number of similar observations in history. */
  total_similar: number;

  /** Number that were promoted to reports. */
  promoted_count: number;

  /** Number that were dismissed as false positives. */
  dismissed_count: number;

  /** Number that were deferred for later review. */
  deferred_count: number;

  /** Number currently under investigation. */
  investigating_count: number;
}

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

/**
 * Weights for the three confidence factors per TDD section 3.8.
 */
export const CONFIDENCE_WEIGHTS = {
  evidence: 0.50,
  dedup: 0.25,
  history: 0.25,
} as const;

// ---------------------------------------------------------------------------
// Factor computations
// ---------------------------------------------------------------------------

/**
 * Computes the evidence strength score based on data source coverage.
 *
 * Lookup table from TDD section 3.8:
 *   - metric + log + alert  -> 1.0
 *   - metric + log          -> 0.8
 *   - metric + sustained    -> 0.7
 *   - log + 10+ samples     -> 0.6
 *   - single source         -> 0.4
 *   - data gaps             -> 0.3
 */
export function computeEvidenceScore(candidate: CandidateObservation): number {
  const sources = candidate.data_sources_used;
  const hasMetric = sources.includes('prometheus');
  const hasLog = sources.includes('opensearch');
  const hasAlert = sources.includes('grafana');

  if (hasMetric && hasLog && hasAlert) return 1.0;
  if (hasMetric && hasLog) return 0.8;
  if (hasMetric && candidate.sustained_minutes > 0) return 0.7;
  if (hasLog && candidate.log_samples.length > 10) return 0.6;
  if (sources.length === 1) return 0.4;

  // Data source gaps or unrecognized configuration
  return 0.3;
}

/**
 * Computes the deduplication quality score based on the dedup engine's
 * action.
 *
 * Lookup table from TDD section 3.8:
 *   - related_to_promoted  -> 1.0  (exact match to promoted observation)
 *   - update_inter_run     -> 0.7  (recurring issue still pending)
 *   - new                  -> 0.5  (new fingerprint, no matches)
 *   - merge_intra_run      -> 0.5  (treat as new within same run)
 *   - auto_dismiss          -> 0.3  (similar to dismissed observation)
 */
export function computeDedupScore(dedupResult: DeduplicationResult): number {
  switch (dedupResult.action) {
    case 'related_to_promoted':
      return 1.0;
    case 'update_inter_run':
      return 0.7;
    case 'new':
      return 0.5;
    case 'merge_intra_run':
      return 0.5;
    case 'auto_dismiss':
      return 0.3;
    default:
      return 0.5;
  }
}

/**
 * Computes the historical triage outcome score based on past decisions
 * for similar observations.
 *
 * Lookup table from TDD section 3.8:
 *   - no history (total_similar === 0) -> 0.5  (neutral)
 *   - promote rate > 80%               -> 1.0  (historically promoted)
 *   - promote rate >= 50%              -> 0.7  (mixed history)
 *   - dismiss rate > 50%               -> 0.2  (mostly dismissed)
 *   - everything else                  -> 0.5  (neutral)
 */
export function computeHistoryScore(history: TriageHistorySummary): number {
  if (history.total_similar === 0) return 0.5; // New pattern, no history

  const promoteRate = history.promoted_count / history.total_similar;

  if (promoteRate > 0.80) return 1.0;  // Historically promoted at >80%
  if (promoteRate >= 0.50) return 0.7; // Mixed history

  const dismissRate = history.dismissed_count / history.total_similar;
  if (dismissRate > 0.50) return 0.2;  // Mostly dismissed

  return 0.5;
}

// ---------------------------------------------------------------------------
// Composite confidence
// ---------------------------------------------------------------------------

/**
 * Computes the three-factor weighted composite confidence score.
 *
 * Formula: composite = 0.50 * evidence + 0.25 * dedup + 0.25 * history
 *
 * @param candidate     The candidate observation being scored
 * @param dedupResult   Result from the deduplication engine
 * @param triageHistory Summary of historical triage decisions
 * @returns Breakdown of all three factor scores and the composite
 */
export function computeConfidence(
  candidate: CandidateObservation,
  dedupResult: DeduplicationResult,
  triageHistory: TriageHistorySummary,
): ConfidenceScore {
  const evidenceScore = computeEvidenceScore(candidate);
  const dedupScore = computeDedupScore(dedupResult);
  const historyScore = computeHistoryScore(triageHistory);

  const composite =
    CONFIDENCE_WEIGHTS.evidence * evidenceScore +
    CONFIDENCE_WEIGHTS.dedup * dedupScore +
    CONFIDENCE_WEIGHTS.history * historyScore;

  return {
    composite,
    evidence_score: evidenceScore,
    dedup_score: dedupScore,
    history_score: historyScore,
  };
}
