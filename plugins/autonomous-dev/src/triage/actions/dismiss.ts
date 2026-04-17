/**
 * Dismiss triage action handler (SPEC-007-4-2, Task 5).
 *
 * When a PM Lead sets `triage_decision: dismiss` on an observation:
 *   1. Updates `triage_status` to `dismissed`
 *   2. Updates the fingerprint store with dismissal status
 *      (enables future auto-dismiss of duplicates)
 *   3. Logs the action to the triage audit trail
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { updateFrontmatter, readFrontmatter } from '../frontmatter-io';
import type { TriageDecision, TriageAuditLogger } from '../types';
import type { FingerprintStore } from '../../engine/types';

// ---------------------------------------------------------------------------
// Fingerprint store update delegate
// ---------------------------------------------------------------------------

/**
 * Function type for updating a fingerprint store entry.
 * The real implementation reads/writes `.autonomous-dev/fingerprints/<service>.json`.
 */
export type UpdateFingerprintStoreFn = (
  service: string,
  fingerprint: string,
  updates: Record<string, unknown>,
) => Promise<void>;

/**
 * Creates a fingerprint store updater bound to a specific directory.
 *
 * @param fingerprintsDir Absolute path to `.autonomous-dev/fingerprints/`
 * @returns An UpdateFingerprintStoreFn that reads/writes fingerprint JSON files
 */
export function createFingerprintStoreUpdater(
  fingerprintsDir: string,
): UpdateFingerprintStoreFn {
  return async (
    service: string,
    fingerprint: string,
    updates: Record<string, unknown>,
  ): Promise<void> => {
    const filePath = path.join(fingerprintsDir, `${service}.json`);

    let store: FingerprintStore;
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      store = JSON.parse(data) as FingerprintStore;
    } catch {
      store = { fingerprints: [] };
    }

    // Find matching fingerprint entry
    const entry = store.fingerprints.find((fp) => fp.hash === fingerprint);
    if (entry) {
      Object.assign(entry, updates);
    } else {
      // If no matching fingerprint, add a stub entry
      store.fingerprints.push({
        hash: fingerprint,
        service,
        error_class: 'unknown',
        endpoint: '*',
        first_seen: new Date().toISOString(),
        last_seen: (updates.last_seen as string) ?? new Date().toISOString(),
        occurrence_count: 1,
        linked_observation_id: '',
        triage_status: (updates.triage_status as string) ?? 'dismissed',
      });
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
  };
}

// ---------------------------------------------------------------------------
// Dismiss action
// ---------------------------------------------------------------------------

export async function executeDismiss(
  decision: TriageDecision,
  filePath: string,
  auditLog: TriageAuditLogger,
  updateFingerprintStore?: UpdateFingerprintStoreFn,
): Promise<void> {
  // 1. Update observation file: triage_status -> 'dismissed'
  await updateFrontmatter(filePath, {
    triage_status: 'dismissed',
  });

  // 2. Update fingerprint store with dismissal status
  if (updateFingerprintStore) {
    const fm = await readFrontmatter(filePath);
    await updateFingerprintStore(fm.service, fm.fingerprint, {
      triage_status: 'dismissed',
      last_seen: new Date().toISOString(),
    });
  }

  // 3. Log to triage audit
  auditLog.log({
    observation_id: decision.observation_id,
    action: 'dismiss',
    actor: decision.triage_by,
    timestamp: decision.triage_at,
    reason: decision.triage_reason,
    generated_prd: null,
    auto_promoted: false,
  });
}
