/**
 * production-intelligence-writer — persists a portal-facing summary of the
 * observe loop's last completed cycle (#562 / FR-938).
 *
 * The portal Ops surface reads `<stateDir>/production-intelligence.json` via
 * `readProductionIntelligence()` (autonomous-dev-portal/server/wiring/ops-readers.ts)
 * and shows the honest empty state when the file is absent. This module is the
 * single producer: the observe runner calls `writeProductionIntelligence()`
 * once per completed run during FINALIZE.
 *
 * The summary is per-run (a snapshot of the most recent cycle), NOT cumulative.
 * Aborted runs return before FINALIZE and therefore do not update the file —
 * the portal shows the last *completed* cycle by design.
 */

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { atomicWrite } from '../pipeline/storage/atomic-io';
import type { RunMetadata } from './observation-runner';

/**
 * On-disk shape of `production-intelligence.json`. snake_case matches the
 * daemon's other state files (crash-state.json, heartbeat.json) so the portal
 * reader convention is uniform.
 */
export interface ProductionIntelligenceSummary {
  last_run_id: string;
  last_run_at: string;
  services_scanned: number;
  observations_generated: number;
  observations_filtered: number;
  triage_processed: number;
  error_count: number;
  /** When this summary file was written (may differ from last_run_at). */
  updated_at: string;
}

/**
 * Resolve the daemon-home state dir. Honors `AUTONOMOUS_DEV_STATE_DIR` for test
 * isolation (same convention as the portal readers and the bash daemon),
 * defaulting to `~/.autonomous-dev`.
 */
export function resolveStateDir(): string {
  const override = process.env.AUTONOMOUS_DEV_STATE_DIR;
  if (override !== undefined && override.trim() !== '') return override;
  return path.join(os.homedir(), '.autonomous-dev');
}

/** Project a RunMetadata into the portal-facing summary. Pure — easy to test. */
export function projectSummary(
  metadata: RunMetadata,
  nowIso: string,
): ProductionIntelligenceSummary {
  return {
    last_run_id: metadata.run_id,
    last_run_at: metadata.completed_at,
    services_scanned: metadata.services_in_scope.length,
    observations_generated: metadata.observations_generated,
    observations_filtered: metadata.observations_filtered,
    triage_processed: metadata.triage_decisions_processed,
    error_count: metadata.errors.length,
    updated_at: nowIso,
  };
}

/**
 * Persist the observe-loop's last-cycle summary to
 * `<stateDir>/production-intelligence.json` for the portal Ops surface (#562).
 * The write is atomic (write-then-rename); the state dir is created if missing.
 *
 * @returns the absolute path written.
 */
export async function writeProductionIntelligence(
  metadata: RunMetadata,
  opts: { stateDir?: string; nowIso?: string } = {},
): Promise<string> {
  const stateDir = opts.stateDir ?? resolveStateDir();
  const nowIso = opts.nowIso ?? new Date().toISOString();
  const target = path.join(stateDir, 'production-intelligence.json');
  await fs.mkdir(stateDir, { recursive: true });
  const summary = projectSummary(metadata, nowIso);
  await atomicWrite(target, `${JSON.stringify(summary, null, 2)}\n`);
  return target;
}
