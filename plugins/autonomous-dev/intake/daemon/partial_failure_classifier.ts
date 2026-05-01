/**
 * Partial-failure classifier for temp / promotion / corrupt artifacts
 * (SPEC-012-1-03 §"Partial Failure Classifier").
 *
 * The producer's two-phase commit can leave behind:
 *   - `state.json.tmp.<pid>.<rand>`            — Phase A artifact
 *   - `state.json.tmp.<...>.needs_promotion`   — F4 forward-recovery
 *   - `state.json.tmp.<...>.corrupt`           — quarantined by recovery
 *
 * The daemon's read loop uses this classifier to decide whether to skip
 * (IN_FLIGHT, NEEDS_PROMOTION, CORRUPT, ORPHANED) or trigger recovery
 * (ORPHANED is the only one that recovery cleans synchronously at
 * startup; the daemon read loop never auto-recovers).
 *
 * @module daemon/partial_failure_classifier
 */

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types + tunables
// ---------------------------------------------------------------------------

export type TempStatus =
  | 'IN_FLIGHT'
  | 'NEEDS_PROMOTION'
  | 'ORPHANED'
  | 'CORRUPT';

/**
 * mtime threshold past which a temp from a live PID is treated as
 * orphaned. Calibrated to "typical disk write latency (sub-second) plus a
 * wide margin for slow CI" per SPEC-012-1-03 §Notes.
 */
export const IN_FLIGHT_MAX_AGE_MS = 60 * 1000;

/** Filename pattern for in-flight temps (NOT promotion / corrupt). */
const TEMP_RE = /^state\.json\.tmp\.(\d+)\.[0-9a-f]+$/;

// ---------------------------------------------------------------------------
// classifyTempFile
// ---------------------------------------------------------------------------

/**
 * Classify a single temp / promotion / corrupt file.
 *
 * Resolution order:
 *   1. `.needs_promotion` suffix         → NEEDS_PROMOTION
 *   2. `.corrupt` suffix                 → CORRUPT
 *   3. Filename matches TEMP_RE:
 *      a. PID alive AND mtime < 60s old → IN_FLIGHT
 *      b. otherwise                     → ORPHANED
 *   4. Anything else                     → ORPHANED (defensive)
 *
 * Tests inject `nowMs` to override `Date.now()`.
 */
export async function classifyTempFile(
  filePath: string,
  opts?: { nowMs?: number },
): Promise<TempStatus> {
  const base = path.basename(filePath);
  if (base.endsWith('.needs_promotion')) return 'NEEDS_PROMOTION';
  if (base.endsWith('.corrupt')) return 'CORRUPT';

  const m = TEMP_RE.exec(base);
  if (!m) return 'ORPHANED';

  const pid = Number.parseInt(m[1], 10);
  if (Number.isNaN(pid)) return 'ORPHANED';

  // mtime check first — cheaper than process.kill on the slow path.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    // File vanished in the gap between caller and us — treat as orphan.
    return 'ORPHANED';
  }

  const now = opts?.nowMs ?? Date.now();
  if (now - stat.mtimeMs > IN_FLIGHT_MAX_AGE_MS) return 'ORPHANED';

  // PID liveness check.
  try {
    process.kill(pid, 0);
    return 'IN_FLIGHT';
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return 'ORPHANED';
    // EPERM = process exists but we can't signal it. Treat as alive.
    return 'IN_FLIGHT';
  }
}
