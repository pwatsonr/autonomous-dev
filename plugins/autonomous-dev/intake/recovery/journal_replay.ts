/**
 * Journal replay — reconciles SQLite ⟷ filesystem state at daemon startup
 * (SPEC-012-1-04 §"Journal Replay").
 *
 * After the promotion phase (which materialises any `state.json.tmp.*.needs_promotion`
 * into the canonical `state.json`) and the cleanup phase (which removes
 * orphan temps and quarantines corrupt state files), the FS is in a
 * consistent shape. Journal replay then walks SQLite + the FS and reconciles
 * any remaining drift:
 *
 * | SQLite row | state.json | Action |
 * |-----------|------------|--------|
 * | Present   | Present    | Compare priority + status. On mismatch: prefer state.json (it is the more recent commit point), UPDATE SQLite, log STATE_DRIFT. |
 * | Present   | Missing    | F4 lost-forever — mark SQLite `status='orphaned_lost'`, page operator. |
 * | Missing   | Present    | F3 cosmic-ray — INSERT a SQLite row from state.json (best-effort). |
 * | Missing   | Missing    | No-op. |
 *
 * Returns counts + a per-mismatch report. Operators page on `STATE_DRIFT`
 * (rare; indicates either a bug or a multi-daemon write conflict that the
 * per-request advisory lock should have prevented) and `orphaned_lost`.
 *
 * @module recovery/journal_replay
 */

import * as fs from 'fs';
import * as path from 'path';

import { Repository, type RequestEntity } from '../db/repository';
import {
  StateValidationError,
  readStateJson,
  type StateJsonV11,
} from '../state/state_validator';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JournalMismatchType =
  | 'STATE_DRIFT'
  | 'ORPHANED_LOST'
  | 'RECOVERY_INSERT'
  | 'RECOVERY_INSERT_FAILED';

export interface JournalMismatch {
  requestId: string;
  type: JournalMismatchType;
  details?: string;
}

export interface JournalReplayReport {
  /** Total rows / FS entries the replay touched (any SQLite write or no-op INSERT). */
  replayed: number;
  /** Per-request reconciliation events (bounded; this is the operator-pageable list). */
  mismatches: JournalMismatch[];
}

/** REQ id format guard (defensive, matches state_reader.ts). */
const REQUEST_ID_RE = /^REQ-\d{6}$/;

// ---------------------------------------------------------------------------
// SQLite + Repository injection (test seam)
// ---------------------------------------------------------------------------

/**
 * Adapter for the SQLite-side operations replay needs. Mirrors the
 * minimal surface used by `acknowledger.ts`/`state_reader.ts` so tests can
 * substitute an in-memory mock when needed (the production path passes a
 * real `Repository` constructed from `initializeDatabase`).
 */
export interface JournalDb {
  /** All currently-tracked rows (acknowledged or not — replay is pre-ack). */
  listAll(): RequestEntity[];
  /** Single-row read; returns null on miss. */
  getRequest(requestId: string): RequestEntity | null;
  /**
   * Insert a row recovered from a stranded state.json (F3 forward-recovery).
   * MUST be tolerant of the partial RequestEntity shape produced from
   * state.json (some v1 columns are derived defensively). Treats unique
   * key violation as success (race with a parallel daemon — should not
   * happen since recovery runs single-threaded, but defensive).
   */
  insertRequest(entity: RequestEntity): void;
  /**
   * UPDATE columns on an existing row (priority/status/paused_at_phase).
   */
  updateRequest(requestId: string, updates: Partial<RequestEntity>): void;
}

// ---------------------------------------------------------------------------
// replayJournal
// ---------------------------------------------------------------------------

/**
 * Reconcile SQLite ⟷ FS for a single repository.
 *
 * @param repo  Realpath-resolved repository root.
 * @param db    Injectable DB adapter; production callers pass a wrapped
 *              `Repository` instance (see `recovery_runner.ts`).
 */
export async function replayJournal(
  repo: string,
  db: JournalDb,
): Promise<JournalReplayReport> {
  const requestsDir = path.join(repo, '.autonomous-dev', 'requests');
  const report: JournalReplayReport = { replayed: 0, mismatches: [] };

  // --- Build the FS-side index: requestId -> parsed state.json ----------
  const fsState: Map<string, StateJsonV11> = new Map();
  if (fs.existsSync(requestsDir)) {
    for (const entry of fs.readdirSync(requestsDir)) {
      if (!REQUEST_ID_RE.test(entry)) continue;
      const statePath = path.join(requestsDir, entry, 'state.json');
      if (!fs.existsSync(statePath)) continue;
      try {
        const parsed = readStateJson(statePath);
        fsState.set(entry, parsed);
      } catch (err) {
        // Should be rare — temp_cleanup quarantined parse failures. A
        // schema-invalid file (validator returned StateValidationError) is
        // surfaced as a drift entry; the daemon's read loop will skip it.
        report.mismatches.push({
          requestId: entry,
          type: 'STATE_DRIFT',
          details:
            err instanceof StateValidationError
              ? `state.json invalid: ${err.message}`
              : `state.json read error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  // --- Walk SQLite rows -------------------------------------------------
  const dbRows = db.listAll();
  const seenIds = new Set<string>();

  for (const row of dbRows) {
    seenIds.add(row.request_id);
    const fsEntry = fsState.get(row.request_id);

    if (fsEntry) {
      // Both sides present — compare priority + status.
      const drift = computeDrift(row, fsEntry);
      if (drift.length > 0) {
        const updates: Partial<RequestEntity> = {};
        for (const field of drift) {
          // Apply updates from state.json (committed source of truth).
          // We never propagate ad-hoc fields — only the canonical columns
          // we expect to drift between F3/F4 partial recoveries.
          if (field === 'priority') {
            updates.priority = fsEntry.priority as RequestEntity['priority'];
          } else if (field === 'status') {
            updates.status = fsEntry.status as RequestEntity['status'];
          } else if (field === 'paused_at_phase') {
            updates.paused_at_phase = (fsEntry.paused_from as string | undefined) ?? null;
          }
        }
        try {
          db.updateRequest(row.request_id, updates);
          report.replayed += 1;
          report.mismatches.push({
            requestId: row.request_id,
            type: 'STATE_DRIFT',
            details: `fields: ${drift.join(', ')}`,
          });
        } catch (err) {
          report.mismatches.push({
            requestId: row.request_id,
            type: 'STATE_DRIFT',
            details: `update failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }
      continue;
    }

    // SQLite present, FS missing → orphaned_lost.
    try {
      db.updateRequest(row.request_id, {
        status: 'orphaned_lost' as RequestEntity['status'],
      });
      report.replayed += 1;
    } catch (err) {
      // Some schemas reject the bare 'orphaned_lost' status due to a CHECK
      // constraint. Swallow into the mismatch record — operator pages on
      // ORPHANED_LOST and can investigate.
      report.mismatches.push({
        requestId: row.request_id,
        type: 'ORPHANED_LOST',
        details: `update to orphaned_lost failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    report.mismatches.push({
      requestId: row.request_id,
      type: 'ORPHANED_LOST',
      details: 'state.json missing on disk',
    });
  }

  // --- FS rows without a SQLite row → INSERT (F3 cosmic-ray recovery) --
  for (const [requestId, parsed] of fsState) {
    if (seenIds.has(requestId)) continue;

    const entity = entityFromState(requestId, parsed);
    if (!entity) {
      report.mismatches.push({
        requestId,
        type: 'RECOVERY_INSERT_FAILED',
        details: 'state.json could not be coerced into a RequestEntity',
      });
      continue;
    }

    try {
      db.insertRequest(entity);
      report.replayed += 1;
      report.mismatches.push({
        requestId,
        type: 'RECOVERY_INSERT',
        details: 'state.json had no SQLite row; reconstructed and inserted',
      });
    } catch (err) {
      // Race with a producer that just inserted the same id, or a CHECK
      // failure. Either way, surface for operator review.
      report.mismatches.push({
        requestId,
        type: 'RECOVERY_INSERT_FAILED',
        details: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Drift detection
// ---------------------------------------------------------------------------

/**
 * Return the list of canonical fields that differ between the SQLite row
 * and the on-disk state.json. We only inspect a SHORT list of fields that
 * are legitimately mutable post-submit (status, priority, paused_at_phase);
 * everything else is set at insert time and shouldn't drift.
 *
 * Excludes `updated_at` — those drift constantly under normal operation as
 * the producer rewrites state.json (no SQLite update batched with it).
 */
function computeDrift(row: RequestEntity, fsEntry: StateJsonV11): string[] {
  const out: string[] = [];

  const fsPriority = fsEntry.priority as string | undefined;
  if (fsPriority && fsPriority !== row.priority) out.push('priority');

  const fsStatus = fsEntry.status as string | undefined;
  if (fsStatus && fsStatus !== row.status) out.push('status');

  // paused_at_phase corresponds to state.json's `paused_from` field.
  const fsPaused = fsEntry.paused_from as string | undefined;
  const dbPaused = row.paused_at_phase ?? undefined;
  if (
    (fsPaused ?? null) !== (dbPaused ?? null)
    && (fsPaused !== undefined || dbPaused !== undefined)
  ) {
    out.push('paused_at_phase');
  }

  return out;
}

// ---------------------------------------------------------------------------
// state.json -> RequestEntity (F3 forward-recovery insert)
// ---------------------------------------------------------------------------

/**
 * Best-effort coerce a parsed state.json into a {@link RequestEntity}
 * suitable for `Repository.insertRequest`. Some v1-required columns are
 * not present in state.json (raw_input, requester_id, source_channel);
 * we fill defensible defaults so the SQLite CHECK constraints pass.
 *
 * Returns null only if the state.json is so malformed it lacks the
 * primary discriminators (request_id, repository).
 */
function entityFromState(
  requestId: string,
  parsed: StateJsonV11,
): RequestEntity | null {
  const repo = parsed.repository as string | undefined;
  if (!repo) return null;

  const description = (parsed.description as string | undefined) ?? '';
  const title = description.slice(0, 80) || 'recovered request';
  const priority = (parsed.priority as RequestEntity['priority'] | undefined) ?? 'normal';
  const status = (parsed.status as RequestEntity['status'] | undefined) ?? 'queued';
  const createdAt =
    (parsed.created_at as string | undefined) ?? new Date().toISOString();
  const updatedAt = (parsed.updated_at as string | undefined) ?? createdAt;
  const source = (parsed.source as RequestEntity['source'] | undefined) ?? 'cli';
  const adapterMetadata =
    (parsed.adapter_metadata as RequestEntity['adapter_metadata'] | undefined) ?? {};

  // Map source → source_channel for v1 compatibility (mirrors the same
  // mapping used by handoff_manager.entityFromSubmit).
  const sourceChannel: RequestEntity['source_channel'] =
    source === 'discord'
      ? 'discord'
      : source === 'slack'
        ? 'slack'
        : 'claude_app';

  return {
    request_id: requestId,
    title,
    description,
    raw_input: description,
    priority,
    target_repo: repo,
    status,
    current_phase: status === 'queued' ? 'queued' : status,
    phase_progress: null,
    requester_id: source,
    source_channel: sourceChannel,
    notification_config: '{}',
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: 0,
    last_promoted_at: null,
    paused_at_phase: (parsed.paused_from as string | undefined) ?? null,
    source,
    adapter_metadata: adapterMetadata,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Convenience: build a JournalDb wrapper from a Repository
// ---------------------------------------------------------------------------

/**
 * Wrap a `Repository` as a {@link JournalDb}. The wrapper's `listAll`
 * uses a direct SELECT instead of a Repository helper because no existing
 * method covers "every row regardless of acknowledgment".
 */
export function wrapRepository(repo: Repository): JournalDb {
  // Reach into the repo's db via a minimal interface — we deliberately
  // avoid expanding Repository's public surface for a one-off recovery
  // call. (The same pattern is used by acknowledger.ts.)
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const internalDb: any = (repo as unknown as { db: any }).db;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    listAll(): RequestEntity[] {
      const rows = internalDb
        .prepare('SELECT * FROM requests')
        .all() as Array<unknown>;
      const out: RequestEntity[] = [];
      for (const r of rows) {
        const id = (r as { request_id?: string }).request_id;
        if (!id) continue;
        const mapped = repo.getRequest(id);
        if (mapped) out.push(mapped);
      }
      return out;
    },
    getRequest(id) {
      return repo.getRequest(id);
    },
    insertRequest(entity) {
      repo.insertRequest(entity);
    },
    updateRequest(id, updates) {
      repo.updateRequest(id, updates);
    },
  };
}
