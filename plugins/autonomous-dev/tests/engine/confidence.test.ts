/**
 * Unit tests for the three-factor confidence scoring engine (SPEC-007-3-5, Task 13).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-5-04 through TC-3-5-12.
 */

import {
  computeConfidence,
  computeEvidenceScore,
  computeDedupScore,
  computeHistoryScore,
  CONFIDENCE_WEIGHTS,
} from '../../src/engine/confidence';
import type {
  ConfidenceScore,
  DeduplicationResult,
  TriageHistorySummary,
} from '../../src/engine/confidence';
import type { CandidateObservation } from '../../src/engine/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCandidate(
  overrides: Partial<CandidateObservation> = {},
): CandidateObservation {
  return {
    type: 'error',
    service: 'api-gateway',
    metric_value: 10.0,
    threshold_value: 5.0,
    sustained_minutes: 0,
    log_samples: [],
    data_sources_used: [],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
    ...overrides,
  };
}

function buildDedupResult(
  overrides: Partial<DeduplicationResult> = {},
): DeduplicationResult {
  return {
    action: 'new',
    ...overrides,
  };
}

function buildHistory(
  overrides: Partial<TriageHistorySummary> = {},
): TriageHistorySummary {
  return {
    total_similar: 0,
    promoted_count: 0,
    dismissed_count: 0,
    deferred_count: 0,
    investigating_count: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Weights verification
// ---------------------------------------------------------------------------

describe('CONFIDENCE_WEIGHTS', () => {
  it('weights sum to 1.0', () => {
    const sum =
      CONFIDENCE_WEIGHTS.evidence +
      CONFIDENCE_WEIGHTS.dedup +
      CONFIDENCE_WEIGHTS.history;
    expect(sum).toBe(1.0);
  });

  it('evidence weight is 0.50', () => {
    expect(CONFIDENCE_WEIGHTS.evidence).toBe(0.50);
  });

  it('dedup weight is 0.25', () => {
    expect(CONFIDENCE_WEIGHTS.dedup).toBe(0.25);
  });

  it('history weight is 0.25', () => {
    expect(CONFIDENCE_WEIGHTS.history).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// computeEvidenceScore
// ---------------------------------------------------------------------------

describe('computeEvidenceScore', () => {
  // TC-3-5-04: metric+log+alert -> 1.0
  it('TC-3-5-04: returns 1.0 for metric + log + alert', () => {
    const candidate = buildCandidate({
      data_sources_used: ['prometheus', 'opensearch', 'grafana'],
    });
    expect(computeEvidenceScore(candidate)).toBe(1.0);
  });

  // TC-3-5-05: metric+log only -> 0.8
  it('TC-3-5-05: returns 0.8 for metric + log only', () => {
    const candidate = buildCandidate({
      data_sources_used: ['prometheus', 'opensearch'],
    });
    expect(computeEvidenceScore(candidate)).toBe(0.8);
  });

  it('returns 0.7 for metric with sustained duration', () => {
    const candidate = buildCandidate({
      data_sources_used: ['prometheus'],
      sustained_minutes: 15,
    });
    expect(computeEvidenceScore(candidate)).toBe(0.7);
  });

  it('returns 0.6 for log with more than 10 samples', () => {
    const candidate = buildCandidate({
      data_sources_used: ['opensearch'],
      log_samples: Array.from({ length: 11 }, (_, i) => `Error ${i}`),
    });
    expect(computeEvidenceScore(candidate)).toBe(0.6);
  });

  // TC-3-5-06: single source -> 0.4
  it('TC-3-5-06: returns 0.4 for single source', () => {
    const candidate = buildCandidate({
      data_sources_used: ['prometheus'],
    });
    expect(computeEvidenceScore(candidate)).toBe(0.4);
  });

  // TC-3-5-07: data gaps -> 0.3
  it('TC-3-5-07: returns 0.3 for no data sources (gaps)', () => {
    const candidate = buildCandidate({
      data_sources_used: [],
    });
    expect(computeEvidenceScore(candidate)).toBe(0.3);
  });

  it('returns 0.4 for single opensearch source with few samples', () => {
    const candidate = buildCandidate({
      data_sources_used: ['opensearch'],
      log_samples: ['Error 1', 'Error 2'],
    });
    expect(computeEvidenceScore(candidate)).toBe(0.4);
  });
});

// ---------------------------------------------------------------------------
// computeDedupScore
// ---------------------------------------------------------------------------

describe('computeDedupScore', () => {
  // TC-3-5-08: promoted dedup -> 1.0
  it('TC-3-5-08: returns 1.0 for related_to_promoted', () => {
    expect(computeDedupScore(buildDedupResult({ action: 'related_to_promoted' }))).toBe(1.0);
  });

  // TC-3-5-09: new fingerprint -> 0.5
  it('TC-3-5-09: returns 0.5 for new fingerprint', () => {
    expect(computeDedupScore(buildDedupResult({ action: 'new' }))).toBe(0.5);
  });

  it('returns 0.3 for auto_dismiss', () => {
    expect(computeDedupScore(buildDedupResult({ action: 'auto_dismiss' }))).toBe(0.3);
  });

  it('returns 0.5 for merge_intra_run', () => {
    expect(computeDedupScore(buildDedupResult({ action: 'merge_intra_run' }))).toBe(0.5);
  });

  it('returns 0.7 for update_inter_run', () => {
    expect(computeDedupScore(buildDedupResult({ action: 'update_inter_run' }))).toBe(0.7);
  });
});

// ---------------------------------------------------------------------------
// computeHistoryScore
// ---------------------------------------------------------------------------

describe('computeHistoryScore', () => {
  it('returns 0.5 for new pattern with no history', () => {
    expect(computeHistoryScore(buildHistory({ total_similar: 0 }))).toBe(0.5);
  });

  // TC-3-5-10: mostly promoted -> 1.0
  it('TC-3-5-10: returns 1.0 for >80% promote rate', () => {
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 8,
      dismissed_count: 1,
      deferred_count: 1,
    });
    expect(computeHistoryScore(history)).toBe(1.0);
  });

  it('returns 1.0 for exactly 9/10 promote rate (>80%)', () => {
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 9,
      dismissed_count: 1,
    });
    expect(computeHistoryScore(history)).toBe(1.0);
  });

  it('returns 0.7 for mixed history (50-80% promote rate)', () => {
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 6,
      dismissed_count: 4,
    });
    expect(computeHistoryScore(history)).toBe(0.7);
  });

  it('returns 0.7 for exactly 50% promote rate', () => {
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 5,
      dismissed_count: 5,
    });
    expect(computeHistoryScore(history)).toBe(0.7);
  });

  // TC-3-5-11: mostly dismissed -> 0.2
  it('TC-3-5-11: returns 0.2 for >50% dismiss rate', () => {
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 2,
      dismissed_count: 6,
      deferred_count: 2,
    });
    expect(computeHistoryScore(history)).toBe(0.2);
  });

  it('returns 0.5 for low promote rate and low dismiss rate', () => {
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 3,
      dismissed_count: 3,
      deferred_count: 4,
    });
    expect(computeHistoryScore(history)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// computeConfidence (composite)
// ---------------------------------------------------------------------------

describe('computeConfidence', () => {
  // TC-3-5-12: composite calculation
  it('TC-3-5-12: computes weighted composite correctly', () => {
    // evidence=1.0 (metric+log+alert), dedup=0.5 (new), history=0.5 (no history)
    const candidate = buildCandidate({
      data_sources_used: ['prometheus', 'opensearch', 'grafana'],
    });
    const dedup = buildDedupResult({ action: 'new' });
    const history = buildHistory({ total_similar: 0 });

    const score = computeConfidence(candidate, dedup, history);

    // 0.50 * 1.0 + 0.25 * 0.5 + 0.25 * 0.5 = 0.75
    expect(score.evidence_score).toBe(1.0);
    expect(score.dedup_score).toBe(0.5);
    expect(score.history_score).toBe(0.5);
    expect(score.composite).toBe(0.75);
  });

  it('computes composite for all-max scores', () => {
    const candidate = buildCandidate({
      data_sources_used: ['prometheus', 'opensearch', 'grafana'],
    });
    const dedup = buildDedupResult({ action: 'related_to_promoted' });
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 9,
    });

    const score = computeConfidence(candidate, dedup, history);

    // 0.50 * 1.0 + 0.25 * 1.0 + 0.25 * 1.0 = 1.0
    expect(score.composite).toBe(1.0);
  });

  it('computes composite for all-min scores', () => {
    const candidate = buildCandidate({
      data_sources_used: [],
    });
    const dedup = buildDedupResult({ action: 'auto_dismiss' });
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 1,
      dismissed_count: 8,
      deferred_count: 1,
    });

    const score = computeConfidence(candidate, dedup, history);

    // 0.50 * 0.3 + 0.25 * 0.3 + 0.25 * 0.2 = 0.15 + 0.075 + 0.05 = 0.275
    expect(score.evidence_score).toBe(0.3);
    expect(score.dedup_score).toBe(0.3);
    expect(score.history_score).toBe(0.2);
    expect(score.composite).toBeCloseTo(0.275, 10);
  });

  it('returns all factor scores in result', () => {
    const candidate = buildCandidate({
      data_sources_used: ['prometheus', 'opensearch'],
    });
    const dedup = buildDedupResult({ action: 'update_inter_run' });
    const history = buildHistory({
      total_similar: 10,
      promoted_count: 7,
      dismissed_count: 3,
    });

    const score = computeConfidence(candidate, dedup, history);

    expect(score).toHaveProperty('composite');
    expect(score).toHaveProperty('evidence_score');
    expect(score).toHaveProperty('dedup_score');
    expect(score).toHaveProperty('history_score');

    // evidence=0.8, dedup=0.7, history=0.7
    expect(score.evidence_score).toBe(0.8);
    expect(score.dedup_score).toBe(0.7);
    expect(score.history_score).toBe(0.7);
    // 0.50 * 0.8 + 0.25 * 0.7 + 0.25 * 0.7 = 0.4 + 0.175 + 0.175 = 0.75
    expect(score.composite).toBe(0.75);
  });

  it('composite is always in range [0.0, 1.0]', () => {
    // Test several combinations to ensure range
    const combos: Array<{
      sources: string[];
      action: 'new' | 'related_to_promoted' | 'auto_dismiss';
      totalSimilar: number;
      promoted: number;
      dismissed: number;
    }> = [
      { sources: [], action: 'auto_dismiss', totalSimilar: 10, promoted: 0, dismissed: 10 },
      { sources: ['prometheus', 'opensearch', 'grafana'], action: 'related_to_promoted', totalSimilar: 10, promoted: 10, dismissed: 0 },
      { sources: ['prometheus'], action: 'new', totalSimilar: 0, promoted: 0, dismissed: 0 },
    ];

    for (const combo of combos) {
      const candidate = buildCandidate({ data_sources_used: combo.sources });
      const dedup = buildDedupResult({ action: combo.action });
      const history = buildHistory({
        total_similar: combo.totalSimilar,
        promoted_count: combo.promoted,
        dismissed_count: combo.dismissed,
      });

      const score = computeConfidence(candidate, dedup, history);
      expect(score.composite).toBeGreaterThanOrEqual(0.0);
      expect(score.composite).toBeLessThanOrEqual(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-3-6: All lookup table combinations verified
// ---------------------------------------------------------------------------

describe('All confidence lookup table combinations (SPEC-007-3-6)', () => {
  describe('Evidence score lookup table', () => {
    it('metric + log + alert -> 1.0', () => {
      expect(computeEvidenceScore(buildCandidate({
        data_sources_used: ['prometheus', 'opensearch', 'grafana'],
      }))).toBe(1.0);
    });

    it('metric + log -> 0.8', () => {
      expect(computeEvidenceScore(buildCandidate({
        data_sources_used: ['prometheus', 'opensearch'],
      }))).toBe(0.8);
    });

    it('metric + sustained -> 0.7', () => {
      expect(computeEvidenceScore(buildCandidate({
        data_sources_used: ['prometheus'],
        sustained_minutes: 10,
      }))).toBe(0.7);
    });

    it('log + 10+ samples -> 0.6', () => {
      expect(computeEvidenceScore(buildCandidate({
        data_sources_used: ['opensearch'],
        log_samples: Array.from({ length: 11 }, (_, i) => `e${i}`),
      }))).toBe(0.6);
    });

    it('single source -> 0.4', () => {
      expect(computeEvidenceScore(buildCandidate({
        data_sources_used: ['prometheus'],
      }))).toBe(0.4);
    });

    it('data gaps (empty sources) -> 0.3', () => {
      expect(computeEvidenceScore(buildCandidate({
        data_sources_used: [],
      }))).toBe(0.3);
    });
  });

  describe('Dedup score lookup table', () => {
    it('related_to_promoted -> 1.0', () => {
      expect(computeDedupScore(buildDedupResult({ action: 'related_to_promoted' }))).toBe(1.0);
    });

    it('update_inter_run -> 0.7', () => {
      expect(computeDedupScore(buildDedupResult({ action: 'update_inter_run' }))).toBe(0.7);
    });

    it('new -> 0.5', () => {
      expect(computeDedupScore(buildDedupResult({ action: 'new' }))).toBe(0.5);
    });

    it('merge_intra_run -> 0.5', () => {
      expect(computeDedupScore(buildDedupResult({ action: 'merge_intra_run' }))).toBe(0.5);
    });

    it('auto_dismiss -> 0.3', () => {
      expect(computeDedupScore(buildDedupResult({ action: 'auto_dismiss' }))).toBe(0.3);
    });
  });

  describe('History score lookup table', () => {
    it('no history (total=0) -> 0.5', () => {
      expect(computeHistoryScore(buildHistory({ total_similar: 0 }))).toBe(0.5);
    });

    it('promote rate > 80% -> 1.0', () => {
      expect(computeHistoryScore(buildHistory({
        total_similar: 10,
        promoted_count: 9,
        dismissed_count: 1,
      }))).toBe(1.0);
    });

    it('promote rate exactly 80% -> 0.7 (not >80%)', () => {
      expect(computeHistoryScore(buildHistory({
        total_similar: 10,
        promoted_count: 8,
        dismissed_count: 2,
      }))).toBe(0.7);
    });

    it('promote rate >= 50% -> 0.7', () => {
      expect(computeHistoryScore(buildHistory({
        total_similar: 10,
        promoted_count: 5,
        dismissed_count: 5,
      }))).toBe(0.7);
    });

    it('dismiss rate > 50% -> 0.2', () => {
      expect(computeHistoryScore(buildHistory({
        total_similar: 10,
        promoted_count: 1,
        dismissed_count: 6,
        deferred_count: 3,
      }))).toBe(0.2);
    });

    it('everything else -> 0.5', () => {
      // promote < 50%, dismiss <= 50%
      expect(computeHistoryScore(buildHistory({
        total_similar: 10,
        promoted_count: 4,
        dismissed_count: 4,
        deferred_count: 2,
      }))).toBe(0.5);
    });
  });

  describe('Full composite combinations', () => {
    it('max evidence + max dedup + max history -> 1.0', () => {
      const score = computeConfidence(
        buildCandidate({ data_sources_used: ['prometheus', 'opensearch', 'grafana'] }),
        buildDedupResult({ action: 'related_to_promoted' }),
        buildHistory({ total_similar: 10, promoted_count: 9 }),
      );
      expect(score.composite).toBe(1.0);
    });

    it('min evidence + min dedup + min history -> 0.275', () => {
      const score = computeConfidence(
        buildCandidate({ data_sources_used: [] }),
        buildDedupResult({ action: 'auto_dismiss' }),
        buildHistory({ total_similar: 10, promoted_count: 0, dismissed_count: 8 }),
      );
      // 0.50*0.3 + 0.25*0.3 + 0.25*0.2 = 0.15 + 0.075 + 0.05 = 0.275
      expect(score.composite).toBeCloseTo(0.275, 10);
    });

    it('mid evidence + mid dedup + mid history', () => {
      const score = computeConfidence(
        buildCandidate({ data_sources_used: ['prometheus', 'opensearch'] }),
        buildDedupResult({ action: 'new' }),
        buildHistory({ total_similar: 0 }),
      );
      // 0.50*0.8 + 0.25*0.5 + 0.25*0.5 = 0.4 + 0.125 + 0.125 = 0.65
      expect(score.composite).toBeCloseTo(0.65, 10);
    });
  });
});
