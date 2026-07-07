/**
 * cancel_finalizer — post-commit finalizer for request cancellation.
 *
 * Writes the `cancelled.tombstone` sentinel that makes a cancel sticky across
 * daemon restarts and orphan-reconciliation passes, and removes the pending
 * gate-decision file so the portal can never resurrect a cancelled request.
 *
 * Design contract:
 *   - ALL public functions MUST NOT throw.
 *   - Errors are accumulated in a `warnings[]` array (non-fatal).
 *   - The tombstone is written FIRST; gate-decision deletion follows.
 *   - Idempotent: a second call on the same request is a no-op success.
 *
 * Implements BR-1/BR-3/BR-4 from REQ-000059.
 *
 * @module handlers/cancel_finalizer
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

/**
 * Basename of the on-disk marker file that makes a cancel sticky across
 * daemon restarts and reconciliation passes.
 *
 * Bash consumers hardcode the literal string 'cancelled.tombstone'.
 * If this constant ever changes, the bash helper must change with it.
 */
export const CANCELLED_TOMBSTONE_BASENAME = 'cancelled.tombstone' as const;

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface FinalizeCancelOptions {
  /** Absolute request directory (already realpath-resolved by the caller). */
  requestPath: string;
  /** `path.basename(request.target_repo)`; used to compose the gate-decision file. */
  repoBasename: string;
  /** REQ-NNNNNN; already validated by the caller. */
  requestId: string;
  /**
   * Override for tests. Defaults to
   * `path.join(process.env.AUTONOMOUS_DEV_STATE_DIR ?? path.join(os.homedir(), '.autonomous-dev'), 'gate-decisions')`.
   */
  gateDecisionsDir?: string;
}

export interface FinalizeCancelResult {
  /** True iff the tombstone exists on disk after the call (created or pre-existing). */
  tombstoneWritten: boolean;
  /** True iff the gate-decision file no longer exists after the call. */
  gateDecisionDeleted: boolean;
  /** Non-fatal warnings; empty on the happy path. Single-line strings suitable for JSON logging. */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// finalizeCancellation
// ---------------------------------------------------------------------------

/**
 * Post-commit finalizer for cancel.
 *
 * MUST run only AFTER syncTransition() resolves (regardless of the boolean
 * result — even the db-only-fallback path needs the tombstone so future
 * reconciles cannot resurrect the row).
 *
 * All operations are best-effort. This function MUST NOT throw.
 * Any failure is recorded in `warnings[]`.
 *
 * Ordering: writes tombstone FIRST, then deletes gate-decision file.
 * A tombstone-write failure MUST NOT prevent the gate-decision delete
 * attempt.
 */
export async function finalizeCancellation(
  opts: FinalizeCancelOptions,
): Promise<FinalizeCancelResult> {
  const warnings: string[] = [];

  // Step 1: Ensure requestPath exists as a directory.
  try {
    fs.mkdirSync(opts.requestPath, { recursive: true, mode: 0o700 });
  } catch (err) {
    if (!fs.existsSync(opts.requestPath)) {
      warnings.push(
        `mkdir failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Step 2: Write tombstone (best-effort; O_CREAT|O_EXCL|O_WRONLY, 0o600).
  const tombstoneWritten = writeCancelledTombstone(opts.requestPath, warnings);

  // Step 3: Resolve gate-decisions directory.
  const gateDir =
    opts.gateDecisionsDir
    ?? path.join(
      process.env.AUTONOMOUS_DEV_STATE_DIR ?? path.join(os.homedir(), '.autonomous-dev'),
      'gate-decisions',
    );

  // Step 4: Compute gate-decision file path.
  const gateFile = path.join(gateDir, `${opts.repoBasename}__${opts.requestId}.json`);

  // Step 5: Delete the gate-decision file (ENOENT = no-op success).
  try {
    fs.unlinkSync(gateFile);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warnings.push(
        `gate-decision unlink failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const gateDecisionDeleted = !fs.existsSync(gateFile);

  return { tombstoneWritten, gateDecisionDeleted, warnings };
}

// ---------------------------------------------------------------------------
// isCancelledTombstonePresent
// ---------------------------------------------------------------------------

/**
 * Presence check used by every reconciliation / recovery path.
 *
 * MUST NOT throw. Any stat error other than success (including ENOENT,
 * EACCES, ENOTDIR) returns `false` — the caller then falls back to its
 * normal check, which remains gated by `state.json.status`.
 */
export function isCancelledTombstonePresent(requestPath: string): boolean {
  try {
    const stat = fs.statSync(
      path.join(requestPath, CANCELLED_TOMBSTONE_BASENAME),
      { throwIfNoEntry: false },
    );
    return stat !== undefined && stat.isFile();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// writeCancelledTombstone
// ---------------------------------------------------------------------------

/**
 * Write the tombstone at `<requestPath>/cancelled.tombstone`.
 *
 * Exported so `journal_replay.ts` can back-fill legacy cancelled rows.
 * Uses O_CREAT|O_EXCL|O_WRONLY with mode 0o600. Returns true iff the
 * tombstone exists on disk afterward (created or already present).
 * MUST NOT throw. On write failure, returns false and appends to
 * `warnings` if provided.
 */
export function writeCancelledTombstone(
  requestPath: string,
  warnings?: string[],
): boolean {
  const tombstonePath = path.join(requestPath, CANCELLED_TOMBSTONE_BASENAME);
  try {
    const fd = fs.openSync(
      tombstonePath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600,
    );
    fs.closeSync(fd);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      warnings?.push(
        `tombstone write failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return fs.existsSync(tombstonePath);
    }
    // EEXIST → already present, treat as success (idempotent).
  }
  return fs.existsSync(tombstonePath);
}
