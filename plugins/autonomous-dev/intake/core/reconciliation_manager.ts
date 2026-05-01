/**
 * Reconciliation manager — operator-driven drift detection between the
 * intake-router SQLite store and per-request `state.json` files.
 *
 * This module is the public, scriptable counterpart to the daemon-startup
 * recovery in `intake/recovery/recovery_runner.ts`. The recovery runner runs
 * automatically at daemon startup; ReconciliationManager exposes the same
 * underlying operations (detect, repair, temp cleanup) as a callable API
 * the operator invokes ad-hoc through `autonomous-dev request reconcile`.
 *
 * Spec coverage:
 *   - SPEC-012-3-01 — `detectDivergence()` (read-only divergence scan).
 *   - SPEC-012-3-02 — `repair()`, `cleanupOrphanedTemps()` (mutating phases).
 *   - SPEC-012-3-03 — `runFullReconciliation()` (CLI-facing convenience).
 *
 * Concurrency model:
 *   Each public mutating operation acquires `<repo>/.autonomous-dev/.reconcile.lock`
 *   via the in-house {@link FileLock}. Two concurrent reconcile invocations
 *   on the same repo serialize; cross-repo invocations are independent.
 *   When the lock is busy, callers see a {@link ReconcileBusyError}.
 *
 * @module core/reconciliation_manager
 */

import * as fs from 'fs';
import * as path from 'path';

import type { Repository, RequestEntity } from '../db/repository';
import type { Logger } from '../authz/audit_logger';

import { FileLock } from './file_lock';
import {
  type DivergenceCategory,
  type DivergenceReport,
  ReconcileBusyError,
} from './types/reconciliation';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tolerance (ms) on `stale_file` detection — absorbs rename-vs-SQLite skew. */
const STALE_TOLERANCE_MS = 1000;

/** Per-repo advisory lock file (lives next to `requests/`). */
const RECONCILE_LOCK_BASENAME = '.reconcile.lock';

/** Timeout for the reconcile advisory lock acquire — short, no retries. */
const RECONCILE_LOCK_TIMEOUT_MS = 100;

/** Regex for canonical request directory names. */
const REQUEST_DIR_REGEX = /^REQ-\d{6}$/;

/** Regex for extracting REQ-NNNNNN from a state.json absolute path. */
const STATE_PATH_REGEX = /\/(REQ-\d{6})\/state\.json$/;

/**
 * Canonical fields compared between SQLite and `state.json` for the
 * `content_mismatch` classification. The map's value is the field name in
 * `state.json` (which may differ from the SQLite column name).
 *
 * Notes on field selection:
 *   - `target_repo` ↔ `repository`: SQLite stores the column as
 *     `target_repo`; state.json's analogue is the top-level `repository`.
 *   - `state` ↔ `status`: PLAN-012-2's state.json uses `status`; the
 *     SQLite v2 column is `status`. The spec lists `state`/`state` but
 *     the actual column / json key are both `status`. We compare `status`.
 *   - `created_at`: SQLite stores ISO-8601; state.json also stores ISO-8601.
 *     Comparison is strict-string.
 */
const COMPARISON_FIELDS: ReadonlyArray<{
  sqliteField: keyof RequestEntity;
  stateField: string;
}> = [
  { sqliteField: 'request_id', stateField: 'request_id' },
  { sqliteField: 'source', stateField: 'source' },
  { sqliteField: 'priority', stateField: 'priority' },
  { sqliteField: 'status', stateField: 'status' },
  { sqliteField: 'target_repo', stateField: 'repository' },
  { sqliteField: 'created_at', stateField: 'created_at' },
  { sqliteField: 'description', stateField: 'description' },
];

// ---------------------------------------------------------------------------
// ReconciliationManager
// ---------------------------------------------------------------------------

/**
 * Operator-facing reconciliation engine.
 *
 * Construct once per process; instances are stateless across calls but
 * hold the `Repository` + `Logger` dependencies. The optional `clock`
 * parameter exists for deterministic tests; production callers should
 * accept the `Date.now` default.
 *
 * Method semantics:
 *   - `detectDivergence(repo)` — read-only; safe in any environment.
 *   - `repair(report, opts)` — mutates SQLite or filesystem (SPEC-012-3-02).
 *   - `cleanupOrphanedTemps(repo, opts)` — removes/promotes temp artifacts.
 *   - `runFullReconciliation(opts)` — composes the above for the CLI
 *     (SPEC-012-3-03).
 */
export class ReconciliationManager {
  constructor(
    private readonly db: Repository,
    private readonly logger: Logger,
    private readonly clock: () => number = Date.now,
  ) {}

  // -------------------------------------------------------------------------
  // detectDivergence (SPEC-012-3-01)
  // -------------------------------------------------------------------------

  /**
   * Scan `repoPath` for drift between SQLite and per-request `state.json`.
   *
   * Algorithm (per SPEC-012-3-01):
   *   1. Resolve `requestsDir = <repo>/.autonomous-dev/requests`. If absent,
   *      return `[]`.
   *   2. Acquire the per-repo advisory lock. Throw {@link ReconcileBusyError}
   *      on contention.
   *   3. Phase A: SQLite → filesystem. For every SQLite row, look for the
   *      matching `state.json`; emit `missing_file`, `stale_file`, or
   *      `content_mismatch` as appropriate.
   *   4. Phase B: filesystem → SQLite. For every `state.json` not already
   *      classified by Phase A, emit `orphaned_file`.
   *   5. Release the lock; return concatenated reports (Phase A wins on dup).
   *
   * Read-only: never mutates SQLite or filesystem. All FS read errors during
   * classification are absorbed into a `DivergenceReport` rather than thrown.
   *
   * @param repoPath  Absolute (preferably realpath-resolved) repo root.
   * @throws {ReconcileBusyError} when the advisory lock is contended.
   */
  async detectDivergence(repoPath: string): Promise<DivergenceReport[]> {
    const requestsDir = path.join(repoPath, '.autonomous-dev', 'requests');
    if (!fs.existsSync(requestsDir)) {
      return [];
    }

    const lock = await this.acquireReconcileLock(repoPath);
    try {
      const phaseA = await this.scanSqliteSide(repoPath, requestsDir);
      const phaseB = await this.scanFilesystemSide(repoPath, requestsDir);

      // Deduplicate: Phase A wins for any request_id covered by both phases
      // (Phase B emits `orphaned_file` only when SQLite has no row, so a
      // collision is rare — but a row inserted between the two scans could
      // produce one; keep the Phase A entry to honor "SQLite is canonical").
      const seen = new Set<string>(phaseA.map((r) => r.request_id));
      const dedupedB = phaseB.filter((r) => !seen.has(r.request_id));

      return [...phaseA, ...dedupedB];
    } finally {
      await lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Phase A — SQLite → filesystem
  // -------------------------------------------------------------------------

  /**
   * Phase A: For every SQLite row scoped to `repoPath`, check whether a
   * matching `state.json` exists, is fresh, and matches the canonical
   * field set. Emits one report per drift event.
   */
  private async scanSqliteSide(
    repoPath: string,
    requestsDir: string,
  ): Promise<DivergenceReport[]> {
    const requests = this.db.getAllRequestsForRepo(repoPath);
    const reports: DivergenceReport[] = [];

    for (const request of requests) {
      const statePath = path.join(requestsDir, request.request_id, 'state.json');
      if (!fs.existsSync(statePath)) {
        reports.push({
          request_id: request.request_id,
          repository: repoPath,
          category: 'missing_file',
          description: `state.json missing for ${request.request_id}`,
          sqlite_state: request,
          sqlite_updated_at: this.parseUpdatedAtMs(request.updated_at),
          detected_at: this.nowIso(),
        });
        continue;
      }

      const report = await this.classifyExisting(request, statePath, repoPath);
      if (report !== null) {
        reports.push(report);
      }
    }
    return reports;
  }

  /**
   * Compare an existing `state.json` against a SQLite row and emit a
   * divergence report if they disagree.
   *
   * Returns `null` when the two sides agree (no drift to report).
   *
   * Classification order (first match wins):
   *   1. Unparseable state.json → `content_mismatch` with `fields_differing: ['<parse>']`.
   *   2. SQLite newer than disk by >`STALE_TOLERANCE_MS` → `stale_file`.
   *   3. Any canonical field differs → `content_mismatch`.
   *   4. Otherwise → `null` (clean).
   */
  private async classifyExisting(
    request: RequestEntity,
    statePath: string,
    repoPath: string,
  ): Promise<DivergenceReport | null> {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(statePath);
    } catch (err) {
      // Could not stat the file we just confirmed exists (race or EACCES).
      // Treat as a content_mismatch so the operator surfaces it rather than
      // silently dropping the row.
      return {
        request_id: request.request_id,
        repository: repoPath,
        category: 'content_mismatch',
        description: `state.json stat failed: ${err instanceof Error ? err.message : String(err)}`,
        sqlite_state: request,
        sqlite_updated_at: this.parseUpdatedAtMs(request.updated_at),
        fields_differing: ['<stat>'],
        detected_at: this.nowIso(),
      };
    }

    const fsMtimeMs = stat.mtimeMs;
    const sqliteUpdatedAtMs = this.parseUpdatedAtMs(request.updated_at);

    // -- Parse state.json --
    let fsData: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(statePath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('state.json must be a JSON object');
      }
      fsData = parsed as Record<string, unknown>;
    } catch (err) {
      return {
        request_id: request.request_id,
        repository: repoPath,
        category: 'content_mismatch',
        description: `state.json unparseable: ${err instanceof Error ? err.message : String(err)}`,
        sqlite_state: request,
        sqlite_updated_at: sqliteUpdatedAtMs,
        filesystem_state: null,
        filesystem_mtime_ms: fsMtimeMs,
        fields_differing: ['<parse>'],
        detected_at: this.nowIso(),
      };
    }

    // -- Stale check (SQLite newer than disk by > tolerance) --
    if (
      sqliteUpdatedAtMs !== undefined
      && sqliteUpdatedAtMs - fsMtimeMs > STALE_TOLERANCE_MS
    ) {
      return {
        request_id: request.request_id,
        repository: repoPath,
        category: 'stale_file',
        description:
          `state.json mtime older than SQLite updated_at by ${Math.round(sqliteUpdatedAtMs - fsMtimeMs)}ms`,
        sqlite_state: request,
        filesystem_state: fsData,
        sqlite_updated_at: sqliteUpdatedAtMs,
        filesystem_mtime_ms: fsMtimeMs,
        detected_at: this.nowIso(),
      };
    }

    // -- Field-by-field comparison --
    const differing: string[] = [];
    for (const { sqliteField, stateField } of COMPARISON_FIELDS) {
      const sqliteVal = request[sqliteField];
      const stateVal = fsData[stateField];
      if (!this.fieldsEqual(sqliteVal, stateVal)) {
        differing.push(stateField);
      }
    }

    if (differing.length > 0) {
      return {
        request_id: request.request_id,
        repository: repoPath,
        category: 'content_mismatch',
        description: `fields differ: ${differing.join(', ')}`,
        sqlite_state: request,
        filesystem_state: fsData,
        sqlite_updated_at: sqliteUpdatedAtMs,
        filesystem_mtime_ms: fsMtimeMs,
        fields_differing: differing,
        detected_at: this.nowIso(),
      };
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Phase B — filesystem → SQLite
  // -------------------------------------------------------------------------

  /**
   * Phase B: For every `state.json` on disk that does NOT have a SQLite
   * row, emit an `orphaned_file` report. Unparseable JSON emits a report
   * with `filesystem_state: null` rather than throwing.
   *
   * Skips temp/promotion files (`state.json.tmp.*`, `*.needs_promotion`) —
   * those are SPEC-012-3-02's responsibility.
   */
  private async scanFilesystemSide(
    repoPath: string,
    requestsDir: string,
  ): Promise<DivergenceReport[]> {
    const reports: DivergenceReport[] = [];
    const stateFiles = await this.listStateFiles(requestsDir);

    for (const statePath of stateFiles) {
      const requestId = this.extractRequestIdFromPath(statePath);
      if (requestId === null) continue;

      const row = this.db.getRequest(requestId);
      if (row !== null) continue; // handled in Phase A

      let stat: fs.Stats | null = null;
      try {
        stat = fs.statSync(statePath);
      } catch {
        // File vanished between listdir and stat — race; skip.
        continue;
      }

      // Try to parse; null filesystem_state on failure (per spec).
      let parsed: unknown = null;
      let unparseable = false;
      try {
        const raw = fs.readFileSync(statePath, 'utf-8');
        parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          unparseable = true;
          parsed = null;
        }
      } catch {
        unparseable = true;
        parsed = null;
      }

      reports.push({
        request_id: requestId,
        repository: repoPath,
        category: 'orphaned_file',
        description: unparseable
          ? `unparseable orphaned state.json (no SQLite row for ${requestId})`
          : `orphaned state.json (no SQLite row for ${requestId})`,
        filesystem_state: parsed,
        filesystem_mtime_ms: stat.mtimeMs,
        detected_at: this.nowIso(),
      });
    }

    return reports;
  }

  // -------------------------------------------------------------------------
  // Helpers — file enumeration
  // -------------------------------------------------------------------------

  /**
   * Walk `requestsDir` non-recursively and collect every `state.json` found
   * inside an immediate `REQ-NNNNNN` subdirectory. Skips temp / promotion
   * artifacts and any directory that does not match the canonical naming.
   *
   * Returns absolute paths, deterministic order (lexicographic by request_id).
   */
  private async listStateFiles(requestsDir: string): Promise<string[]> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(requestsDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!REQUEST_DIR_REGEX.test(entry.name)) {
        // SPEC: silently skip non-conforming entries; logger.info at debug
        // is intentionally NOT a console.log to avoid noise in CLI output.
        continue;
      }
      const statePath = path.join(requestsDir, entry.name, 'state.json');
      // Skip the path entirely if it doesn't exist (Phase A handles
      // missing_file emission for SQLite-known IDs; for non-SQLite-known
      // IDs there's nothing to emit on the FS side).
      try {
        const st = fs.statSync(statePath);
        if (st.isFile()) {
          results.push(statePath);
        }
      } catch {
        // File missing or unreadable — skip; Phase A handles SQLite side.
      }
    }
    // Sort for deterministic ordering across runs.
    results.sort();
    return results;
  }

  /**
   * Extract the canonical request id from an absolute `state.json` path.
   * Returns `null` if the path does not end in `<REQ-NNNNNN>/state.json`.
   */
  private extractRequestIdFromPath(statePath: string): string | null {
    const m = STATE_PATH_REGEX.exec(statePath);
    return m ? m[1] : null;
  }

  // -------------------------------------------------------------------------
  // Helpers — comparison & locking
  // -------------------------------------------------------------------------

  /**
   * Strict equality used by the canonical-field comparison.
   *
   * Treats `null` and `undefined` as equal (both indicate "absent"). For
   * every other type pair, falls back to JSON-string comparison so nested
   * objects compare structurally (sufficient for the small canonical field
   * set; nothing here is deeply nested or contains class instances).
   */
  private fieldsEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null && b === undefined) return true;
    if (a === undefined && b === null) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a === 'object' && a !== null && b !== null) {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Acquire the per-repo reconcile advisory lock. Uses the in-house
   * {@link FileLock} (same primitive as the per-request handoff lock) so
   * we don't introduce a `proper-lockfile` dependency.
   *
   * The lock dir (`.autonomous-dev/`) is created with mode 0o700 if it
   * doesn't already exist. Lock contention surfaces as
   * {@link ReconcileBusyError}, NOT a {@link LockTimeoutError}, so the
   * CLI can map it to exit code 2 distinct from other errors.
   */
  private async acquireReconcileLock(repoPath: string): Promise<FileLock> {
    const lockDir = path.join(repoPath, '.autonomous-dev');
    try {
      fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new ReconcileBusyError(
        `failed to prepare reconcile lock dir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // FileLock uses `.lock` as the basename; we want `.reconcile.lock` to
    // avoid clashing with per-request locks. Acquire on a synthetic
    // sub-directory whose name encodes that — but FileLock's API takes a
    // dir + appends `.lock`, which would yield `<dir>/.lock`. To get
    // `<repo>/.autonomous-dev/.reconcile.lock` we lock on a "virtual"
    // child dir; FileLock doesn't dereference the dir itself, only the
    // computed lock path.
    //
    // Simpler: pass the autonomous-dev dir AND override the basename via
    // a dedicated wrapper. FileLock takes the dir — to keep the public
    // FileLock API unchanged, we use a dedicated subdirectory whose `.lock`
    // file IS the reconcile lock.
    const reconcileLockHolderDir = path.join(lockDir, RECONCILE_LOCK_BASENAME + '.d');
    try {
      fs.mkdirSync(reconcileLockHolderDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new ReconcileBusyError(
        `failed to prepare reconcile lock holder dir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      return await FileLock.acquire(reconcileLockHolderDir, RECONCILE_LOCK_TIMEOUT_MS);
    } catch (err) {
      throw new ReconcileBusyError(
        `another reconcile is in progress for ${repoPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Helpers — time
  // -------------------------------------------------------------------------

  /**
   * Parse a SQLite `updated_at` (ISO-8601 string) into epoch ms.
   * Returns `undefined` for unparseable input rather than NaN so the caller
   * sees a clean "missing timestamp" rather than a misleading 0.
   */
  private parseUpdatedAtMs(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : undefined;
  }

  /** ISO-8601 UTC string sourced from the injected clock. */
  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  // -------------------------------------------------------------------------
  // Internal access (for SPEC-012-3-02 / -03 follow-ups)
  // -------------------------------------------------------------------------

  /** Exposed for sibling modules in the same package; not part of the public API. */
  protected getDb(): Repository {
    return this.db;
  }

  /** Exposed for sibling modules in the same package; not part of the public API. */
  protected getLogger(): Logger {
    return this.logger;
  }
}

// Re-export the category type for convenience so consumers only need to
// import from this module.
export type { DivergenceCategory };
