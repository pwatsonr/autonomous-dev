/**
 * Reconciliation type contracts (PLAN-012-3).
 *
 * Defines the inputs and outputs of {@link ReconciliationManager}:
 *   - {@link DivergenceReport} / {@link DivergenceCategory} — read-only output
 *     from `detectDivergence()` (SPEC-012-3-01).
 *   - {@link RepairResult} / {@link RepairOptions} / {@link RepairAction} — the
 *     contract for `repair()` (SPEC-012-3-02).
 *   - {@link TempCleanupReport} — output of `cleanupOrphanedTemps()`
 *     (SPEC-012-3-02).
 *   - {@link ReconcileOptions} — top-level options shared by detect and repair.
 *
 * Conventions:
 *   - `detected_at` and similar timestamps are ISO-8601 strings (UTC, with
 *     trailing `Z`) for ergonomic JSON serialization.
 *   - `*_mtime_ms` and `*_updated_at` are epoch milliseconds — the form
 *     produced by `fs.Stats.mtimeMs` and used by the SQLite repository.
 *   - All shapes are JSON-serializable (no `Date` instances on the wire).
 *
 * @module core/types/reconciliation
 */

import type { RequestEntity } from '../../db/repository';

// ---------------------------------------------------------------------------
// Divergence (SPEC-012-3-01)
// ---------------------------------------------------------------------------

/**
 * The four kinds of drift observed between SQLite and the per-request
 * `state.json` files. Exactly one category per {@link DivergenceReport}.
 *
 *  - `missing_file`     — SQLite has the request row but no `state.json`
 *                         exists on disk.
 *  - `stale_file`       — Both exist, but `state.json` mtime is older than
 *                         SQLite's `updated_at` (beyond the 1s tolerance).
 *  - `content_mismatch` — Both exist with comparable mtimes, but one or
 *                         more canonical fields differ between sources.
 *  - `orphaned_file`    — `state.json` exists with no SQLite row backing it.
 */
export type DivergenceCategory =
  | 'missing_file'
  | 'stale_file'
  | 'content_mismatch'
  | 'orphaned_file';

/**
 * A single drift event detected by {@link ReconciliationManager.detectDivergence}.
 *
 * Field population varies by `category`:
 *   - `missing_file`     → `sqlite_state`, `sqlite_updated_at` populated.
 *   - `stale_file`       → `sqlite_updated_at`, `filesystem_mtime_ms`,
 *                          `sqlite_state` populated.
 *   - `content_mismatch` → `fields_differing` populated (non-empty);
 *                          `sqlite_state`, `filesystem_state`,
 *                          `sqlite_updated_at`, `filesystem_mtime_ms` set.
 *   - `orphaned_file`    → `filesystem_state` populated (or `null` for
 *                          unparseable JSON); `filesystem_mtime_ms` set.
 */
export interface DivergenceReport {
  request_id: string;
  /** Realpath-resolved repository root containing `.autonomous-dev/`. */
  repository: string;
  category: DivergenceCategory;
  /** Human-readable summary; safe for logs and operator-facing output. */
  description: string;
  sqlite_state?: Partial<RequestEntity>;
  /** Parsed JSON object from `state.json`, or `null` if unparseable. */
  filesystem_state?: unknown;
  /** Epoch ms — populated when SQLite row is involved. */
  sqlite_updated_at?: number;
  /** Epoch ms — populated when state.json was stat()ed. */
  filesystem_mtime_ms?: number;
  /** Field names that differ; populated for `content_mismatch` only. */
  fields_differing?: string[];
  /** ISO-8601 UTC timestamp captured at detection time. */
  detected_at: string;
}

/**
 * Top-level options shared by detect, repair, and cleanup phases.
 *
 * `dryRun`, `force`, and `outputJson` are consumed by the repair / CLI layers
 * (SPEC-012-3-02 / -03); detect only uses `repo`. They are listed here so a
 * single options object can carry through the full reconciliation pipeline.
 */
export interface ReconcileOptions {
  /** Realpath-resolved repository root. When omitted, scan all configured. */
  repo?: string;
  /** Repair: log/report only, no mutations. */
  dryRun?: boolean;
  /** Repair: skip confirmation prompts. */
  force?: boolean;
  /** CLI: emit machine-readable report to this path. */
  outputJson?: string;
}

// ---------------------------------------------------------------------------
// Repair (SPEC-012-3-02)
// ---------------------------------------------------------------------------

/**
 * Outcome of a single {@link ReconciliationManager.repair} call.
 *
 *  - `auto_repaired`    — drift resolved without operator input.
 *  - `manual_required`  — drift requires operator review (e.g. orphan
 *                         archived; conflict needs investigation).
 *  - `skipped`          — interactive confirm declined, OR dry-run.
 */
export type RepairAction =
  | 'auto_repaired'
  | 'manual_required'
  | 'skipped';

/**
 * Per-call options for {@link ReconciliationManager.repair} and
 * {@link ReconciliationManager.cleanupOrphanedTemps}.
 *
 * `confirm` is the interactive-prompt callback; the CLI layer wires this to
 * a TTY prompt when stdin is interactive, and to a no-op (always-false)
 * function in non-interactive mode without `force`.
 */
export interface RepairOptions {
  /** Skip prompts; auto-approve destructive actions. */
  force?: boolean;
  /** Interactive prompt fn. Receives a description; returns operator choice. */
  confirm?: (msg: string) => Promise<boolean>;
  /** Log intended actions but do not mutate disk or DB. */
  dryRun?: boolean;
}

/**
 * Result of a single {@link ReconciliationManager.repair} call.
 *
 * Hashes are SHA-256 hex digests of the JSON-serialized state file (when
 * applicable). Operators can compare `before_hash`/`after_hash` to confirm
 * a write actually changed the on-disk content.
 */
export interface RepairResult {
  request_id: string;
  category: DivergenceCategory;
  action: RepairAction;
  /** SHA-256 hex of pre-repair state.json contents (when present). */
  before_hash?: string;
  /** SHA-256 hex of post-repair state.json contents (when written). */
  after_hash?: string;
  /** Populated on `manual_required` or repair failure. */
  error_message?: string;
  /** Set when an orphan was archived rather than imported. */
  archived_path?: string;
}

// ---------------------------------------------------------------------------
// Temp cleanup (SPEC-012-3-02)
// ---------------------------------------------------------------------------

/**
 * Aggregate outcome of {@link ReconciliationManager.cleanupOrphanedTemps}.
 *
 * Counts and per-file paths are accumulated across the whole repo scan so
 * the CLI can render a single summary block.
 */
export interface TempCleanupReport {
  /** Number of `state.json.tmp.*` candidates inspected. */
  scanned: number;
  /** Absolute paths of removed temp files. */
  removed: string[];
  /** Absolute paths of `*.needs_promotion` files renamed to `state.json`. */
  promoted: string[];
  /**
   * Absolute paths of temp files NOT removed because they appear active
   * (recent mtime OR live PID). Operators can use this to debug when a
   * cleanup run leaves files behind.
   */
  preserved: string[];
  /** Per-file errors (best-effort; cleanup never throws to the caller). */
  errors: Array<{ path: string; message: string }>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link ReconciliationManager.detectDivergence} when the per-repo
 * advisory lock (`<repo>/.autonomous-dev/.reconcile.lock`) cannot be
 * acquired — typically because another reconcile is already in progress.
 *
 * Callers should treat this as transient and either retry or surface to
 * the operator. The CLI maps this to exit code 2.
 */
export class ReconcileBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconcileBusyError';
  }
}
