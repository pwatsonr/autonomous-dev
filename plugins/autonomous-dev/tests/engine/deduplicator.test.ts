/**
 * Unit tests for the three-window deduplication engine
 * (SPEC-007-3-3, Task 7).
 *
 * Test case IDs correspond to the spec's test case table:
 *   TC-3-3-08 through TC-3-3-13.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Deduplicator } from '../../src/engine/deduplicator';
import type {
  CandidateObservation,
  FingerprintStore,
} from '../../src/engine/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildCandidate(
  overrides: Partial<CandidateObservation> = {},
): CandidateObservation {
  return {
    type: 'error',
    error_type: 'error_rate',
    service: 'api-gateway',
    metric_value: 12.3,
    threshold_value: 5.0,
    sustained_minutes: 15,
    log_samples: [],
    data_sources_used: ['prometheus'],
    has_data_loss_indicator: false,
    has_data_corruption_indicator: false,
    observation_id: 'obs-001',
    ...overrides,
  };
}

/** Returns an ISO string for `daysAgo` days before `now`. */
function daysAgo(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

const FINGERPRINT = 'a'.repeat(64);

// ---------------------------------------------------------------------------
// Intra-run dedup (Window 1)
// ---------------------------------------------------------------------------

describe('Deduplicator - Window 1: Intra-run', () => {
  it('TC-3-3-08: merges two candidates with the same fingerprint in one run', () => {
    const dedup = new Deduplicator('/tmp/fp-test');

    const candidateA = buildCandidate({ observation_id: 'obs-A' });
    const candidateB = buildCandidate({ observation_id: 'obs-B' });

    // First candidate is new
    const resultA = dedup.deduplicate(candidateA, FINGERPRINT);
    expect(resultA.action).toBe('new');

    // Second candidate with same fingerprint merges
    const resultB = dedup.deduplicate(candidateB, FINGERPRINT);
    expect(resultB.action).toBe('merge_intra_run');
    expect(resultB.existing_observation_id).toBe('obs-A');

    // occurrence_count should be 2
    const existing = dedup.getIntraRunMap().get(FINGERPRINT)!;
    expect(existing.occurrence_count).toBe(2);
  });

  it('increments occurrence_count for each additional duplicate', () => {
    const dedup = new Deduplicator('/tmp/fp-test');

    const candidate = buildCandidate({ observation_id: 'obs-1' });
    dedup.deduplicate(candidate, FINGERPRINT);

    for (let i = 0; i < 5; i++) {
      const result = dedup.deduplicate(buildCandidate(), FINGERPRINT);
      expect(result.action).toBe('merge_intra_run');
    }

    const existing = dedup.getIntraRunMap().get(FINGERPRINT)!;
    expect(existing.occurrence_count).toBe(6); // 1 original + 5 merges
  });
});

// ---------------------------------------------------------------------------
// Inter-run dedup (Window 2)
// ---------------------------------------------------------------------------

describe('Deduplicator - Window 2: Inter-run (7 days)', () => {
  it('TC-3-3-09: updates pending observation from 3 days ago', () => {
    const now = new Date('2026-04-08T12:00:00Z');
    const dedup = new Deduplicator('/tmp/fp-test');

    // Simulate a loaded store with a pending fingerprint from 3 days ago
    const store = dedup.getStore();
    store.fingerprints.push({
      hash: FINGERPRINT,
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      first_seen: daysAgo(5, now),
      last_seen: daysAgo(3, now),
      occurrence_count: 3,
      linked_observation_id: 'obs-existing-001',
      triage_status: 'pending',
    });

    const candidate = buildCandidate();
    const result = dedup.deduplicate(candidate, FINGERPRINT, now);

    expect(result.action).toBe('update_inter_run');
    expect(result.existing_observation_id).toBe('obs-existing-001');
    expect(result.reason).toContain('obs-existing-001');

    // occurrence_count should be incremented
    expect(store.fingerprints[0].occurrence_count).toBe(4);
    // last_seen should be updated to now
    expect(store.fingerprints[0].last_seen).toBe(now.toISOString());
  });

  it('TC-3-3-10: does NOT match pending observation older than 7 days', () => {
    const now = new Date('2026-04-08T12:00:00Z');
    const dedup = new Deduplicator('/tmp/fp-test');

    const store = dedup.getStore();
    store.fingerprints.push({
      hash: FINGERPRINT,
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      first_seen: daysAgo(15, now),
      last_seen: daysAgo(10, now), // 10 days ago -- outside 7d window
      occurrence_count: 1,
      linked_observation_id: 'obs-old-001',
      triage_status: 'pending',
    });

    const candidate = buildCandidate();
    const result = dedup.deduplicate(candidate, FINGERPRINT, now);

    expect(result.action).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// Post-triage dedup (Window 3)
// ---------------------------------------------------------------------------

describe('Deduplicator - Window 3: Post-triage (30 days)', () => {
  it('TC-3-3-11: auto-dismisses when matching a dismissed observation from 15 days ago', () => {
    const now = new Date('2026-04-08T12:00:00Z');
    const dedup = new Deduplicator('/tmp/fp-test');

    const store = dedup.getStore();
    store.fingerprints.push({
      hash: FINGERPRINT,
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      first_seen: daysAgo(20, now),
      last_seen: daysAgo(15, now),
      occurrence_count: 5,
      linked_observation_id: 'obs-dismissed-001',
      triage_status: 'dismissed',
    });

    const candidate = buildCandidate();
    const result = dedup.deduplicate(candidate, FINGERPRINT, now);

    expect(result.action).toBe('auto_dismiss');
    expect(result.existing_observation_id).toBe('obs-dismissed-001');
    expect(result.reason).toBe('previously_dismissed_duplicate');
  });

  it('TC-3-3-12: flags as related_to_promoted when matching a promoted observation from 20 days ago', () => {
    const now = new Date('2026-04-08T12:00:00Z');
    const dedup = new Deduplicator('/tmp/fp-test');

    const store = dedup.getStore();
    store.fingerprints.push({
      hash: FINGERPRINT,
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      first_seen: daysAgo(25, now),
      last_seen: daysAgo(20, now),
      occurrence_count: 10,
      linked_observation_id: 'obs-promoted-001',
      triage_status: 'promoted',
    });

    const candidate = buildCandidate();
    const result = dedup.deduplicate(candidate, FINGERPRINT, now);

    expect(result.action).toBe('related_to_promoted');
    expect(result.existing_observation_id).toBe('obs-promoted-001');
    expect(result.reason).toBe('related_to_promoted');
  });

  it('TC-3-3-13: does NOT match dismissed observation older than 30 days', () => {
    const now = new Date('2026-04-08T12:00:00Z');
    const dedup = new Deduplicator('/tmp/fp-test');

    const store = dedup.getStore();
    store.fingerprints.push({
      hash: FINGERPRINT,
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      first_seen: daysAgo(40, now),
      last_seen: daysAgo(35, now), // 35 days ago -- outside 30d window
      occurrence_count: 2,
      linked_observation_id: 'obs-expired-001',
      triage_status: 'dismissed',
    });

    const candidate = buildCandidate();
    const result = dedup.deduplicate(candidate, FINGERPRINT, now);

    expect(result.action).toBe('new');
  });
});

// ---------------------------------------------------------------------------
// Window priority
// ---------------------------------------------------------------------------

describe('Deduplicator - Window priority', () => {
  it('intra-run takes precedence over inter-run', () => {
    const now = new Date('2026-04-08T12:00:00Z');
    const dedup = new Deduplicator('/tmp/fp-test');

    // Add a pending inter-run match
    const store = dedup.getStore();
    store.fingerprints.push({
      hash: FINGERPRINT,
      service: 'api-gateway',
      error_class: 'ConnectionPoolExhausted',
      endpoint: '/api/v2/orders',
      first_seen: daysAgo(3, now),
      last_seen: daysAgo(1, now),
      occurrence_count: 1,
      linked_observation_id: 'obs-inter-001',
      triage_status: 'pending',
    });

    // First candidate -> new (registers in intra-run)
    const candidate1 = buildCandidate({ observation_id: 'obs-new-1' });
    const result1 = dedup.deduplicate(candidate1, FINGERPRINT, now);
    // This should match inter-run first since intra-run is empty
    expect(result1.action).toBe('update_inter_run');

    // Now there is an intra-run entry. Reset and try again.
    // Actually, the first candidate matched inter-run, so intra-run is not set.
    // Let's use a different fingerprint for the inter-run entry.
    const FP2 = 'b'.repeat(64);
    dedup.resetIntraRun();

    // First: new candidate -> new (adds to intra-run)
    const c1 = buildCandidate({ observation_id: 'obs-intra-1' });
    const r1 = dedup.deduplicate(c1, FP2, now);
    expect(r1.action).toBe('new');

    // Second: same fingerprint -> should be intra-run merge
    const c2 = buildCandidate({ observation_id: 'obs-intra-2' });
    const r2 = dedup.deduplicate(c2, FP2, now);
    expect(r2.action).toBe('merge_intra_run');
    expect(r2.existing_observation_id).toBe('obs-intra-1');
  });
});

// ---------------------------------------------------------------------------
// registerFingerprint
// ---------------------------------------------------------------------------

describe('Deduplicator - registerFingerprint', () => {
  it('adds a new entry to the store', () => {
    const dedup = new Deduplicator('/tmp/fp-test');
    const candidate = buildCandidate({
      service: 'payment-svc',
      error_class: 'TimeoutError',
      endpoint: '/pay',
      observation_id: 'obs-new-fp',
    });

    dedup.registerFingerprint(FINGERPRINT, candidate);

    const store = dedup.getStore();
    expect(store.fingerprints).toHaveLength(1);
    expect(store.fingerprints[0].hash).toBe(FINGERPRINT);
    expect(store.fingerprints[0].service).toBe('payment-svc');
    expect(store.fingerprints[0].error_class).toBe('TimeoutError');
    expect(store.fingerprints[0].endpoint).toBe('/pay');
    expect(store.fingerprints[0].linked_observation_id).toBe('obs-new-fp');
    expect(store.fingerprints[0].triage_status).toBe('pending');
    expect(store.fingerprints[0].occurrence_count).toBe(1);
  });

  it('uses defaults for missing optional fields', () => {
    const dedup = new Deduplicator('/tmp/fp-test');
    const candidate = buildCandidate({
      error_class: undefined,
      endpoint: undefined,
      observation_id: undefined,
    });

    dedup.registerFingerprint(FINGERPRINT, candidate);

    const entry = dedup.getStore().fingerprints[0];
    expect(entry.error_class).toBe('unknown');
    expect(entry.endpoint).toBe('*');
    expect(entry.linked_observation_id).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Persistence (load / save)
// ---------------------------------------------------------------------------

describe('Deduplicator - persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves and loads the fingerprint store', async () => {
    const dedup = new Deduplicator(tmpDir);
    const candidate = buildCandidate({
      service: 'test-svc',
      observation_id: 'obs-persist',
    });

    dedup.registerFingerprint(FINGERPRINT, candidate);
    await dedup.save('test-svc');

    // Load into a fresh instance
    const dedup2 = new Deduplicator(tmpDir);
    await dedup2.load('test-svc');

    const store = dedup2.getStore();
    expect(store.fingerprints).toHaveLength(1);
    expect(store.fingerprints[0].hash).toBe(FINGERPRINT);
    expect(store.fingerprints[0].linked_observation_id).toBe('obs-persist');
  });

  it('loads empty store when file does not exist', async () => {
    const dedup = new Deduplicator(tmpDir);
    await dedup.load('nonexistent-service');

    const store = dedup.getStore();
    expect(store.fingerprints).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resetIntraRun
// ---------------------------------------------------------------------------

describe('Deduplicator - resetIntraRun', () => {
  it('clears the intra-run map', () => {
    const dedup = new Deduplicator('/tmp/fp-test');
    const candidate = buildCandidate({ observation_id: 'obs-reset' });

    dedup.deduplicate(candidate, FINGERPRINT);
    expect(dedup.getIntraRunMap().size).toBe(1);

    dedup.resetIntraRun();
    expect(dedup.getIntraRunMap().size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SPEC-007-3-6: All three window tests with concrete scenarios
// ---------------------------------------------------------------------------

describe('Deduplicator - all three windows (SPEC-007-3-6)', () => {
  describe('Window 1: Intra-run merge increments count', () => {
    it('three candidates with same fingerprint -> occurrence_count = 3', () => {
      const dedup = new Deduplicator('/tmp/fp-test');
      const fp = 'c'.repeat(64);

      const c1 = buildCandidate({ observation_id: 'obs-w1-1' });
      const r1 = dedup.deduplicate(c1, fp);
      expect(r1.action).toBe('new');

      const c2 = buildCandidate({ observation_id: 'obs-w1-2' });
      const r2 = dedup.deduplicate(c2, fp);
      expect(r2.action).toBe('merge_intra_run');

      const c3 = buildCandidate({ observation_id: 'obs-w1-3' });
      const r3 = dedup.deduplicate(c3, fp);
      expect(r3.action).toBe('merge_intra_run');

      const stored = dedup.getIntraRunMap().get(fp)!;
      expect(stored.occurrence_count).toBe(3);
    });

    it('different fingerprints are tracked separately', () => {
      const dedup = new Deduplicator('/tmp/fp-test');
      const fp1 = 'd'.repeat(64);
      const fp2 = 'e'.repeat(64);

      const c1 = buildCandidate({ observation_id: 'obs-d1' });
      dedup.deduplicate(c1, fp1);

      const c2 = buildCandidate({ observation_id: 'obs-e1' });
      dedup.deduplicate(c2, fp2);

      // Both should be new
      expect(dedup.getIntraRunMap().size).toBe(2);

      // Merge only fp1
      const c3 = buildCandidate({ observation_id: 'obs-d2' });
      const r3 = dedup.deduplicate(c3, fp1);
      expect(r3.action).toBe('merge_intra_run');

      expect(dedup.getIntraRunMap().get(fp1)!.occurrence_count).toBe(2);
      expect(dedup.getIntraRunMap().get(fp2)!.occurrence_count).toBeUndefined();
    });
  });

  describe('Window 2: Inter-run updates pending', () => {
    it('updates pending observation from 1 day ago', () => {
      const now = new Date('2026-04-08T12:00:00Z');
      const dedup = new Deduplicator('/tmp/fp-test');
      const fp = 'f'.repeat(64);

      dedup.getStore().fingerprints.push({
        hash: fp,
        service: 'api-gateway',
        error_class: 'TimeoutError',
        endpoint: '/api/health',
        first_seen: daysAgo(2, now),
        last_seen: daysAgo(1, now),
        occurrence_count: 5,
        linked_observation_id: 'obs-recent-001',
        triage_status: 'pending',
      });

      const candidate = buildCandidate();
      const result = dedup.deduplicate(candidate, fp, now);

      expect(result.action).toBe('update_inter_run');
      expect(result.existing_observation_id).toBe('obs-recent-001');

      // Verify the store was updated
      const entry = dedup.getStore().fingerprints[0];
      expect(entry.occurrence_count).toBe(6);
      expect(entry.last_seen).toBe(now.toISOString());
    });

    it('does not match non-pending observations in inter-run window', () => {
      const now = new Date('2026-04-08T12:00:00Z');
      const dedup = new Deduplicator('/tmp/fp-test');
      const fp = 'f'.repeat(64);

      // Dismissed within 7 days -> should NOT match inter-run (only post-triage)
      dedup.getStore().fingerprints.push({
        hash: fp,
        service: 'api-gateway',
        error_class: 'TimeoutError',
        endpoint: '/api/health',
        first_seen: daysAgo(5, now),
        last_seen: daysAgo(2, now),
        occurrence_count: 3,
        linked_observation_id: 'obs-dismissed-recent',
        triage_status: 'dismissed',
      });

      const candidate = buildCandidate();
      const result = dedup.deduplicate(candidate, fp, now);

      // Should match post-triage (auto_dismiss), not inter-run
      expect(result.action).toBe('auto_dismiss');
    });
  });

  describe('Window 3: Post-triage auto-dismisses', () => {
    it('auto-dismisses when matching dismissed observation from 10 days ago', () => {
      const now = new Date('2026-04-08T12:00:00Z');
      const dedup = new Deduplicator('/tmp/fp-test');
      const fp = 'g'.repeat(64);

      dedup.getStore().fingerprints.push({
        hash: fp,
        service: 'api-gateway',
        error_class: 'ConnectionReset',
        endpoint: '/api/v2/users',
        first_seen: daysAgo(20, now),
        last_seen: daysAgo(10, now),
        occurrence_count: 8,
        linked_observation_id: 'obs-dismissed-010',
        triage_status: 'dismissed',
      });

      const candidate = buildCandidate();
      const result = dedup.deduplicate(candidate, fp, now);

      expect(result.action).toBe('auto_dismiss');
      expect(result.reason).toBe('previously_dismissed_duplicate');
    });

    it('flags as related_to_promoted for promoted observation from 25 days ago', () => {
      const now = new Date('2026-04-08T12:00:00Z');
      const dedup = new Deduplicator('/tmp/fp-test');
      const fp = 'h'.repeat(64);

      dedup.getStore().fingerprints.push({
        hash: fp,
        service: 'api-gateway',
        error_class: 'OOM',
        endpoint: '/api/v2/search',
        first_seen: daysAgo(30, now),
        last_seen: daysAgo(25, now),
        occurrence_count: 15,
        linked_observation_id: 'obs-promoted-025',
        triage_status: 'promoted',
      });

      const candidate = buildCandidate();
      const result = dedup.deduplicate(candidate, fp, now);

      expect(result.action).toBe('related_to_promoted');
      expect(result.existing_observation_id).toBe('obs-promoted-025');
    });

    it('treats as new when dismissed observation is > 30 days old', () => {
      const now = new Date('2026-04-08T12:00:00Z');
      const dedup = new Deduplicator('/tmp/fp-test');
      const fp = 'i'.repeat(64);

      dedup.getStore().fingerprints.push({
        hash: fp,
        service: 'api-gateway',
        error_class: 'OldError',
        endpoint: '/api/legacy',
        first_seen: daysAgo(60, now),
        last_seen: daysAgo(45, now), // > 30 days
        occurrence_count: 2,
        linked_observation_id: 'obs-old-dismiss',
        triage_status: 'dismissed',
      });

      const candidate = buildCandidate();
      const result = dedup.deduplicate(candidate, fp, now);

      expect(result.action).toBe('new');
    });
  });
});
