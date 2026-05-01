/**
 * Daemon-side state reader (SPEC-012-1-03 §"State Reader").
 *
 * Reads `state.json` files lock-free and surfaces parse / schema errors
 * with classification suitable for the daemon's read loop. The reader
 * relies on POSIX rename atomicity (Phase C of the producer protocol)
 * to guarantee no torn reads — the file is either complete-old or
 * complete-new, never partial.
 *
 * `pollNewRequests` enumerates request directories in the configured
 * repo, filters out invalid names + already-acknowledged + in-flight
 * (no state.json yet) entries, and returns a FIFO-by-created_at,
 * priority-desc-tiebreak list of REQ ids ready for consumption.
 *
 * @module daemon/state_reader
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type StateJsonV11,
  StateValidationError,
  readStateJson,
} from '../state/state_validator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminated outcome of a single state.json read. */
export type ReadResult =
  | { ok: true; state: StateJsonV11; statePath: string }
  | {
      ok: false;
      reason: 'NOT_FOUND' | 'PARSE_ERROR' | 'SCHEMA_INVALID';
      details: string;
    };

/** REQ id format guard (defensive — buildRequestPath should prevent escapes). */
const REQUEST_ID_RE = /^REQ-\d{6}$/;

// ---------------------------------------------------------------------------
// readState
// ---------------------------------------------------------------------------

/**
 * Read + parse + schema-validate `state.json` for a single request.
 *
 * Discriminates four outcomes:
 *   - `{ ok: true }`             — happy path; daemon may consume.
 *   - `{ ok: false, NOT_FOUND }` — directory exists but state.json
 *                                  doesn't yet (producer mid-write).
 *                                  NOT an error; just skip + retry.
 *   - `{ ok: false, PARSE_ERROR }` — malformed JSON; ESCALATE to
 *                                    recovery (rename atomicity should
 *                                    prevent this case).
 *   - `{ ok: false, SCHEMA_INVALID }` — JSON parsed but schema invalid;
 *                                       same — escalate.
 */
export async function readState(requestPath: string): Promise<ReadResult> {
  const statePath = path.join(requestPath, 'state.json');

  if (!fs.existsSync(statePath)) {
    return { ok: false, reason: 'NOT_FOUND', details: 'state.json missing' };
  }

  let state: StateJsonV11;
  try {
    state = readStateJson(statePath);
  } catch (err) {
    if (err instanceof StateValidationError) {
      // The validator throws StateValidationError for both parse failures
      // (`malformed JSON ...`) and schema failures (`unknown source ...`).
      // Discriminate on the message prefix used by readStateJson.
      const msg = err.message;
      const reason: 'PARSE_ERROR' | 'SCHEMA_INVALID' = msg.startsWith(
        'malformed JSON',
      )
        ? 'PARSE_ERROR'
        : 'SCHEMA_INVALID';
      return { ok: false, reason, details: msg };
    }
    // Unknown read error — surface as PARSE_ERROR so the daemon escalates.
    return {
      ok: false,
      reason: 'PARSE_ERROR',
      details: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true, state, statePath };
}

// ---------------------------------------------------------------------------
// pollNewRequests
// ---------------------------------------------------------------------------

/**
 * Adapter providing read-only SQLite access for the poll loop. Tests inject
 * a mock; production wires it to the canonical Repository.
 */
export interface PollDb {
  /**
   * Return all rows pending acknowledgment ordered by FIFO (created_at
   * ASC) with priority-desc tiebreak — high > normal > low.
   */
  listUnacknowledged(): Array<{
    request_id: string;
    created_at: string;
    priority: 'high' | 'normal' | 'low';
  }>;
}

/**
 * Enumerate request directories ready for consumption. Filters:
 *   - REQ id regex (defensive).
 *   - state.json exists (producer has finished Phase C).
 *   - Not already acknowledged (per SQLite).
 * Sorts FIFO by created_at; tiebreak by priority desc (high first).
 *
 * Returns an array of request IDs (not paths) so the caller can invoke
 * `buildRequestPath` itself when ready to consume.
 */
export async function pollNewRequests(
  repo: string,
  db: PollDb,
): Promise<string[]> {
  const requestsDir = path.join(repo, '.autonomous-dev', 'requests');
  if (!fs.existsSync(requestsDir)) return [];

  // Scan FS first to get the candidate set; then filter by SQLite.
  const fsCandidates = new Set<string>();
  for (const entry of fs.readdirSync(requestsDir)) {
    if (!REQUEST_ID_RE.test(entry)) continue;
    const dir = path.join(requestsDir, entry);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (!fs.existsSync(path.join(dir, 'state.json'))) continue;
    fsCandidates.add(entry);
  }

  if (fsCandidates.size === 0) return [];

  // Use SQLite-driven order (already FIFO + priority-desc-tiebroken) and
  // filter to the FS-present set. Rows that are in SQLite but missing
  // state.json are skipped here — recovery handles those.
  const ordered = db.listUnacknowledged();
  const out: string[] = [];
  for (const row of ordered) {
    if (fsCandidates.has(row.request_id)) out.push(row.request_id);
  }
  return out;
}
