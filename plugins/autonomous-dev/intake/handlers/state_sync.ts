/**
 * state_sync: shared helper for lifecycle handlers (#551).
 *
 * The CLI lifecycle handlers (cancel/pause/resume/priority) historically wrote
 * only the SQLite row via `Repository.updateRequest`, never the on-disk
 * `state.json`. The daemon's `select_request` scans per-request `state.json`
 * files, so a request whose db row says `cancelled` but whose state.json still
 * says `running` was re-selected every poll. The atomic transition helpers in
 * `handoff_manager` (cancelRequest/pauseRequest/resumeRequest/setPriority)
 * already write BOTH the db row and state.json under a per-request lock — they
 * just weren't wired into the CLI router. This wraps them with a safe db-only
 * fallback for requests that have no materialized state.json yet.
 *
 * @module state_sync
 */

import type { HandoffResult } from '../core/handoff_manager';

/**
 * Run an atomic state-transition helper that syncs BOTH the db row and the
 * on-disk `state.json`. If the helper cannot (no materialized state.json — e.g.
 * a still-`queued` request that never reached a phase), run `dbOnlyFallback`
 * so the db row is still updated.
 *
 * Returns `true` when state.json was synced atomically, `false` when only the
 * db row was updated (the fallback path). Either way the db row ends in the
 * target status: the helper updates it inside its own transaction on success;
 * the fallback updates it otherwise. A request with no state.json is not
 * actionable by the daemon (select_request only scans existing state.json
 * files), so the db-only path is correct for it.
 */
export async function syncTransition(
  helper: () => Promise<HandoffResult>,
  dbOnlyFallback: () => void,
): Promise<boolean> {
  let result: HandoffResult;
  try {
    result = await helper();
  } catch {
    // The helper threw (e.g. better-sqlite3 unavailable, lock contention).
    // Never let a lifecycle command fail to record in the db.
    dbOnlyFallback();
    return false;
  }
  if (result.ok) return true;
  dbOnlyFallback();
  return false;
}
