/**
 * `autonomous-dev reconcile` — TypeScript orchestrator.
 *
 * Spec coverage: SPEC-012-3-03 (CLI + audit log).
 *
 * The bash dispatcher (`bin/autonomous-dev.sh`) performs argument validation
 * and delegates here via `node`. This module:
 *   1. Parses flags via `commander` (already a dep — same pattern as
 *      `intake/adapters/cli_adapter.ts`).
 *   2. Constructs a `ReconciliationManager` with sensible defaults: the
 *      sqlite path comes from `AUTONOMOUS_DEV_DB` env var (falling back to
 *      `~/.autonomous-dev/intake.sqlite3`).
 *   3. Calls {@link ReconciliationManager.runFullReconciliation}.
 *   4. Emits a structured JSON audit log of the run to stdout (or to the
 *      `--out` path).
 *
 * Reconcile is a maintenance op, NOT a request submission — it deliberately
 * bypasses authz/rate-limit (those are request-flow concerns).
 *
 * Exit codes:
 *   - `0` — no drift detected; or, when `--auto-repair` is set, all repairs
 *           succeeded.
 *   - `1` — drift exists in dry-run / detect-only mode (signal for cron).
 *   - `2` — system error (DB open failure, IO error, lock contention, etc.).
 *
 * @module cli/reconcile_command
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  Command,
  CommanderError,
  InvalidArgumentError,
} from 'commander';

import type { Logger } from '../authz/audit_logger';
import type {
  DivergenceReport,
  RepairResult,
  TempCleanupReport,
} from '../core/types/reconciliation';
import { ReconcileBusyError } from '../core/types/reconciliation';
import type {
  FullReconciliationOptions,
  FullReconciliationResult,
} from '../core/reconciliation_manager';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Parsed CLI flags for `autonomous-dev reconcile`.
 *
 * Field naming mirrors the bash flag names verbatim (kebab → camel) so
 * trace logs and JSON output line up with what the operator typed.
 */
export interface ReconcileCliFlags {
  /** Realpath-resolved repository root. Required (validated by bash layer). */
  repo: string;
  /** When true, no SQLite or filesystem mutations occur. */
  dryRun: boolean;
  /** When true, repair() is invoked for each detected divergence. */
  autoRepair: boolean;
  /** When true, cleanupOrphanedTemps() runs after detect (and after repair). */
  cleanupTemps: boolean;
  /** Output path for the JSON audit log; absent → stdout. */
  out?: string;
}

/**
 * Minimal contract consumed by {@link runReconcileCommand}. Mirrors
 * {@link IntakeRouterLike} in `cli_adapter.ts` so unit tests can inject a
 * fake without touching SQLite or the filesystem.
 *
 * Note: This is the SAME shape as the public API of
 * {@link ReconciliationManager}, narrowed to what the CLI actually needs.
 */
export interface ReconciliationManagerLike {
  runFullReconciliation(
    options: FullReconciliationOptions,
  ): Promise<FullReconciliationResult>;
}

/**
 * Dependencies injected into {@link runReconcileCommand}.
 *
 * `manager` is the only required dep; tests pass a fake. `stdout`/`stderr`/
 * `logger` default to the real process streams / structured-JSON logger.
 *
 * `now` is injectable for deterministic timestamps in audit log entries.
 */
export interface ReconcileDeps {
  manager: ReconciliationManagerLike;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  logger?: Logger;
  /** Returns the current UTC timestamp; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Returns the current epoch ms; defaults to `Date.now`. */
  monotonic?: () => number;
}

/**
 * Structured envelope serialized to stdout (or `--out`) at the end of a run.
 * Shape is intentionally additive: consumers can parse a subset without
 * caring about future fields. Backward-compat is preserved across versions.
 */
export interface ReconcileAuditLog {
  event: 'reconcile.run';
  /** ISO-8601 UTC timestamp of when the run started. */
  timestamp: string;
  /** Username from `os.userInfo().username`. */
  actor: string;
  /** Realpath-resolved repository scanned by this invocation. */
  repository: string;
  /** Echo of the parsed CLI flags. */
  flags: {
    dryRun: boolean;
    autoRepair: boolean;
    cleanupTemps: boolean;
  };
  /** Total divergences detected. */
  inconsistencies_found: number;
  /** Number of repair() calls attempted (only when --auto-repair). */
  repairs_attempted: number;
  /** Subset of repairs_attempted that returned action='auto_repaired'. */
  repairs_successful: number;
  /** Number of repairs that returned action='manual_required'. */
  manual_intervention_needed: number;
  /** Cleanup metrics; populated only when --cleanup-temps. */
  cleanup?: {
    scanned: number;
    removed: number;
    promoted: number;
    preserved: number;
    errors: number;
  };
  /** Final exit code emitted by this invocation. */
  exit_code: number;
  /** Wall-clock duration of the reconcile, in milliseconds. */
  duration_ms: number;
  /** Per-divergence detail (lossless echo of detect/repair output). */
  detail: {
    reports: DivergenceReport[];
    repairs?: RepairResult[];
    cleanup?: TempCleanupReport;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Default sqlite path used when `AUTONOMOUS_DEV_DB` is unset.
 *
 * Note: This intentionally differs from the cli_adapter default
 * (`intake.db`); the spec for SPEC-012-3-03 calls out `intake.sqlite3` as
 * the canonical reconcile DB filename. Production deployments override
 * via env var when the path differs.
 */
export function defaultDbPath(): string {
  return path.join(
    process.env.HOME ?? os.homedir(),
    '.autonomous-dev',
    'intake.sqlite3',
  );
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/**
 * Build the `commander` program for the `reconcile` subcommand.
 *
 * Exposed for tests so they can call `parseAsync` directly without going
 * through {@link runReconcileCommand}'s exec/exit semantics.
 */
export function buildReconcileProgram(
  onParsed: (flags: ReconcileCliFlags) => Promise<void>,
): Command {
  const program = new Command();

  program
    .name('autonomous-dev reconcile')
    .description(
      'Detect (and optionally repair) drift between the intake-router '
        + 'SQLite store and per-request state.json files.',
    )
    .exitOverride()
    .requiredOption('--repo <path>', 'Realpath-resolved repository root')
    .option('--dry-run', 'Report only; no mutations', false)
    .option('--auto-repair', 'Apply repair strategies for detected divergence', false)
    .option('--cleanup-temps', 'Remove orphaned state.json.tmp.* files after detect/repair', false)
    .option('--out <path>', 'Write JSON audit log to <path> (default: stdout)')
    .action(async (opts: Record<string, unknown>) => {
      const flags: ReconcileCliFlags = {
        repo: String(opts.repo),
        dryRun: opts.dryRun === true,
        autoRepair: opts.autoRepair === true,
        cleanupTemps: opts.cleanupTemps === true,
        out: typeof opts.out === 'string' ? opts.out : undefined,
      };
      await onParsed(flags);
    });

  return program;
}

// ---------------------------------------------------------------------------
// Audit log construction
// ---------------------------------------------------------------------------

/**
 * Build the final {@link ReconcileAuditLog} payload from a completed run.
 *
 * Exit code semantics (mirror the module header):
 *   - 0 : no inconsistencies (or all auto-repaired with zero manual-required).
 *   - 1 : drift detected in dry-run / detect-only mode.
 *   - 2 : at least one repair returned manual_required, or hard error.
 */
export function buildAuditLog(args: {
  flags: ReconcileCliFlags;
  result: FullReconciliationResult;
  startedAt: Date;
  durationMs: number;
  exitCode: number;
}): ReconcileAuditLog {
  const reports = args.result.reports ?? [];
  const repairs = args.result.repairs ?? [];
  const cleanup = args.result.cleanup;

  const repairsSuccessful = repairs.filter(
    (r) => r.action === 'auto_repaired',
  ).length;
  const manualNeeded = repairs.filter(
    (r) => r.action === 'manual_required',
  ).length;

  const audit: ReconcileAuditLog = {
    event: 'reconcile.run',
    timestamp: args.startedAt.toISOString(),
    actor: os.userInfo().username,
    repository: args.flags.repo,
    flags: {
      dryRun: args.flags.dryRun,
      autoRepair: args.flags.autoRepair,
      cleanupTemps: args.flags.cleanupTemps,
    },
    inconsistencies_found: reports.length,
    repairs_attempted: repairs.length,
    repairs_successful: repairsSuccessful,
    manual_intervention_needed: manualNeeded,
    exit_code: args.exitCode,
    duration_ms: args.durationMs,
    detail: {
      reports,
      repairs: args.result.repairs,
      cleanup,
    },
  };

  if (cleanup !== undefined) {
    audit.cleanup = {
      scanned: cleanup.scanned,
      removed: cleanup.removed.length,
      promoted: cleanup.promoted.length,
      preserved: cleanup.preserved.length,
      errors: cleanup.errors.length,
    };
  }

  return audit;
}

/**
 * Compute the final exit code from a completed reconcile run.
 *
 * Pure function — separated so tests can pin down the policy without
 * threading the whole {@link runReconcileCommand} state.
 */
export function computeExitCode(
  flags: ReconcileCliFlags,
  result: FullReconciliationResult,
): number {
  const reports = result.reports ?? [];
  const repairs = result.repairs ?? [];

  // A repair returning manual_required (or an error) is exit 2 — the
  // operator must intervene.
  const hardFail = repairs.some(
    (r) => r.action === 'manual_required' || r.error_message !== undefined,
  );
  if (hardFail) return 2;

  // No drift detected → exit 0 regardless of mode.
  if (reports.length === 0) return 0;

  // Drift detected.
  // - With --auto-repair AND every repair succeeded → exit 0 (clean).
  // - Otherwise (detect-only, dry-run with drift, or partial success) → 1.
  if (flags.autoRepair && repairs.length > 0) {
    const allSucceeded = repairs.every((r) => r.action === 'auto_repaired');
    return allSucceeded ? 0 : 1;
  }

  return 1;
}

// ---------------------------------------------------------------------------
// IO helpers
// ---------------------------------------------------------------------------

/**
 * Atomically write `payload` to `targetPath` via temp file + rename.
 *
 * Uses mode `0o600` (operator-readable only) to match the daemon's
 * convention for state files. The tempfile lives in the same directory as
 * the target so `rename()` stays on one filesystem.
 */
export function writeAuditFileAtomic(
  targetPath: string,
  payload: string,
): void {
  const dir = path.dirname(targetPath);
  // The bash validator already verified the parent dir exists & is writable;
  // we don't re-create it here — that would mask validation gaps.
  const tmp = path.join(
    dir,
    `.${path.basename(targetPath)}.tmp.${process.pid}`,
  );
  fs.writeFileSync(tmp, payload, { mode: 0o600 });
  fs.renameSync(tmp, targetPath);
}

// ---------------------------------------------------------------------------
// Main entrypoint
// ---------------------------------------------------------------------------

/**
 * Parse `argv`, run the full reconciliation, emit the audit log, and return
 * the exit code.
 *
 * Exposed for testing — production wires this into the bash dispatcher via
 * `node intake/cli/reconcile_command.js <argv>`.
 *
 * Failure modes mapped to exit codes:
 *   - `commander` argument errors    → 2
 *   - `ReconcileBusyError`           → 2
 *   - any other unexpected error     → 2
 */
export async function runReconcileCommand(
  argv: string[],
  deps: ReconcileDeps,
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? (() => new Date());
  const monotonic = deps.monotonic ?? Date.now;

  let parsedFlags: ReconcileCliFlags | null = null;
  let exitCode = 0;

  const program = buildReconcileProgram(async (flags) => {
    parsedFlags = flags;
  });

  try {
    // Commander expects argv with the node + script slots present.
    await program.parseAsync(['node', 'reconcile_command.js', ...argv]);
  } catch (err) {
    if (err instanceof CommanderError) {
      // commander already wrote help/error text — propagate its exit code
      // but normalize "user error" (1) to our system-error (2) since flag
      // validation lives in bash for production. Anything reaching here
      // is by definition a programmer/system fault.
      return err.exitCode === 0 ? 0 : 2;
    }
    if (err instanceof InvalidArgumentError) {
      stderr.write(`ERROR: ${err.message}\n`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`ERROR: ${msg}\n`);
    return 2;
  }

  if (parsedFlags === null) {
    // Should never happen — commander always invokes the action handler
    // when --help is not passed; bail with system-error code for safety.
    stderr.write('ERROR: reconcile flags not parsed\n');
    return 2;
  }

  const flags: ReconcileCliFlags = parsedFlags;
  const startedAt = now();
  const startMs = monotonic();

  let result: FullReconciliationResult;
  try {
    result = await deps.manager.runFullReconciliation({
      repoPath: flags.repo,
      repair: flags.autoRepair,
      cleanupTemps: flags.cleanupTemps,
      dryRun: flags.dryRun,
      // --auto-repair implies "do not prompt"; reconcile is meant for
      // unattended cron use. confirm=undefined → manager applies its
      // built-in default (always-false) which combined with force=true
      // greenlights destructive actions.
      force: flags.autoRepair,
    });
  } catch (err) {
    if (err instanceof ReconcileBusyError) {
      stderr.write(`ERROR: reconcile busy: ${err.message}\n`);
      return 2;
    }
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write(`ERROR: reconcile failed: ${msg}\n`);
    return 2;
  }

  exitCode = computeExitCode(flags, result);
  const durationMs = monotonic() - startMs;

  const audit = buildAuditLog({
    flags,
    result,
    startedAt,
    durationMs,
    exitCode,
  });

  const serialized = `${JSON.stringify(audit, null, 2)}\n`;
  if (flags.out !== undefined) {
    try {
      writeAuditFileAtomic(flags.out, serialized);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      stderr.write(`ERROR: failed to write audit log to ${flags.out}: ${msg}\n`);
      return 2;
    }
  } else {
    stdout.write(serialized);
  }

  // Mirror the audit summary into the structured logger when one was
  // injected (production wires this to the daemon log; tests typically
  // omit it). This keeps cron runs greppable in the daemon log even when
  // the operator redirected the JSON elsewhere via --out.
  if (deps.logger !== undefined) {
    deps.logger.info('reconcile.run', {
      repository: flags.repo,
      inconsistencies_found: audit.inconsistencies_found,
      repairs_attempted: audit.repairs_attempted,
      repairs_successful: audit.repairs_successful,
      manual_intervention_needed: audit.manual_intervention_needed,
      exit_code: exitCode,
      duration_ms: durationMs,
    });
  }

  return exitCode;
}

// ---------------------------------------------------------------------------
// Production entrypoint — lazy SQLite construction
// ---------------------------------------------------------------------------

/**
 * Construct the production {@link ReconciliationManagerLike}: opens the
 * SQLite database at `AUTONOMOUS_DEV_DB` (or the default), runs migrations,
 * and wires a `Repository` + structured logger into a real
 * `ReconciliationManager`.
 *
 * Mirrors the lazy-init pattern from `cli_adapter.ts:initRouter` so the
 * unit-test path never has to load `better-sqlite3` or run migrations.
 */
/* istanbul ignore next — exercised only by the production entry point */
export async function initManager(): Promise<ReconciliationManagerLike> {
  /* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
  const { Repository } = await import('../db/repository');
  const { initializeDatabase } = await import('../db/migrator');
  const { ReconciliationManager } = await import('../core/reconciliation_manager');
  const { defaultLogger } = await import('../authz/audit_logger');
  /* eslint-enable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */

  const dbPath = process.env.AUTONOMOUS_DEV_DB ?? defaultDbPath();
  const migrationsDir = path.resolve(__dirname, '..', 'db', 'migrations');
  const { db } = initializeDatabase(dbPath, migrationsDir);
  const repo = new Repository(db);
  return new ReconciliationManager(repo, defaultLogger);
}

// ---------------------------------------------------------------------------
// CLI invocation guard
// ---------------------------------------------------------------------------

/* istanbul ignore next — production main; tests call runReconcileCommand directly */
if (
  typeof require !== 'undefined'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  && require.main === (module as any)
) {
  (async () => {
    let manager: ReconciliationManagerLike;
    try {
      manager = await initManager();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`FATAL: failed to initialize reconcile manager: ${msg}\n`);
      process.exit(2);
    }
    const code = await runReconcileCommand(process.argv.slice(2), { manager });
    process.exit(code);
  })().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`FATAL: ${msg}\n`);
    process.exit(2);
  });
}
