/**
 * Three-window deduplication engine (SPEC-007-3-3, Task 7).
 *
 * Dedup windows:
 *   1. **Intra-run** -- within the current detection run; duplicates are
 *      merged and `occurrence_count` is incremented.
 *   2. **Inter-run (7 days)** -- fingerprint matches a `pending` observation
 *      seen in the last 7 days; the existing observation is updated.
 *   3. **Post-triage (30 days)** -- fingerprint matches a previously triaged
 *      (`dismissed` or `promoted`) observation within the last 30 days.
 *      - `dismissed` -> auto-dismiss with reason `"previously_dismissed_duplicate"`
 *      - `promoted`  -> flag as `"related_to_promoted"`
 *
 * Fingerprint store files live at `.autonomous-dev/fingerprints/<service>.json`.
 * They are read at run start ({@link load}) and written at run end ({@link save}).
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  CandidateObservation,
  FingerprintEntry,
  FingerprintStore,
  DeduplicationResult,
} from './types';

// ---------------------------------------------------------------------------
// JSON file helpers
// ---------------------------------------------------------------------------

/**
 * Reads a JSON file and returns its parsed contents, or `null` when the
 * file does not exist.
 */
async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(data) as T;
  } catch {
    return null;
  }
}

/**
 * Writes a value as pretty-printed JSON, creating parent directories
 * if needed.
 */
async function writeJsonFile<T>(filePath: string, value: T): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Deduplicator
// ---------------------------------------------------------------------------

export class Deduplicator {
  private store: FingerprintStore = { fingerprints: [] };
  private intraRunFingerprints: Map<string, CandidateObservation> = new Map();

  constructor(private storePath: string) {}

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  /**
   * Loads the fingerprint store for `service` from disk.
   * If the file does not exist a fresh empty store is used.
   */
  async load(service: string): Promise<void> {
    const filePath = path.join(this.storePath, `${service}.json`);
    this.store = (await readJsonFile<FingerprintStore>(filePath)) ?? { fingerprints: [] };
  }

  /**
   * Persists the current fingerprint store to disk for `service`.
   */
  async save(service: string): Promise<void> {
    const filePath = path.join(this.storePath, `${service}.json`);
    await writeJsonFile(filePath, this.store);
  }

  // -----------------------------------------------------------------------
  // Accessors (for testing)
  // -----------------------------------------------------------------------

  /** Returns the current in-memory fingerprint store. */
  getStore(): FingerprintStore {
    return this.store;
  }

  /** Returns the intra-run fingerprint map. */
  getIntraRunMap(): Map<string, CandidateObservation> {
    return this.intraRunFingerprints;
  }

  /** Resets intra-run state (called between runs). */
  resetIntraRun(): void {
    this.intraRunFingerprints.clear();
  }

  // -----------------------------------------------------------------------
  // Core deduplication logic
  // -----------------------------------------------------------------------

  /**
   * Deduplicates a candidate observation against the three windows.
   *
   * @param candidate  The candidate observation to check.
   * @param fingerprint SHA-256 fingerprint of the candidate.
   * @param now        Optional override for "current time" (for testing).
   * @returns          The deduplication decision.
   */
  deduplicate(
    candidate: CandidateObservation,
    fingerprint: string,
    now: Date = new Date(),
  ): DeduplicationResult {
    // ----- Window 1: Intra-run (within current run) -----
    if (this.intraRunFingerprints.has(fingerprint)) {
      const existing = this.intraRunFingerprints.get(fingerprint)!;
      existing.occurrence_count = (existing.occurrence_count ?? 1) + 1;
      return {
        action: 'merge_intra_run',
        existing_observation_id: existing.observation_id,
      };
    }

    // ----- Window 2: Inter-run (last 7 days, pending observations) -----
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const interRunMatch = this.store.fingerprints.find(
      (fp) =>
        fp.hash === fingerprint &&
        fp.triage_status === 'pending' &&
        new Date(fp.last_seen) > sevenDaysAgo,
    );
    if (interRunMatch) {
      interRunMatch.last_seen = now.toISOString();
      interRunMatch.occurrence_count++;
      return {
        action: 'update_inter_run',
        existing_observation_id: interRunMatch.linked_observation_id,
        reason: `Matches pending observation ${interRunMatch.linked_observation_id}`,
      };
    }

    // ----- Window 3: Post-triage (last 30 days) -----
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const postTriageMatch = this.store.fingerprints.find(
      (fp) =>
        fp.hash === fingerprint &&
        new Date(fp.last_seen) > thirtyDaysAgo &&
        (fp.triage_status === 'dismissed' || fp.triage_status === 'promoted'),
    );
    if (postTriageMatch) {
      if (postTriageMatch.triage_status === 'dismissed') {
        return {
          action: 'auto_dismiss',
          existing_observation_id: postTriageMatch.linked_observation_id,
          reason: 'previously_dismissed_duplicate',
        };
      }
      if (postTriageMatch.triage_status === 'promoted') {
        return {
          action: 'related_to_promoted',
          existing_observation_id: postTriageMatch.linked_observation_id,
          reason: 'related_to_promoted',
        };
      }
    }

    // ----- No match: new observation -----
    this.intraRunFingerprints.set(fingerprint, candidate);
    return { action: 'new' };
  }

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  /**
   * Registers a new fingerprint in the persistent store.
   *
   * Called after a candidate with `action: 'new'` passes LLM
   * classification and is accepted as a valid observation.
   */
  registerFingerprint(fingerprint: string, candidate: CandidateObservation): void {
    this.store.fingerprints.push({
      hash: fingerprint,
      service: candidate.service,
      error_class: candidate.error_class ?? 'unknown',
      endpoint: candidate.endpoint ?? '*',
      first_seen: new Date().toISOString(),
      last_seen: new Date().toISOString(),
      occurrence_count: 1,
      linked_observation_id: candidate.observation_id ?? '',
      triage_status: 'pending',
    });
  }
}
