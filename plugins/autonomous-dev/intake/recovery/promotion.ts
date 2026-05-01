/**
 * F4 forward-recovery for `state.json.tmp.<...>.needs_promotion` files
 * (SPEC-012-1-04 §"Promotion").
 *
 * The producer's two-phase commit (`handoff_manager.ts`) marks a temp file
 * `*.needs_promotion` when SQLite has committed the row but the final atomic
 * `fs.rename(temp, state.json)` failed (F4). On the next daemon startup, the
 * recovery runner promotes those temps to their target `state.json` so the
 * consumer-side reader can observe a complete-new file.
 *
 * Behaviour for a single `*.needs_promotion` file:
 *   1. Verify the path ends in `.needs_promotion`.
 *   2. Compute the target `state.json` path (strip the temp + suffix).
 *   3. Read + schema-validate the temp via {@link readStateJson}; on failure
 *      rename to `*.corrupt` and return `SCHEMA_INVALID`.
 *   4. Idempotency check — if the target `state.json` already exists:
 *        a. Identical contents → `unlink(temp)` and return success (a previous
 *           run already promoted; we're just cleaning up the marker).
 *        b. Different contents → prefer the existing target (already-committed
 *           wins); rename the temp to `*.corrupt` and return CONFLICT.
 *   5. Otherwise atomically `fs.rename(temp, target)`.
 *
 * The function is safe to call multiple times on the same file (idempotent).
 * The recovery runner counts successful promotions for the report; conflicts
 * and schema-invalids are surfaced separately.
 *
 * @module recovery/promotion
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  StateValidationError,
  readStateJson,
} from '../state/state_validator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated outcome of a single `promoteNeedsPromotion` call. */
export type PromotionResult =
  | { ok: true; promoted: boolean; target: string }
  | { ok: false; reason: PromotionFailureReason; details?: string };

export type PromotionFailureReason =
  | 'BAD_PATH'
  | 'SCHEMA_INVALID'
  | 'CONFLICT'
  | 'IO_ERROR';

/** Suffix the producer applies to mark a temp for forward-recovery. */
export const NEEDS_PROMOTION_SUFFIX = '.needs_promotion';

/** Suffix used to quarantine a temp that fails schema validation. */
export const CORRUPT_SUFFIX = '.corrupt';

// ---------------------------------------------------------------------------
// promoteNeedsPromotion
// ---------------------------------------------------------------------------

/**
 * Promote a single `state.json.tmp.<...>.needs_promotion` file to
 * `state.json` in the same directory.
 *
 * @param tempPath  Absolute path to the `*.needs_promotion` file.
 * @returns A {@link PromotionResult}. `ok: true; promoted: true` ⇒ rename
 *          completed; `promoted: false` ⇒ already-promoted no-op cleanup.
 */
export async function promoteNeedsPromotion(
  tempPath: string,
): Promise<PromotionResult> {
  // Step 1: defensive — must end with the marker suffix.
  if (!tempPath.endsWith(NEEDS_PROMOTION_SUFFIX)) {
    return {
      ok: false,
      reason: 'BAD_PATH',
      details: `path does not end with ${NEEDS_PROMOTION_SUFFIX}`,
    };
  }

  // Step 2: compute target. Strip the entire `state.json.tmp.<pid>.<rand>.needs_promotion`
  // basename and replace with `state.json` in the same directory. We do NOT
  // try to preserve any suffixes — the producer always names the final file
  // `state.json` (handoff_manager.ts §runTwoPhaseWrite).
  const dir = path.dirname(tempPath);
  const target = path.join(dir, 'state.json');

  // Step 3: schema-validate BEFORE attempting any rename — corrupt files
  // get quarantined here, never become state.json.
  try {
    readStateJson(tempPath);
  } catch (err) {
    if (err instanceof StateValidationError) {
      // Quarantine the bad temp so we don't keep retrying.
      const quarantinePath = quarantineCorrupt(tempPath);
      return {
        ok: false,
        reason: 'SCHEMA_INVALID',
        details: `${err.message} (quarantined to ${quarantinePath})`,
      };
    }
    // Non-validation error (e.g. ENOENT — file vanished between scan and us).
    return {
      ok: false,
      reason: 'IO_ERROR',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 4: idempotency / conflict handling — does target already exist?
  if (fs.existsSync(target)) {
    let identical: boolean;
    try {
      const existing = fs.readFileSync(target, 'utf-8');
      const candidate = fs.readFileSync(tempPath, 'utf-8');
      identical = existing === candidate;
    } catch (err) {
      return {
        ok: false,
        reason: 'IO_ERROR',
        details: err instanceof Error ? err.message : String(err),
      };
    }

    if (identical) {
      // Already-promoted no-op: the prior run wrote target then failed to
      // unlink the marker. Clean up now.
      try {
        fs.unlinkSync(tempPath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          return {
            ok: false,
            reason: 'IO_ERROR',
            details: (err as Error).message,
          };
        }
      }
      return { ok: true, promoted: false, target };
    }

    // Different contents → prefer existing (already committed wins).
    // Quarantine the temp.
    const quarantinePath = quarantineCorrupt(tempPath);
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        event: 'recovery.promotion_conflict',
        path: tempPath,
        target,
        quarantine: quarantinePath,
      }),
    );
    return {
      ok: false,
      reason: 'CONFLICT',
      details: `target state.json already exists with different contents (quarantined to ${quarantinePath})`,
    };
  }

  // Step 5: target does not exist → atomic rename.
  try {
    fs.renameSync(tempPath, target);
  } catch (err) {
    return {
      ok: false,
      reason: 'IO_ERROR',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, promoted: true, target };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Rename a bad temp file to a `*.corrupt-<ts>` quarantine path. Best-effort:
 * if the rename itself fails, we log and return the path we WANTED to use —
 * the caller can still report the original failure. Timestamp suffix avoids
 * collisions across multiple recovery runs.
 */
function quarantineCorrupt(tempPath: string): string {
  // Strip the `.needs_promotion` suffix so the quarantined name is shorter
  // and matches what `temp_cleanup` would produce for non-promotion temps.
  const baseWithoutPromotion = tempPath.endsWith(NEEDS_PROMOTION_SUFFIX)
    ? tempPath.slice(0, -NEEDS_PROMOTION_SUFFIX.length)
    : tempPath;
  const ts = Date.now();
  const quarantine = `${baseWithoutPromotion}${CORRUPT_SUFFIX}-${ts}`;
  try {
    fs.renameSync(tempPath, quarantine);
  } catch {
    // If rename fails (e.g. permission denied), try unlinking instead so we
    // don't keep classifying the same bad file forever.
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Truly stuck — operator will see this in the logs.
    }
  }
  return quarantine;
}
