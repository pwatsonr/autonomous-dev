/**
 * Two-phase commit handoff between intake SQLite and daemon filesystem.
 *
 * Implements SPEC-012-1-01 §Task 4 (`submitRequest`) and SPEC-012-1-02
 * §"State transition functions" (`pauseRequest`, `resumeRequest`,
 * `cancelRequest`, `setPriority`).
 *
 * --- Note on type re-use ----------------------------------------------------
 * `RequestSource` and `AdapterMetadata` are defined CANONICALLY in
 * `intake/types/request_source.ts` (PLAN-012-2). PLAN-012-1's earlier draft
 * proposed a parallel definition; that draft is superseded — we re-export
 * from `core/types.ts` (which itself re-exports `request_source`). All
 * downstream PLAN-012-1 modules import from `./types` for one-stop access.
 *
 * Likewise, `state.json` shape is owned by `intake/state/state_validator.ts`
 * (`StateJsonV11`); we produce/consume that exact type via
 * `intake/core/state_artifact.ts`.
 *
 * --- Protocol summary (SPEC-012-1-01 §"The protocol — IN THIS EXACT ORDER")
 * 1. Validate requestId, resolve requestPath via `buildRequestPath`.
 * 2. Acquire per-request advisory `FileLock`.
 * 3. Phase A — Temp write: open `state.json.tmp.<pid>.<rand>` with
 *    `O_CREAT|O_EXCL`, write serialized JSON, fsync.
 * 4. Phase B — SQLite txn: WAL mode, `BEGIN IMMEDIATE`, INSERT or UPDATE
 *    request row, COMMIT. (Logical commit point of the system.)
 * 5. Phase C — Atomic rename: `fs.rename(temp, state.json)`.
 * 6. Release lock; return `{ ok: true, ... }`.
 *
 * Failure modes are classified F1–F4 with recovery semantics described in
 * `core/types.ts` and SPEC-012-1-04.
 *
 * @module core/handoff_manager
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { RequestStatus } from '../adapters/adapter_interface';
import { Repository, type RequestEntity } from '../db/repository';
import {
  type StateJsonV11,
  writeStateJson,
} from '../state/state_validator';

import { FileLock } from './file_lock';
import { buildRequestPath } from './path_security';
import {
  HandoffError,
  type HandoffOptions,
  type HandoffResult,
  InvalidRequestIdError,
  SecurityError,
  type SubmitRequest,
} from './types';

// ---------------------------------------------------------------------------
// Re-exports for convenience (single import path for all PLAN-012-1 consumers)
// ---------------------------------------------------------------------------

export {
  HandoffError,
  type HandoffOptions,
  type HandoffResult,
  InvalidRequestIdError,
  type SubmitRequest,
  SecurityError,
  sanitizeErrorMessage,
} from './types';

// ---------------------------------------------------------------------------
// Better-sqlite3 lazy reference (mirrors db/migrator pattern)
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let BetterSqlite3: ((...args: unknown[]) => Database) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3');
} catch {
  // optional at compile time; callers that pass an explicit db never need it.
}

// ---------------------------------------------------------------------------
// Database injection (test seam)
// ---------------------------------------------------------------------------

/**
 * Optional injection: tests / orchestrators that already have an open
 * `better-sqlite3` instance + Repository pass them in to avoid the
 * env-driven open path. Production paths use `dbPath` from env.
 */
export interface HandoffDatabase {
  /** Opened better-sqlite3 instance (WAL mode, busy_timeout set). */
  db: Database;
  /** Repository wrapping `db`. */
  repo: Repository;
}

let injectedDb: HandoffDatabase | null = null;

/**
 * Test/integration override: replace the lazy env-loaded DB with an
 * already-open instance. Pass `null` to clear.
 */
export function setHandoffDatabase(handle: HandoffDatabase | null): void {
  injectedDb = handle;
}

/**
 * Resolve the {@link HandoffDatabase}. Prefers the test-injected handle
 * when set; otherwise opens the env-configured DB on first call (cached).
 */
function getHandoffDatabase(): HandoffDatabase {
  if (injectedDb !== null) return injectedDb;

  if (!BetterSqlite3) {
    throw new HandoffError(
      'SQLITE_COMMIT_FAILED',
      'better-sqlite3 unavailable and no test DB injected',
    );
  }
  const dbPath = process.env.AUTONOMOUS_DEV_INTAKE_DB ?? ':memory:';
  const db = (BetterSqlite3 as any)(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  const repo = new Repository(db);
  injectedDb = { db, repo };
  return injectedDb;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * ISO 8601 with millisecond precision and trailing `Z`. Matches the
 * existing repository convention (`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`).
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Generate a unique temp-file path for Phase A.
 *
 * Format: `state.json.tmp.<pid>.<16hex>` — the pid identifies the producer
 * for stale-temp recovery (SPEC-012-1-03), the random suffix is a
 * collision-avoidance device under high concurrency (the `O_EXCL` flag is
 * the actual safety mechanism). 8 random bytes ⇒ 16 hex chars.
 */
function buildTempPath(requestPath: string): string {
  const rand = crypto.randomBytes(8).toString('hex');
  return path.join(
    requestPath,
    `state.json.tmp.${process.pid}.${rand}`,
  );
}

/**
 * Write `state` to `tmpPath` as JSON with `O_CREAT|O_EXCL`. Fsync iff
 * `fsync !== false`. Throws on any failure (caller maps to F2).
 */
function writeTempStateSync(
  tmpPath: string,
  state: StateJsonV11,
  fsyncEnabled: boolean,
): void {
  // Round-trip JSON before write — catches non-serializable values eagerly.
  const payload = `${JSON.stringify(state, null, 2)}\n`;
  // Validate by re-parse (cheap; protects against e.g. NaN sneaking through).
  JSON.parse(payload);

  const fd = fs.openSync(
    tmpPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeSync(fd, payload);
    if (fsyncEnabled) {
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Build a {@link RequestEntity} for INSERT from a {@link SubmitRequest}.
 *
 * Fills the v1-required fields with sensible defaults so the repository
 * accepts the row. PLAN-012-1's `SubmitRequest` is intentionally narrower
 * than v1's full intake form — those fields will be backfilled by later
 * pipeline phases.
 */
function entityFromSubmit(
  req: SubmitRequest,
  status: RequestStatus,
  createdAt: string,
): RequestEntity {
  // Title falls back to the leading 80 chars of the description (matches
  // existing intake conventions for elided titles).
  const title = req.title ?? req.description.slice(0, 80);
  // For PLAN-012-1, `requesterId` defaults to the source value if the
  // caller doesn't supply one. Concrete adapters (cli/discord/etc) MAY
  // override with the resolved internal user identity.
  const requester = req.requesterId ?? req.source;

  return {
    request_id: req.requestId,
    title,
    description: req.description,
    raw_input: req.description,
    priority: req.priority,
    target_repo: req.repository,
    status,
    current_phase: status === 'queued' ? 'queued' : status,
    phase_progress: null,
    requester_id: requester,
    // `source_channel` is the legacy v1 channel discriminator; map the
    // newer `source` to it where possible. The two CHECK domains differ
    // (request_source.ts uses 'claude-app' / 'production-intelligence' /
    // 'portal'; source_channel only knows 'claude_app'/'discord'/'slack')
    // so we conservatively map unknowns to 'claude_app' to keep v1 happy.
    source_channel:
      req.source === 'discord'
        ? 'discord'
        : req.source === 'slack'
          ? 'slack'
          : 'claude_app',
    notification_config: '{}',
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: 0,
    last_promoted_at: null,
    paused_at_phase: null,
    source: req.source,
    adapter_metadata: req.adapterMetadata,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

/**
 * Phase B (`submitRequest` flavour): INSERT a new request row inside
 * `BEGIN IMMEDIATE`. Returns void on success; throws on any DB error
 * (caller maps to F3). Inserts go through `Repository.insertRequest` so
 * the v2 (source / adapter_metadata) columns are validated consistently.
 */
function insertRequestRowImmediate(
  handle: HandoffDatabase,
  entity: RequestEntity,
): void {
  // Use `BEGIN IMMEDIATE` (not the BEGIN EXCLUSIVE that better-sqlite3's
  // .transaction() would use) so the daemon can still read concurrently.
  handle.db.exec('BEGIN IMMEDIATE');
  try {
    handle.repo.insertRequest(entity);
    handle.db.exec('COMMIT');
  } catch (err) {
    try {
      handle.db.exec('ROLLBACK');
    } catch {
      // Already rolled back; swallow.
    }
    throw err;
  }
}

/**
 * Phase B (transition flavour): UPDATE an existing row inside
 * `BEGIN IMMEDIATE`. Used by pause/resume/cancel/setPriority.
 */
function updateRequestRowImmediate(
  handle: HandoffDatabase,
  requestId: string,
  updates: Partial<RequestEntity>,
): void {
  handle.db.exec('BEGIN IMMEDIATE');
  try {
    handle.repo.updateRequest(requestId, updates);
    handle.db.exec('COMMIT');
  } catch (err) {
    try {
      handle.db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Best-effort unlink. Treats ENOENT as success (idempotency).
 */
function unlinkIfExists(p: string): void {
  try {
    fs.unlinkSync(p);
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== 'ENOENT') {
      // Log via console to avoid pulling a logger dep here. Operators see
      // these in daemon logs; not fatal to the caller.
      // eslint-disable-next-line no-console
      console.warn(
        JSON.stringify({
          event: 'handoff.cleanup_failed',
          path: p,
          error: (err as Error).message,
        }),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Public file-write primitive: writeStateFileAtomic (consumed by reconciliation)
// ---------------------------------------------------------------------------

/**
 * Atomically write `state` as the `state.json` inside `requestPath`.
 *
 * This is the file-write half of the two-phase commit (Phase A + Phase C
 * minus the SQLite step), exposed for the operator-driven reconciliation
 * flow (PLAN-012-3). The reconciliation manager rebuilds `state.json` from
 * SQLite without going through the producer's submit/transition path; it
 * still needs the same atomicity guarantee — temp + fsync + atomic rename.
 *
 * Steps:
 *   1. `mkdirSync(requestPath, recursive, mode 0o700)` — idempotent.
 *   2. Write `state.json.tmp.<pid>.<rand>` with `O_CREAT|O_EXCL`, fsync.
 *   3. `fs.rename(temp, state.json)` — atomic on POSIX filesystems.
 *
 * On any failure during steps 2/3, the temp is best-effort unlinked.
 *
 * Spec note: SPEC-012-3-02 references `intake/core/two_phase_commit.ts`
 * — that filename does not exist in this codebase; the two-phase commit
 * primitives live here in `handoff_manager.ts` (PLAN-012-1). This helper
 * is the public seam for reconciliation; callers MUST use it rather than
 * `fs.writeFileSync` so the same atomic guarantees apply.
 *
 * @param requestPath  Absolute path to the request directory
 *                     (`<repo>/.autonomous-dev/requests/REQ-NNNNNN`).
 * @param state        Fully-built v1.1 state object to persist.
 * @param opts.fsync   Defaults to `true`. Set `false` only in tests.
 * @returns Absolute path to the written `state.json`.
 * @throws  Whatever `fs` throws on irrecoverable IO (ENOSPC, EACCES, ...).
 */
export async function writeStateFileAtomic(
  requestPath: string,
  state: StateJsonV11,
  opts?: { fsync?: boolean },
): Promise<string> {
  const fsyncEnabled = opts?.fsync !== false;

  fs.mkdirSync(requestPath, { recursive: true, mode: 0o700 });

  const tmpPath = buildTempPath(requestPath);
  const finalPath = path.join(requestPath, 'state.json');

  try {
    writeTempStateSync(tmpPath, state, fsyncEnabled);
  } catch (err) {
    unlinkIfExists(tmpPath);
    throw err;
  }

  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    unlinkIfExists(tmpPath);
    throw err;
  }

  return finalPath;
}

// Re-export the writer helper so reconciliation can build its own
// state files without using `fs.writeFile` directly.
export { writeStateJson } from '../state/state_validator';

// ---------------------------------------------------------------------------
// Internal: shared two-phase write
// ---------------------------------------------------------------------------

/**
 * Shared two-phase write protocol used by both `submitRequest` (INSERT) and
 * the four state-transition helpers (UPDATE).
 *
 * The caller supplies:
 *   - `requestPath`        — already realpath-resolved.
 *   - `state`              — fully-built StateJsonV11 to write.
 *   - `dbWork`             — opaque callback that performs Phase B inside
 *                            BEGIN IMMEDIATE.
 *   - `fsyncEnabled`       — controls fsync(temp).
 *
 * Returns the failure mode classifier so `submitRequest` can map to a
 * `HandoffResult`. Throws only if Phase A's lock acquire bubbles up.
 */
async function runTwoPhaseWrite(
  requestPath: string,
  state: StateJsonV11,
  dbWork: (handle: HandoffDatabase) => void,
  fsyncEnabled: boolean,
): Promise<
  | { ok: true; statePath: string }
  | { ok: false; failureMode: 'F2' | 'F3' | 'F4'; error: Error }
> {
  const tmpPath = buildTempPath(requestPath);
  const finalPath = path.join(requestPath, 'state.json');

  // --- Phase A: temp write + fsync ---------------------------------------
  try {
    writeTempStateSync(tmpPath, state, fsyncEnabled);
  } catch (err) {
    unlinkIfExists(tmpPath);
    return {
      ok: false,
      failureMode: 'F2',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // --- Phase B: SQLite commit (the LOGICAL commit point) -----------------
  let handle: HandoffDatabase;
  try {
    handle = getHandoffDatabase();
  } catch (err) {
    // No DB available at all → treat as F3 (post-temp, pre-commit) so
    // recovery cleans the orphan. This is rare in production.
    unlinkIfExists(tmpPath);
    return {
      ok: false,
      failureMode: 'F3',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  try {
    dbWork(handle);
  } catch (err) {
    // F3: SQLite txn failed. Temp must be unlinked; SQLite was rolled back
    // inside dbWork's catch.
    unlinkIfExists(tmpPath);
    return {
      ok: false,
      failureMode: 'F3',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  // --- Phase C: atomic rename --------------------------------------------
  try {
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    // F4: SQLite is committed but the rename failed. Mark the temp for
    // forward-recovery (recovery_runner promotes it on next startup).
    const promotion = `${tmpPath}.needs_promotion`;
    try {
      fs.renameSync(tmpPath, promotion);
    } catch {
      // If even THIS rename fails, recovery's journal_replay will detect
      // SQLite-row-without-state.json and mark `orphaned_lost`. We've
      // done the best we can.
    }
    return {
      ok: false,
      failureMode: 'F4',
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }

  return { ok: true, statePath: finalPath };
}

// ---------------------------------------------------------------------------
// Public API: submitRequest
// ---------------------------------------------------------------------------

/**
 * Two-phase commit submission of a brand-new request.
 *
 * See module docstring for the protocol; failure-mode classification is in
 * `core/types.ts`. On every `ok: false` return, callers are expected to
 * surface `result.error` (path-sanitized when `untrusted` was set) and
 * trigger any compensating action.
 */
export async function submitRequest(
  req: SubmitRequest,
  opts?: HandoffOptions,
): Promise<HandoffResult> {
  const lockTimeoutMs = opts?.lockTimeoutMs ?? 10000;
  const fsyncEnabled = opts?.fsync !== false;

  // ------- Phase 0: validate + resolve path ----------------------------
  let requestPath: string;
  try {
    requestPath = buildRequestPath(req.repository, req.requestId);
  } catch (err) {
    if (
      err instanceof InvalidRequestIdError
      || err instanceof SecurityError
    ) {
      return {
        ok: false,
        requestId: req.requestId,
        failureMode: 'F1',
        error: err.message,
        recoverable: false,
      };
    }
    throw err;
  }

  // Ensure the request dir exists (mode 0700 — operator-only).
  try {
    fs.mkdirSync(requestPath, { recursive: true, mode: 0o700 });
  } catch (err) {
    return {
      ok: false,
      requestId: req.requestId,
      failureMode: 'F1',
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    };
  }

  // ------- Phase 1: acquire lock --------------------------------------
  let lock: FileLock;
  try {
    lock = await FileLock.acquire(requestPath, lockTimeoutMs);
  } catch (err) {
    return {
      ok: false,
      requestId: req.requestId,
      failureMode: 'F1',
      error: err instanceof Error ? err.message : String(err),
      recoverable: false,
    };
  }

  try {
    // ------ Phases A/B/C (shared) -----------------------------------
    const createdAt = nowIso();
    // Build the on-disk state via the canonical state_artifact module
    // (lazy import to avoid circular dep at module load).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildInitialState } = require('./state_artifact') as typeof import('./state_artifact');
    const state = buildInitialState(req, createdAt);
    const entity = entityFromSubmit(req, 'queued', createdAt);

    const result = await runTwoPhaseWrite(
      requestPath,
      state,
      (handle) => insertRequestRowImmediate(handle, entity),
      fsyncEnabled,
    );

    if (result.ok) {
      return {
        ok: true,
        requestId: req.requestId,
        statePath: result.statePath,
        committedAt: createdAt,
      };
    }
    return {
      ok: false,
      requestId: req.requestId,
      failureMode: result.failureMode,
      error: result.error.message,
      // F2/F3/F4 are recoverable (operator can fix and retry; recovery
      // runner cleans orphaned artifacts on next daemon startup).
      recoverable: true,
    };
  } finally {
    await lock.release();
  }
}

// ---------------------------------------------------------------------------
// State transitions (SPEC-012-1-02 §"State transition functions")
// ---------------------------------------------------------------------------

/**
 * Read + parse the current `state.json` for an existing request. Returns
 * null if the file is missing or corrupt — caller treats as F1.
 */
function readCurrentState(requestPath: string): StateJsonV11 | null {
  const statePath = path.join(requestPath, 'state.json');
  try {
    const raw = fs.readFileSync(statePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed as StateJsonV11;
  } catch {
    return null;
  }
}

/**
 * Resolve a request's repo + requestPath without an explicit `repository`
 * arg. State transitions take only a requestId from the caller; we read
 * the SQLite row to learn the repo.
 */
function resolveRequestPathFromDb(requestId: string): string | null {
  let handle: HandoffDatabase;
  try {
    handle = getHandoffDatabase();
  } catch {
    return null;
  }
  const row = handle.repo.getRequest(requestId);
  if (!row || !row.target_repo) return null;
  try {
    return buildRequestPath(row.target_repo, requestId);
  } catch {
    return null;
  }
}

/** Common shape of a `phase_history` entry per SPEC-012-1-02. */
interface PhaseHistoryEntry {
  type: 'submitted' | 'paused' | 'resumed' | 'cancelled' | 'priority_changed';
  at: string;
  from?: string;
  to?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Apply a single state transition end-to-end (SPEC-012-1-02 §"Common protocol").
 *
 * Steps: lock → read → mutate → write temp → SQLite UPDATE in IMMEDIATE
 * txn → atomic rename → unlock.
 *
 * `mutator` receives the current state, returns the mutated state plus a
 * pre-condition error message (or null on success) and the SQLite
 * `Partial<RequestEntity>` updates to apply in Phase B.
 */
async function runTransition(
  requestId: string,
  mutator: (current: StateJsonV11) => {
    invalid: string | null;
    next: StateJsonV11;
    dbUpdates: Partial<RequestEntity>;
    historyEntry: PhaseHistoryEntry;
  },
  opts?: HandoffOptions,
  postRename?: () => void,
): Promise<HandoffResult> {
  const lockTimeoutMs = opts?.lockTimeoutMs ?? 10000;
  const fsyncEnabled = opts?.fsync !== false;

  try {
    validateRequestIdAndForward(requestId);
  } catch (err) {
    return {
      ok: false,
      requestId,
      failureMode: 'F1',
      error: (err as Error).message,
      recoverable: false,
    };
  }

  const requestPath = resolveRequestPathFromDb(requestId);
  if (!requestPath) {
    return {
      ok: false,
      requestId,
      failureMode: 'F1',
      error: 'request not found or repository missing',
      recoverable: false,
    };
  }

  let lock: FileLock;
  try {
    lock = await FileLock.acquire(requestPath, lockTimeoutMs);
  } catch (err) {
    return {
      ok: false,
      requestId,
      failureMode: 'F1',
      error: (err as Error).message,
      recoverable: false,
    };
  }

  try {
    const current = readCurrentState(requestPath);
    if (!current) {
      return {
        ok: false,
        requestId,
        failureMode: 'F1',
        error: 'state.json missing or corrupt',
        recoverable: false,
      };
    }

    const mutated = mutator(current);
    if (mutated.invalid) {
      return {
        ok: false,
        requestId,
        failureMode: 'F1',
        error: mutated.invalid,
        recoverable: false,
      };
    }

    // Append the history entry (immutably).
    const history = Array.isArray(current.phase_history)
      ? (current.phase_history as PhaseHistoryEntry[])
      : [];
    const next: StateJsonV11 = {
      ...mutated.next,
      phase_history: [...history, mutated.historyEntry],
    } as StateJsonV11;

    const result = await runTwoPhaseWrite(
      requestPath,
      next,
      (handle) =>
        updateRequestRowImmediate(handle, requestId, mutated.dbUpdates),
      fsyncEnabled,
    );

    if (result.ok) {
      // Post-rename hook (e.g., emit `request.cancelled`).
      if (postRename) postRename();
      return {
        ok: true,
        requestId,
        statePath: result.statePath,
        committedAt: nowIso(),
      };
    }
    return {
      ok: false,
      requestId,
      failureMode: result.failureMode,
      error: result.error.message,
      recoverable: true,
    };
  } finally {
    await lock.release();
  }
}

// Local helper to centralize the import of validateRequestId without
// pulling the cycle through types ⇆ path_security.
function validateRequestIdAndForward(id: string): void {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { validateRequestId } = require('./path_security') as typeof import('./path_security');
  validateRequestId(id);
}

// ---------------------------------------------------------------------------
// Pause / Resume / Cancel / SetPriority
// ---------------------------------------------------------------------------

/** Statuses where a transition is forbidden (terminal-ish). */
const TERMINAL_STATUSES = new Set<string>(['cancelled', 'completed', 'done', 'failed']);

export async function pauseRequest(
  requestId: string,
  reason?: string,
  opts?: HandoffOptions,
): Promise<HandoffResult> {
  return runTransition(
    requestId,
    (current) => {
      const status = String(current.status ?? '');
      if (status === 'paused' || TERMINAL_STATUSES.has(status)) {
        return {
          invalid: 'INVALID_TRANSITION',
          next: current,
          dbUpdates: {},
          historyEntry: {
            type: 'paused',
            at: nowIso(),
          },
        };
      }
      const at = nowIso();
      return {
        invalid: null,
        next: {
          ...current,
          paused_from: status,
          status: 'paused',
          updated_at: at,
        } as StateJsonV11,
        dbUpdates: {
          status: 'paused',
          paused_at_phase: status,
          updated_at: at,
        },
        historyEntry: {
          type: 'paused',
          at,
          from: status,
          to: 'paused',
          reason,
        },
      };
    },
    opts,
  );
}

export async function resumeRequest(
  requestId: string,
  opts?: HandoffOptions,
): Promise<HandoffResult> {
  return runTransition(
    requestId,
    (current) => {
      const status = String(current.status ?? '');
      const pausedFrom = current.paused_from as string | undefined;
      if (status !== 'paused' || !pausedFrom) {
        return {
          invalid: 'INVALID_TRANSITION',
          next: current,
          dbUpdates: {},
          historyEntry: { type: 'resumed', at: nowIso() },
        };
      }
      const at = nowIso();
      const next = { ...current, status: pausedFrom, updated_at: at } as StateJsonV11;
      delete (next as Record<string, unknown>).paused_from;
      return {
        invalid: null,
        next,
        dbUpdates: {
          status: pausedFrom as RequestStatus,
          paused_at_phase: null,
          updated_at: at,
        },
        historyEntry: {
          type: 'resumed',
          at,
          from: 'paused',
          to: pausedFrom,
        },
      };
    },
    opts,
  );
}

export async function cancelRequest(
  requestId: string,
  reason?: string,
  opts?: HandoffOptions,
): Promise<HandoffResult> {
  // Note: SPEC-012-1-02 says "emit request.cancelled AFTER successful
  // rename". We pass an emitter callback to runTransition that fires only
  // after Phase C succeeds. The actual emit channel is wired via the
  // event bus (see request_submitter.ts).
  let emitter: (() => void) | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const submitter = require('../router/request_submitter') as typeof import('../router/request_submitter');
    emitter = () => submitter.emitRequestCancelled(requestId, reason);
  } catch {
    // request_submitter not available (test isolation); skip emit.
  }

  return runTransition(
    requestId,
    (current) => {
      const status = String(current.status ?? '');
      if (status === 'cancelled' || TERMINAL_STATUSES.has(status)) {
        return {
          invalid: 'INVALID_TRANSITION',
          next: current,
          dbUpdates: {},
          historyEntry: { type: 'cancelled', at: nowIso() },
        };
      }
      const at = nowIso();
      return {
        invalid: null,
        next: { ...current, status: 'cancelled', updated_at: at } as StateJsonV11,
        dbUpdates: { status: 'cancelled', updated_at: at },
        historyEntry: {
          type: 'cancelled',
          at,
          from: status,
          to: 'cancelled',
          reason,
        },
      };
    },
    opts,
    emitter,
  );
}

export async function setPriority(
  requestId: string,
  priority: 'high' | 'normal' | 'low',
  opts?: HandoffOptions,
): Promise<HandoffResult> {
  if (priority !== 'high' && priority !== 'normal' && priority !== 'low') {
    return {
      ok: false,
      requestId,
      failureMode: 'F1',
      error: 'INVALID_TRANSITION',
      recoverable: false,
    };
  }

  return runTransition(
    requestId,
    (current) => {
      const status = String(current.status ?? '');
      if (TERMINAL_STATUSES.has(status)) {
        return {
          invalid: 'INVALID_TRANSITION',
          next: current,
          dbUpdates: {},
          historyEntry: { type: 'priority_changed', at: nowIso() },
        };
      }
      const at = nowIso();
      const oldPriority = current.priority as string | undefined;
      return {
        invalid: null,
        next: { ...current, priority, updated_at: at } as StateJsonV11,
        dbUpdates: { priority, updated_at: at },
        historyEntry: {
          type: 'priority_changed',
          at,
          from: oldPriority,
          to: priority,
        },
      };
    },
    opts,
  );
}
