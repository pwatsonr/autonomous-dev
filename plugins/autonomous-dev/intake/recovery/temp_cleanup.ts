/**
 * Orphaned temp + corrupt state.json handling at daemon startup
 * (SPEC-012-1-04 §"Temp Cleanup").
 *
 * After the promotion phase has consumed every `*.needs_promotion` marker,
 * `cleanupOrphanedTemps` scans the per-request directories for:
 *
 *   1. `state.json.tmp.<pid>.<rand>` files older than the orphan window
 *      (`IN_FLIGHT_MAX_AGE_MS`, default 60 s) — produced by a crashed
 *      producer; safe to unlink. Files inside the in-flight window from
 *      the current PID are ALWAYS skipped (they could be live writes from
 *      a sibling caller in the same process).
 *
 *   2. `state.json` files that fail JSON parse — quarantined to
 *      `state.json.corrupt-<ts>` so the daemon's reader doesn't keep
 *      hitting them. The daemon's normal read path treats a quarantined
 *      file as no-state-yet and skips the request.
 *
 * The journal-replay phase (next) reconciles the resulting clean FS state
 * against SQLite to detect any remaining drift.
 *
 * @module recovery/temp_cleanup
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  IN_FLIGHT_MAX_AGE_MS,
  classifyTempFile,
} from '../daemon/partial_failure_classifier';

import {
  CORRUPT_SUFFIX,
  NEEDS_PROMOTION_SUFFIX,
} from './promotion';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CleanupReport {
  /** Number of orphaned temp files unlinked. */
  cleaned: number;
  /** Number of files quarantined as `*.corrupt-<ts>`. */
  quarantined: number;
  /** Per-file errors encountered (best-effort; never throws to caller). */
  errors: Array<{ path: string; error: string }>;
}

/**
 * Glob pattern (informational only — we use `fs.readdirSync` for lock-step
 * portability).
 */
export const TEMP_GLOB = '<repo>/.autonomous-dev/requests/<REQ-ID>/state.json.tmp.*';

// ---------------------------------------------------------------------------
// cleanupOrphanedTemps
// ---------------------------------------------------------------------------

/**
 * Scan all request directories under `<repo>/.autonomous-dev/requests/` and
 * delete orphaned temps + quarantine corrupt `state.json` files.
 *
 * Behavior per file:
 *   - `*.needs_promotion`        → skip (handled by `promoteNeedsPromotion`).
 *   - `*.corrupt` / `*.corrupt-` → skip (already quarantined).
 *   - `state.json.tmp.*`         → classify; ORPHANED → unlink, IN_FLIGHT → skip.
 *   - `state.json`               → JSON-parse; quarantine on failure.
 *
 * Idempotent. Safe to call from a single-threaded recovery context (which is
 * the only intended call site — the daemon's read loop NEVER auto-recovers).
 *
 * @param repo  Realpath-resolved repository root.
 * @param opts  Tunables. `nowMs` overrides `Date.now()` for tests; defaults
 *              to the orphan window from the partial-failure classifier.
 */
export async function cleanupOrphanedTemps(
  repo: string,
  opts?: { nowMs?: number },
): Promise<CleanupReport> {
  const requestsDir = path.join(repo, '.autonomous-dev', 'requests');
  const report: CleanupReport = { cleaned: 0, quarantined: 0, errors: [] };

  if (!fs.existsSync(requestsDir)) return report;

  let entries: string[];
  try {
    entries = fs.readdirSync(requestsDir);
  } catch (err) {
    report.errors.push({
      path: requestsDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return report;
  }

  for (const entry of entries) {
    const reqDir = path.join(requestsDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(reqDir);
    } catch {
      continue; // raced removal; skip
    }
    if (!stat.isDirectory()) continue;

    await cleanupOneRequestDir(reqDir, report, opts);
  }

  return report;
}

// ---------------------------------------------------------------------------
// Per-directory cleanup
// ---------------------------------------------------------------------------

async function cleanupOneRequestDir(
  reqDir: string,
  report: CleanupReport,
  opts?: { nowMs?: number },
): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(reqDir);
  } catch (err) {
    report.errors.push({
      path: reqDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const file of files) {
    const full = path.join(reqDir, file);

    // --- Skip already-handled / well-known artifacts -----------------------
    if (file === '.lock') continue;
    if (file.endsWith(NEEDS_PROMOTION_SUFFIX)) continue;
    if (file.endsWith(CORRUPT_SUFFIX) || file.includes(`${CORRUPT_SUFFIX}-`)) continue;

    // --- Quarantine corrupt state.json -------------------------------------
    if (file === 'state.json') {
      handleStateJson(full, report);
      continue;
    }

    // --- Temp file? --------------------------------------------------------
    if (!file.startsWith('state.json.tmp.')) continue;

    let status: 'IN_FLIGHT' | 'NEEDS_PROMOTION' | 'ORPHANED' | 'CORRUPT';
    try {
      status = await classifyTempFile(full, opts);
    } catch (err) {
      report.errors.push({
        path: full,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (status === 'IN_FLIGHT') continue;
    if (status === 'NEEDS_PROMOTION') continue; // double-defense
    if (status === 'CORRUPT') continue;

    // ORPHANED → try to unlink. If reading content fails (EIO), prefer
    // quarantine over unlink so an operator can inspect.
    if (!safeReadable(full)) {
      const quarantinePath = quarantine(full);
      if (quarantinePath) report.quarantined += 1;
      continue;
    }

    try {
      fs.unlinkSync(full);
      report.cleaned += 1;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT') continue; // raced; treat as success
      report.errors.push({
        path: full,
        error: (err as Error).message,
      });
    }
  }
}

/**
 * `state.json` may exist but be unparseable (truncated, garbled). Move it to
 * a quarantine name so the daemon reader treats the request as no-state-yet
 * (which causes a skip, not a crash). The producer's next attempt will
 * re-write a fresh state.json and recovery on the NEXT startup will INSERT
 * the row via journal_replay if SQLite was missing.
 */
function handleStateJson(filePath: string, report: CleanupReport): void {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return;
    // Read failed (EIO etc) — quarantine.
    const quarantinePath = quarantine(filePath);
    if (quarantinePath) report.quarantined += 1;
    return;
  }

  try {
    JSON.parse(raw);
    // Parseable — leave alone. (Schema validation happens in the daemon's
    // read loop; we do NOT enforce schema here because a partially-upgraded
    // installation may have legitimate v1.0 files that the validator
    // accepts but a stricter check might reject.)
    return;
  } catch {
    // Unparseable — quarantine.
    const quarantinePath = quarantine(filePath);
    if (quarantinePath) report.quarantined += 1;
  }
}

/**
 * Rename a bad file to `<base>.corrupt-<ts>`. Returns the new path, or null
 * if even the rename failed (in which case best-effort unlinks).
 */
function quarantine(filePath: string): string | null {
  const ts = Date.now();
  const target = `${filePath}${CORRUPT_SUFFIX}-${ts}`;
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch {
    // Couldn't quarantine — try to unlink so we don't keep tripping over
    // the same file every recovery run.
    try {
      fs.unlinkSync(filePath);
    } catch {
      // give up
    }
    return null;
  }
}

/**
 * Probe whether a file can be opened for read without surfacing the bytes.
 * Used to differentiate ORPHANED (deletable) from EIO (must quarantine).
 */
function safeReadable(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

// Re-export the orphan-window constant so tests can compute "old enough".
export { IN_FLIGHT_MAX_AGE_MS };
