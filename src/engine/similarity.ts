/**
 * Fuzzy similarity matching (SPEC-007-3-3, Task 8).
 *
 * Near-duplicate detection for cases where exact fingerprints differ
 * but the underlying issue is the same. Three methods are used:
 *
 *   1. **Jaccard similarity** on normalized stack frames (threshold > 80%)
 *   2. **Levenshtein similarity** on error messages (threshold > 80%,
 *      equivalent to distance < 20% of the longer string)
 *   3. **Temporal correlation** -- same service, error spike within 5 minutes
 *
 * When a fuzzy match is found, the new candidate and the existing
 * observation should be presented to the LLM for a merge/separate
 * decision. Fuzzy matches are NOT automatically merged.
 */

import type {
  CandidateObservation,
  ObservationSummary,
  SimilarityMatch,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum Jaccard similarity score to flag a stack-frame match. */
const JACCARD_THRESHOLD = 0.80;

/** Minimum Levenshtein similarity score to flag a message match. */
const LEVENSHTEIN_THRESHOLD = 0.80;

/** Maximum time difference (ms) for temporal correlation. */
const TEMPORAL_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// Jaccard similarity on stack frames
// ---------------------------------------------------------------------------

/**
 * Computes the Jaccard similarity coefficient between two sets of
 * normalized stack frames.
 *
 * `J(A, B) = |A n B| / |A u B|`
 *
 * Returns 0 when both sets are empty.
 */
export function jaccardStackSimilarity(framesA: string[], framesB: string[]): number {
  const setA = new Set(framesA);
  const setB = new Set(framesB);
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

// ---------------------------------------------------------------------------
// Levenshtein distance / similarity
// ---------------------------------------------------------------------------

/**
 * Computes the Levenshtein (edit) distance between two strings using
 * the classic dynamic programming approach.
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,        // deletion
        matrix[i][j - 1] + 1,        // insertion
        matrix[i - 1][j - 1] + cost, // substitution
      );
    }
  }
  return matrix[a.length][b.length];
}

/**
 * Returns a normalised similarity score in `[0, 1]` derived from the
 * Levenshtein distance.
 *
 * `similarity = 1 - (distance / max(len(a), len(b)))`
 *
 * Two empty strings have similarity `1.0`.
 */
export function levenshteinSimilarity(a: string, b: string): number {
  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1.0 - distance / maxLen;
}

// ---------------------------------------------------------------------------
// Temporal correlation
// ---------------------------------------------------------------------------

/**
 * Returns `true` when two observations belong to the same service and
 * occurred within a 5-minute window.
 */
export function temporalCorrelation(
  candidateTimestamp: Date,
  existingTimestamp: Date,
  candidateService: string,
  existingService: string,
): boolean {
  if (candidateService !== existingService) return false;
  const diffMs = Math.abs(candidateTimestamp.getTime() - existingTimestamp.getTime());
  return diffMs <= TEMPORAL_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Composite fuzzy matcher
// ---------------------------------------------------------------------------

/**
 * Finds existing observations that are fuzzy-similar to the given
 * candidate.
 *
 * Each existing observation is checked against all three methods in
 * order (Jaccard -> Levenshtein -> temporal). At most one match per
 * existing observation is returned (the first method that exceeds its
 * threshold wins).
 *
 * @returns Array of similarity matches (possibly empty).
 */
export async function findSimilarObservations(
  candidate: CandidateObservation,
  recentObservations: ObservationSummary[],
): Promise<SimilarityMatch[]> {
  const matches: SimilarityMatch[] = [];

  for (const existing of recentObservations) {
    // Check 1: Jaccard on stack frames (> 80%)
    if (candidate.stack_frames && existing.stack_frames) {
      const jaccard = jaccardStackSimilarity(candidate.stack_frames, existing.stack_frames);
      if (jaccard > JACCARD_THRESHOLD) {
        matches.push({
          matched: true,
          method: 'jaccard_stack',
          similarity_score: jaccard,
          existing_observation_id: existing.id,
        });
        continue; // One match per existing observation
      }
    }

    // Check 2: Levenshtein on error messages (> 80% similarity)
    if (candidate.error_message && existing.error_message) {
      const similarity = levenshteinSimilarity(candidate.error_message, existing.error_message);
      if (similarity > LEVENSHTEIN_THRESHOLD) {
        matches.push({
          matched: true,
          method: 'levenshtein_message',
          similarity_score: similarity,
          existing_observation_id: existing.id,
        });
        continue;
      }
    }

    // Check 3: Temporal correlation (same service, within 5 min)
    if (
      candidate.timestamp &&
      existing.timestamp &&
      temporalCorrelation(
        candidate.timestamp,
        existing.timestamp,
        candidate.service,
        existing.service,
      )
    ) {
      matches.push({
        matched: true,
        method: 'temporal_correlation',
        similarity_score: 1.0,
        existing_observation_id: existing.id,
      });
    }
  }

  return matches;
}
