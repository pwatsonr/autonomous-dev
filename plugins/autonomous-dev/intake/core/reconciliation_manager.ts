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

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { Repository, RequestEntity } from '../db/repository';
import type { Logger } from '../authz/audit_logger';
import type { ChannelType, Priority, RequestStatus } from '../adapters/adapter_interface';
import type { StateJsonV11 } from '../state/state_validator';
import type { AdapterMetadata, RequestSource } from '../types/request_source';
import { isRequestSource } from '../types/request_source';

import { FileLock } from './file_lock';
import { writeStateFileAtomic } from './handoff_manager';
import {
  type DivergenceCategory,
  type DivergenceReport,
  type RepairOptions,
  type RepairResult,
  type TempCleanupReport,
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
 * Liveness window for `state.json.tmp.*` files. Any temp newer than this
 * is preserved (might be an active commit). 10 minutes per SPEC-012-3-02
 * §"Orphaned Temp File Cleanup". Operators can override via
 * `AUTONOMOUS_DEV_RECONCILE_TEMP_AGE_MS`.
 */
const DEFAULT_TEMP_AGE_MS = 10 * 60 * 1000;

/** Regex for extracting `pid` from `state.json.tmp.<pid>.<hex>...` filenames. */
const TEMP_PID_REGEX = /^state\.json\.tmp\.(\d+)\./;

/** Suffix that marks a temp produced by F4 forward-recovery. */
const NEEDS_PROMOTION_SUFFIX = '.needs_promotion';

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
// Internal record types
// ---------------------------------------------------------------------------

/**
 * Internal record for one `state.json.tmp.*` candidate considered by
 * {@link ReconciliationManager.cleanupOrphanedTemps}.
 */
interface TempCandidate {
  path: string;
  mtimeMs: number;
  /** Producer PID parsed from the temp filename, or `null` when absent. */
  pid: number | null;
}

// ---------------------------------------------------------------------------
// runFullReconciliation contract
// ---------------------------------------------------------------------------

/**
 * Options for {@link ReconciliationManager.runFullReconciliation}.
 *
 * The CLI dispatcher fills these from operator flags (see
 * `intake/cli/reconcile_command.ts`). The phase booleans (`repair`,
 * `cleanupTemps`) gate whether each subsequent phase runs at all.
 */
export interface FullReconciliationOptions {
  repoPath: string;
  /** When true, run repair on every divergence detected. */
  repair?: boolean;
  /** When true, run temp cleanup AFTER repair. */
  cleanupTemps?: boolean;
  /** Forward to repair / cleanup. */
  dryRun?: boolean;
  /** Forward to repair / cleanup. */
  force?: boolean;
  /** Interactive confirmation callback (forwarded). */
  confirm?: RepairOptions['confirm'];
}

/**
 * Envelope returned by {@link ReconciliationManager.runFullReconciliation}.
 * Each phase's output is optional and only populated when the corresponding
 * option was enabled.
 */
export interface FullReconciliationResult {
  reports: DivergenceReport[];
  repairs?: RepairResult[];
  cleanup?: TempCleanupReport;
}

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
  /**
   * Liveness window for `state.json.tmp.*` files in milliseconds.
   * Read once at construction time from
   * `AUTONOMOUS_DEV_RECONCILE_TEMP_AGE_MS` if set, else
   * {@link DEFAULT_TEMP_AGE_MS}.
   */
  private readonly tempAgeMs: number;

  constructor(
    private readonly db: Repository,
    private readonly logger: Logger,
    private readonly clock: () => number = Date.now,
  ) {
    const envOverride = process.env.AUTONOMOUS_DEV_RECONCILE_TEMP_AGE_MS;
    const parsed = envOverride === undefined ? NaN : Number(envOverride);
    this.tempAgeMs =
      Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TEMP_AGE_MS;
  }

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
  // repair (SPEC-012-3-02)
  // -------------------------------------------------------------------------

  /**
   * Apply the appropriate repair strategy for a single divergence.
   *
   * Routing per `report.category`:
   *   - `missing_file`     → rebuild `state.json` from the SQLite row.
   *   - `stale_file`       → overwrite stale `state.json` from SQLite.
   *   - `content_mismatch` → newer-wins per-record direction; SQLite or
   *                          state.json overwritten depending on timestamps.
   *   - `orphaned_file`    → archive (always for unparseable) or import to
   *                          SQLite (when parseable + `force` or operator
   *                          confirms).
   *
   * All filesystem writes go through {@link writeStateFileAtomic} from
   * `handoff_manager`. Direct `fs.writeFile` is forbidden by the spec.
   *
   * In `dryRun` mode: the action is reported as `'skipped'` and a
   * `reconcile.repair.dry_run` log entry is emitted; nothing on disk or
   * in SQLite is touched.
   *
   * @param report   Divergence report from {@link detectDivergence}.
   * @param options  Per-call options. Defaults: `dryRun=false`,
   *                 `force=false`, `confirm=async () => false`.
   * @returns A {@link RepairResult} describing what was done.
   */
  async repair(
    report: DivergenceReport,
    options: RepairOptions = {},
  ): Promise<RepairResult> {
    const dryRun = options.dryRun === true;
    const force = options.force === true;
    const confirm =
      options.confirm ?? ((async () => false) as RepairOptions['confirm']);

    // Dry-run short-circuits all mutating paths uniformly.
    if (dryRun) {
      this.logger.info('reconcile.repair.dry_run', {
        request_id: report.request_id,
        category: report.category,
        would_perform:
          report.category === 'orphaned_file' && report.filesystem_state === null
            ? 'manual_required'
            : 'auto_repaired',
      });
      // Provide before_hash === after_hash on the existing file (when present)
      // so the spec's "verify by hash equality" acceptance check holds.
      const existing = await this.maybeHashStateFile(report);
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'skipped',
        before_hash: existing,
        after_hash: existing,
      };
    }

    try {
      switch (report.category) {
        case 'missing_file':
          return await this.repairMissingFile(report);
        case 'stale_file':
          return await this.repairStaleFile(report);
        case 'content_mismatch':
          return await this.repairContentMismatch(report, force, confirm!);
        case 'orphaned_file':
          return await this.repairOrphanedFile(report, force, confirm!);
        default: {
          // Exhaustiveness: future-proofing for added DivergenceCategory members.
          const _exhaustive: never = report.category;
          void _exhaustive;
          return {
            request_id: report.request_id,
            category: report.category,
            action: 'skipped',
            error_message: `unknown divergence category: ${String(report.category)}`,
          };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error('reconcile.repair.failed', {
        request_id: report.request_id,
        category: report.category,
        error: msg,
      });
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'manual_required',
        error_message: msg,
      };
    }
  }

  /**
   * `missing_file`: SQLite row exists, state.json absent → rebuild file.
   */
  private async repairMissingFile(
    report: DivergenceReport,
  ): Promise<RepairResult> {
    if (!report.sqlite_state) {
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'manual_required',
        error_message: 'missing_file report lacks sqlite_state',
      };
    }
    const requestDir = this.requestDir(report.repository, report.request_id);
    const state = this.buildStateFromSqlite(report.sqlite_state);
    await writeStateFileAtomic(requestDir, state);
    const after = this.hashState(state);
    this.logger.info('reconcile.repair.applied', {
      request_id: report.request_id,
      category: report.category,
      after_hash: after,
    });
    return {
      request_id: report.request_id,
      category: report.category,
      action: 'auto_repaired',
      after_hash: after,
    };
  }

  /**
   * `stale_file`: state.json exists but is older than SQLite — overwrite
   * from SQLite (canonical when newer).
   */
  private async repairStaleFile(
    report: DivergenceReport,
  ): Promise<RepairResult> {
    if (!report.sqlite_state) {
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'manual_required',
        error_message: 'stale_file report lacks sqlite_state',
      };
    }
    const requestDir = this.requestDir(report.repository, report.request_id);
    const before = await this.maybeHashStateFile(report);
    const state = this.buildStateFromSqlite(report.sqlite_state);
    await writeStateFileAtomic(requestDir, state);
    const after = this.hashState(state);
    this.logger.info('reconcile.repair.applied', {
      request_id: report.request_id,
      category: report.category,
      before_hash: before,
      after_hash: after,
    });
    return {
      request_id: report.request_id,
      category: report.category,
      action: 'auto_repaired',
      before_hash: before,
      after_hash: after,
    };
  }

  /**
   * `content_mismatch`: newer-wins per record. The whole record's direction
   * is decided by which timestamp is newer (no field-level merging — see
   * SPEC-012-3-02 §Notes).
   *
   * When SQLite is newer → behave like {@link repairStaleFile}.
   * When state.json is newer → for each `field` in `fields_differing`,
   * call `db.updateRequestField(...)` with the state.json value. The
   * Repository bumps `updated_at` automatically.
   */
  private async repairContentMismatch(
    report: DivergenceReport,
    force: boolean,
    confirm: NonNullable<RepairOptions['confirm']>,
  ): Promise<RepairResult> {
    if (!report.sqlite_state) {
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'manual_required',
        error_message: 'content_mismatch report lacks sqlite_state',
      };
    }

    if (!force) {
      const fieldsList = (report.fields_differing ?? []).join(', ');
      const winner =
        (report.sqlite_updated_at ?? 0) > (report.filesystem_mtime_ms ?? 0)
          ? 'SQLite'
          : 'filesystem';
      const ok = await confirm(
        `Repair ${report.request_id}: ${fieldsList} → ${winner}?`,
      );
      if (!ok) {
        return {
          request_id: report.request_id,
          category: report.category,
          action: 'skipped',
        };
      }
    }

    const sqliteWins =
      (report.sqlite_updated_at ?? 0) > (report.filesystem_mtime_ms ?? 0);

    if (sqliteWins) {
      const requestDir = this.requestDir(report.repository, report.request_id);
      const before = await this.maybeHashStateFile(report);
      const state = this.buildStateFromSqlite(report.sqlite_state);
      await writeStateFileAtomic(requestDir, state);
      const after = this.hashState(state);
      this.logger.info('reconcile.repair.applied', {
        request_id: report.request_id,
        category: report.category,
        direction: 'sqlite_to_fs',
        before_hash: before,
        after_hash: after,
      });
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'auto_repaired',
        before_hash: before,
        after_hash: after,
      };
    }

    // state.json is newer — push each differing field back into SQLite.
    const fsState = report.filesystem_state as Record<string, unknown> | null;
    if (fsState === null) {
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'manual_required',
        error_message:
          'content_mismatch (fs newer) but filesystem_state unparseable',
      };
    }
    const fieldsDiffering = report.fields_differing ?? [];
    this.db.transaction(() => {
      for (const stateField of fieldsDiffering) {
        const sqliteField = this.mapStateFieldToSqliteField(stateField);
        if (sqliteField === null) continue;
        this.db.updateRequestField(
          report.request_id,
          sqliteField,
          fsState[stateField],
        );
      }
    });
    this.logger.info('reconcile.repair.applied', {
      request_id: report.request_id,
      category: report.category,
      direction: 'fs_to_sqlite',
      fields: fieldsDiffering,
    });
    return {
      request_id: report.request_id,
      category: report.category,
      action: 'auto_repaired',
    };
  }

  /**
   * `orphaned_file`: state.json without a SQLite row.
   *
   * Disposition (per SPEC-012-3-02):
   *  - filesystem_state === null → ALWAYS archive (never import).
   *  - parseable + force          → import; on schema failure archive.
   *  - parseable + !force         → confirm; on yes import, on no archive.
   */
  private async repairOrphanedFile(
    report: DivergenceReport,
    force: boolean,
    confirm: NonNullable<RepairOptions['confirm']>,
  ): Promise<RepairResult> {
    const statePath = path.join(
      this.requestDir(report.repository, report.request_id),
      'state.json',
    );

    if (report.filesystem_state === null) {
      const archived = this.archiveFile(statePath, report.repository);
      this.logger.info('reconcile.repair.applied', {
        request_id: report.request_id,
        category: report.category,
        disposition: 'archived',
        archived_path: archived,
      });
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'manual_required',
        archived_path: archived,
      };
    }

    let importIt: boolean;
    if (force) {
      importIt = true;
    } else {
      importIt = await confirm(
        `Import orphaned ${report.request_id}? (No → archive)`,
      );
    }

    if (!importIt) {
      const archived = this.archiveFile(statePath, report.repository);
      this.logger.info('reconcile.repair.applied', {
        request_id: report.request_id,
        category: report.category,
        disposition: 'archived',
        archived_path: archived,
      });
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'manual_required',
        archived_path: archived,
      };
    }

    // Validate + import.
    const fsState = report.filesystem_state as Record<string, unknown>;
    const validation = this.validateStateSchema(fsState);
    if (!validation.valid) {
      const archived = this.archiveFile(statePath, report.repository);
      this.logger.warn('reconcile.repair.archive_invalid', {
        request_id: report.request_id,
        archived_path: archived,
        errors: validation.errors,
      });
      return {
        request_id: report.request_id,
        category: report.category,
        action: 'manual_required',
        archived_path: archived,
        error_message: `schema invalid: ${validation.errors.join('; ')}`,
      };
    }

    const entity = this.buildSqliteFromState(
      fsState,
      report.request_id,
      report.repository,
    );
    this.db.insertRequest(entity);
    this.logger.info('reconcile.repair.applied', {
      request_id: report.request_id,
      category: report.category,
      disposition: 'imported',
    });
    return {
      request_id: report.request_id,
      category: report.category,
      action: 'auto_repaired',
    };
  }

  // -------------------------------------------------------------------------
  // cleanupOrphanedTemps (SPEC-012-3-02)
  // -------------------------------------------------------------------------

  /**
   * Walk every `REQ-NNNNNN` directory under `<repo>/.autonomous-dev/requests/`
   * and triage `state.json.tmp.*` files left by interrupted two-phase commits.
   *
   * Per-file disposition:
   *  - mtime within {@link tempAgeMs}                 → preserve.
   *  - PID alive (`process.kill(pid, 0)` succeeds)    → preserve.
   *  - filename ends `.needs_promotion`:
   *       schema-valid → atomic rename to `state.json` (overwrites stale).
   *       invalid      → move to `archive/orphans/...needs_promotion.json`.
   *  - else → `unlink`.
   *
   * Errors during single-file steps are recorded in `errors[]` and processing
   * continues. The function never throws to the caller.
   *
   * @param repoPath  Realpath-resolved repository root.
   * @param options   Honors `dryRun` and `force` (force is required to
   *                  perform any destructive action when `confirm` returns
   *                  false).
   */
  async cleanupOrphanedTemps(
    repoPath: string,
    options: RepairOptions = {},
  ): Promise<TempCleanupReport> {
    const dryRun = options.dryRun === true;
    const force = options.force === true;
    const confirm =
      options.confirm ?? ((async () => false) as RepairOptions['confirm']);

    const report: TempCleanupReport = {
      scanned: 0,
      removed: [],
      promoted: [],
      preserved: [],
      errors: [],
    };

    const requestsDir = path.join(repoPath, '.autonomous-dev', 'requests');
    if (!fs.existsSync(requestsDir)) return report;

    // Collect all candidate temps first so we can prompt once for the whole batch.
    const candidates = this.collectTempFiles(requestsDir);
    report.scanned = candidates.length;
    if (candidates.length === 0) return report;

    if (!force && !dryRun) {
      const yes = await confirm(
        `Remove/promote ${candidates.length} orphaned temp file(s)?`,
      );
      if (!yes) {
        // Treat all as preserved when the operator declines.
        for (const candidate of candidates) {
          report.preserved.push(candidate.path);
        }
        return report;
      }
    }

    const now = this.clock();
    for (const candidate of candidates) {
      const ageMs = now - candidate.mtimeMs;
      if (ageMs < this.tempAgeMs) {
        this.logger.info('reconcile.temp_cleanup.preserve', {
          path: candidate.path,
          pid: candidate.pid,
          age_ms: ageMs,
          reason: 'recent',
        });
        report.preserved.push(candidate.path);
        continue;
      }
      if (candidate.pid !== null && this.isPidAlive(candidate.pid)) {
        this.logger.info('reconcile.temp_cleanup.preserve', {
          path: candidate.path,
          pid: candidate.pid,
          age_ms: ageMs,
          reason: 'pid_alive',
        });
        report.preserved.push(candidate.path);
        continue;
      }

      if (candidate.path.endsWith(NEEDS_PROMOTION_SUFFIX)) {
        await this.handleNeedsPromotion(
          candidate,
          repoPath,
          dryRun,
          ageMs,
          report,
        );
      } else {
        await this.handleOrphanTemp(candidate, dryRun, ageMs, report);
      }
    }

    return report;
  }

  /**
   * Promote `*.needs_promotion` → `state.json` if schema-valid, else archive.
   */
  private async handleNeedsPromotion(
    candidate: TempCandidate,
    repoPath: string,
    dryRun: boolean,
    ageMs: number,
    report: TempCleanupReport,
  ): Promise<void> {
    let parsed: Record<string, unknown>;
    try {
      const raw = fs.readFileSync(candidate.path, 'utf-8');
      const parsedRaw: unknown = JSON.parse(raw);
      if (
        parsedRaw === null
        || typeof parsedRaw !== 'object'
        || Array.isArray(parsedRaw)
      ) {
        throw new Error('not a JSON object');
      }
      parsed = parsedRaw as Record<string, unknown>;
    } catch (err) {
      // Schema-invalid → archive (never throw, never promote).
      const msg = err instanceof Error ? err.message : String(err);
      if (!dryRun) {
        try {
          this.archiveFile(candidate.path, repoPath);
        } catch (archiveErr) {
          report.errors.push({
            path: candidate.path,
            message:
              `archive failed: ${
                archiveErr instanceof Error ? archiveErr.message : String(archiveErr)
              }`,
          });
          return;
        }
      }
      this.logger.warn('reconcile.temp_cleanup.archive', {
        path: candidate.path,
        pid: candidate.pid,
        age_ms: ageMs,
        reason: msg,
      });
      report.errors.push({
        path: candidate.path,
        message: `unparseable .needs_promotion: ${msg}`,
      });
      return;
    }

    const validation = this.validateStateSchema(parsed);
    if (!validation.valid) {
      if (!dryRun) {
        try {
          this.archiveFile(candidate.path, repoPath);
        } catch (archiveErr) {
          report.errors.push({
            path: candidate.path,
            message:
              `archive failed: ${
                archiveErr instanceof Error ? archiveErr.message : String(archiveErr)
              }`,
          });
          return;
        }
      }
      this.logger.warn('reconcile.temp_cleanup.archive', {
        path: candidate.path,
        pid: candidate.pid,
        age_ms: ageMs,
        errors: validation.errors,
      });
      report.errors.push({
        path: candidate.path,
        message: `schema invalid: ${validation.errors.join('; ')}`,
      });
      return;
    }

    const target = path.join(path.dirname(candidate.path), 'state.json');
    if (!dryRun) {
      try {
        fs.renameSync(candidate.path, target);
      } catch (err) {
        report.errors.push({
          path: candidate.path,
          message: `promote failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
    }
    this.logger.info('reconcile.temp_cleanup.promote', {
      path: candidate.path,
      pid: candidate.pid,
      age_ms: ageMs,
      target,
    });
    report.promoted.push(candidate.path);
  }

  /**
   * Plain `state.json.tmp.*` (no `.needs_promotion` suffix): unlink.
   */
  private async handleOrphanTemp(
    candidate: TempCandidate,
    dryRun: boolean,
    ageMs: number,
    report: TempCleanupReport,
  ): Promise<void> {
    if (!dryRun) {
      try {
        fs.unlinkSync(candidate.path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === 'ENOENT') {
          // Raced removal — treat as success.
        } else {
          report.errors.push({
            path: candidate.path,
            message: err instanceof Error ? err.message : String(err),
          });
          return;
        }
      }
    }
    this.logger.info('reconcile.temp_cleanup.remove', {
      path: candidate.path,
      pid: candidate.pid,
      age_ms: ageMs,
    });
    report.removed.push(candidate.path);
  }

  /**
   * Walk every `REQ-NNNNNN` dir under `requestsDir` and collect every entry
   * matching `state.json.tmp.*`. Includes both plain temps and
   * `.needs_promotion` markers.
   */
  private collectTempFiles(requestsDir: string): TempCandidate[] {
    const out: TempCandidate[] = [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(requestsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!REQUEST_DIR_REGEX.test(entry.name)) continue;
      const reqDir = path.join(requestsDir, entry.name);
      let files: string[];
      try {
        files = fs.readdirSync(reqDir);
      } catch {
        continue;
      }
      for (const file of files) {
        if (!file.startsWith('state.json.tmp.')) continue;
        const full = path.join(reqDir, file);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        const m = TEMP_PID_REGEX.exec(file);
        const pid = m ? Number.parseInt(m[1], 10) : null;
        out.push({
          path: full,
          mtimeMs: stat.mtimeMs,
          pid: Number.isFinite(pid) ? (pid as number) : null,
        });
      }
    }
    out.sort((a, b) => a.path.localeCompare(b.path));
    return out;
  }

  /**
   * `process.kill(pid, 0)` returns successfully when the PID exists. ESRCH
   * means the process is gone; EPERM means it exists but we can't signal it.
   * For our purposes, EPERM still means alive — preserve.
   */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      return code === 'EPERM';
    }
  }

  // -------------------------------------------------------------------------
  // runFullReconciliation (SPEC-012-3-03)
  // -------------------------------------------------------------------------

  /**
   * Compose detect → repair → cleanup according to the supplied options.
   *
   * The CLI (`autonomous-dev request reconcile`) is the primary consumer.
   * Detection always runs (it's a precondition for repair). When
   * `repair` is enabled, every divergence found by detect is fed through
   * `repair()`. When `cleanupTemps` is enabled, cleanup runs AFTER repair
   * so any temps created by repair failures are also cleaned.
   *
   * @returns a structured envelope that the CLI serializes to JSON.
   */
  async runFullReconciliation(
    options: FullReconciliationOptions,
  ): Promise<FullReconciliationResult> {
    const repoPath = options.repoPath;
    const dryRun = options.dryRun === true;
    const force = options.force === true;
    const confirm = options.confirm;

    const reports = await this.detectDivergence(repoPath);

    let repairResults: RepairResult[] | undefined;
    if (options.repair) {
      repairResults = [];
      for (const report of reports) {
        const result = await this.repair(report, { dryRun, force, confirm });
        repairResults.push(result);
      }
    }

    let cleanup: TempCleanupReport | undefined;
    if (options.cleanupTemps) {
      cleanup = await this.cleanupOrphanedTemps(repoPath, {
        dryRun,
        force,
        confirm,
      });
    }

    return {
      reports,
      repairs: repairResults,
      cleanup,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers — repair / cleanup support
  // -------------------------------------------------------------------------

  /**
   * Compute SHA-256 hex of the JSON-serialized state.
   */
  private hashState(state: Record<string, unknown>): string {
    return crypto
      .createHash('sha256')
      .update(JSON.stringify(state))
      .digest('hex');
  }

  /**
   * SHA-256 hex of the on-disk state.json contents, or `undefined` when the
   * file is missing/unreadable. Used to populate `before_hash` in
   * {@link RepairResult}.
   */
  private async maybeHashStateFile(
    report: DivergenceReport,
  ): Promise<string | undefined> {
    const statePath = path.join(
      this.requestDir(report.repository, report.request_id),
      'state.json',
    );
    try {
      const raw = fs.readFileSync(statePath);
      return crypto.createHash('sha256').update(raw).digest('hex');
    } catch {
      return undefined;
    }
  }

  /**
   * Move `srcPath` under `<repo>/.autonomous-dev/archive/orphans/`. Returns
   * the absolute destination path.
   *
   * Naming: `{timestamp}-{request_id}-state.json` (or `-needs_promotion.json`
   * when the basename ends in `.needs_promotion`). Operators can browse the
   * archive directory directly for post-mortem analysis.
   */
  private archiveFile(srcPath: string, repoPath: string): string {
    const archiveDir = path.join(
      repoPath,
      '.autonomous-dev',
      'archive',
      'orphans',
    );
    fs.mkdirSync(archiveDir, { recursive: true, mode: 0o700 });
    const ts = this.nowIso().replace(/[:.]/g, '-');
    const reqIdMatch = STATE_PATH_REGEX.exec(srcPath);
    const reqId = reqIdMatch ? reqIdMatch[1] : 'UNKNOWN';
    const suffix = srcPath.endsWith(NEEDS_PROMOTION_SUFFIX)
      ? 'needs_promotion.json'
      : 'state.json';
    const target = path.join(archiveDir, `${ts}-${reqId}-${suffix}`);
    fs.renameSync(srcPath, target);
    return target;
  }

  /**
   * Lightweight schema check for `state.json`-shaped data. Mirrors the
   * minimum field set the daemon's reader expects, without pulling in a
   * full JSON-Schema dependency.
   *
   * Returns `{ valid: false, errors }` rather than throwing so callers can
   * archive instead of crash.
   */
  private validateStateSchema(data: unknown): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { valid: false, errors: ['state.json must be a JSON object'] };
    }
    const obj = data as Record<string, unknown>;
    const required = ['request_id', 'status', 'priority', 'repository'];
    for (const field of required) {
      if (!(field in obj)) errors.push(`missing required field: ${field}`);
    }
    if (
      'request_id' in obj
      && typeof obj.request_id === 'string'
      && !/^REQ-\d{6}$/.test(obj.request_id as string)
    ) {
      errors.push(`request_id format invalid: ${String(obj.request_id)}`);
    }
    if (
      'source' in obj
      && obj.source !== undefined
      && obj.source !== null
      && !isRequestSource(obj.source)
    ) {
      errors.push(`unknown source: ${String(obj.source)}`);
    }
    return { valid: errors.length === 0, errors };
  }

  /**
   * Translate a state.json field name to its SQLite column name for
   * `repairContentMismatch`. Returns `null` for fields that are not part
   * of the canonical comparison set (e.g. internal-only fields).
   */
  private mapStateFieldToSqliteField(stateField: string): string | null {
    for (const { sqliteField, stateField: sf } of COMPARISON_FIELDS) {
      if (sf === stateField) return String(sqliteField);
    }
    return null;
  }

  /**
   * Build the canonical {@link StateJsonV11} payload from a SQLite row.
   *
   * Mirrors {@link buildInitialState} from `state_artifact.ts`, but seeds
   * `phase_history` / running counters from sensible defaults — operator
   * repair never restores lost history; that requires a manual import.
   */
  private buildStateFromSqlite(req: Partial<RequestEntity>): StateJsonV11 {
    return {
      schema_version: 1,
      request_id: req.request_id as string,
      status: (req.status as string) ?? 'queued',
      priority: (req.priority as string) ?? 'normal',
      description: (req.description as string) ?? '',
      repository: (req.target_repo as string) ?? '',
      source: (req.source as RequestSource) ?? 'cli',
      adapter_metadata: (req.adapter_metadata as AdapterMetadata) ?? {},
      created_at: (req.created_at as string) ?? this.nowIso(),
      updated_at: (req.updated_at as string) ?? this.nowIso(),
      phase_history: [],
      current_phase_metadata: {},
      cost_accrued_usd: 0,
      turn_count: 0,
      escalation_count: 0,
      blocked_by: [],
      error: null,
      last_checkpoint: null,
    } as StateJsonV11;
  }

  /**
   * Inverse mapper: build a {@link RequestEntity} from a parsed `state.json`.
   * Used by {@link repairOrphanedFile} to import an orphan into SQLite.
   *
   * Fills v1-only columns (`title`, `requester_id`, etc.) with sensible
   * defaults so the row passes CHECK constraints.
   */
  private buildSqliteFromState(
    state: Record<string, unknown>,
    requestId: string,
    repoPath: string,
  ): RequestEntity {
    const description = (state.description as string) ?? '';
    const sourceVal = state.source;
    const source: RequestSource = isRequestSource(sourceVal)
      ? sourceVal
      : 'cli';
    const sourceChannel: ChannelType = (() => {
      switch (source) {
        case 'discord':
          return 'discord';
        case 'slack':
          return 'slack';
        default:
          return 'claude_app';
      }
    })();
    const created =
      (state.created_at as string) ?? (state.updated_at as string) ?? this.nowIso();
    const updated = (state.updated_at as string) ?? created;

    return {
      request_id: requestId,
      title: description.slice(0, 80),
      description,
      raw_input: description,
      priority: ((state.priority as Priority) ?? 'normal') as Priority,
      target_repo: (state.repository as string) ?? repoPath,
      status: ((state.status as RequestStatus) ?? 'queued') as RequestStatus,
      current_phase: 'queued',
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
      paused_at_phase: null,
      source,
      adapter_metadata:
        (state.adapter_metadata as AdapterMetadata) ?? ({} as AdapterMetadata),
      created_at: created,
      updated_at: updated,
    };
  }

  /** Compute the request directory path. */
  private requestDir(repoPath: string, requestId: string): string {
    return path.join(repoPath, '.autonomous-dev', 'requests', requestId);
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
