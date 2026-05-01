/**
 * Startup recovery orchestrator (SPEC-012-1-04 §"Recovery Runner").
 *
 * Runs at daemon startup BEFORE the read loop begins polling. Phases run in
 * a strict order — each must complete before the next starts:
 *
 *   1. Promotion phase — scan every `*.needs_promotion` file under the
 *      repo's request directories and promote (rename to `state.json`),
 *      quarantine, or skip per `promoteNeedsPromotion`.
 *
 *   2. Cleanup phase   — scan every `state.json.tmp.*` and `state.json` for
 *      orphans (PID dead or mtime > 60 s) and unparseable state files.
 *      Orphans are unlinked; corrupt state.json is renamed to
 *      `state.json.corrupt-<ts>`.
 *
 *   3. Replay phase    — walk SQLite + the FS snapshot left by the prior
 *      phases and reconcile drift (status/priority mismatches → prefer
 *      state.json; SQLite-only → mark `orphaned_lost`; FS-only → INSERT
 *      from state.json).
 *
 * The runner returns a {@link RecoveryReport} that the daemon's startup
 * code logs and exposes via metrics. If any phase throws, the runner
 * surfaces it via the report's `errors` field but DOES NOT throw — the
 * daemon decides whether to abort based on policy.
 *
 * Per-spec note: phase order matters. Promotion first → creates the
 * `state.json` files that replay then reconciles to SQLite. Reversing
 * would cause replay to incorrectly mark `orphaned_lost` rows that
 * promotion would later resolve.
 *
 * @module recovery/recovery_runner
 */

import * as fs from 'fs';
import * as path from 'path';

import { Repository } from '../db/repository';

import {
  type JournalDb,
  type JournalReplayReport,
  replayJournal,
  wrapRepository,
} from './journal_replay';
import {
  NEEDS_PROMOTION_SUFFIX,
  promoteNeedsPromotion,
} from './promotion';
import {
  type CleanupReport,
  cleanupOrphanedTemps,
} from './temp_cleanup';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecoveryReport {
  promotedCount: number;
  orphanedCleaned: number;
  corruptQuarantined: number;
  journalReplayed: number;
  /** Per-recoverable error encountered. The runner never throws; everything
      lands here for the operator to triage. */
  errors: Array<{ requestId?: string; phase: string; error: string }>;
  durationMs: number;
}

/**
 * Optional configuration for {@link runStartupRecovery}.
 *
 * `db` accepts either a `Repository` (production) or any object satisfying
 * the {@link JournalDb} interface (tests / in-memory mocks). When omitted,
 * the journal-replay phase is skipped and a single error entry is recorded
 * — the daemon should always supply a DB at startup; the omission path
 * exists to support recovery-only callers that want to scrub the FS without
 * touching SQLite.
 */
export interface RecoveryOptions {
  db?: Repository | JournalDb;
  /** Override for `Date.now()` — used by deterministic chaos tests. */
  nowMs?: number;
}

// ---------------------------------------------------------------------------
// runStartupRecovery
// ---------------------------------------------------------------------------

/**
 * Run all three recovery phases in order against `repo`. Returns a
 * {@link RecoveryReport} with phase counts + structured error list.
 *
 * The report's counts:
 *   - `promotedCount`     — # of `*.needs_promotion` markers that became
 *                          a final `state.json` (excludes idempotent no-ops
 *                          where `state.json` was already in place).
 *   - `orphanedCleaned`   — # of orphan temps unlinked.
 *   - `corruptQuarantined`— # of files renamed to `*.corrupt-<ts>` (sum
 *                          across promotion + cleanup phases).
 *   - `journalReplayed`   — # of SQLite rows touched by replay.
 *
 * Production callers MUST await this before starting the daemon's read
 * loop. Tests typically call this in a temp dir + assert FS / SQLite shape.
 */
export async function runStartupRecovery(
  repo: string,
  opts?: RecoveryOptions,
): Promise<RecoveryReport> {
  const start = Date.now();
  const report: RecoveryReport = {
    promotedCount: 0,
    orphanedCleaned: 0,
    corruptQuarantined: 0,
    journalReplayed: 0,
    errors: [],
    durationMs: 0,
  };

  // ---- Phase 1: promotion ----
  try {
    await runPromotionPhase(repo, report);
  } catch (err) {
    report.errors.push({
      phase: 'promotion',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- Phase 2: cleanup ----
  try {
    const cleanup: CleanupReport = await cleanupOrphanedTemps(repo, {
      nowMs: opts?.nowMs,
    });
    report.orphanedCleaned += cleanup.cleaned;
    report.corruptQuarantined += cleanup.quarantined;
    for (const e of cleanup.errors) {
      report.errors.push({ phase: 'cleanup', error: `${e.path}: ${e.error}` });
    }
  } catch (err) {
    report.errors.push({
      phase: 'cleanup',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ---- Phase 3: replay ----
  if (opts?.db !== undefined) {
    try {
      const db: JournalDb =
        opts.db instanceof Repository ? wrapRepository(opts.db) : opts.db;
      const replay: JournalReplayReport = await replayJournal(repo, db);
      report.journalReplayed += replay.replayed;
      for (const m of replay.mismatches) {
        report.errors.push({
          requestId: m.requestId,
          phase: `replay.${m.type}`,
          error: m.details ?? '(no details)',
        });
      }
    } catch (err) {
      report.errors.push({
        phase: 'replay',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } else {
    report.errors.push({
      phase: 'replay',
      error: 'no DB supplied; replay phase skipped',
    });
  }

  // ---- Report ----
  report.durationMs = Date.now() - start;

  // Operator-visible structured log; mirrors the migration runner's style.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      event: 'recovery.complete',
      ...report,
    }),
  );

  return report;
}

// ---------------------------------------------------------------------------
// Phase 1 — promotion
// ---------------------------------------------------------------------------

/**
 * Scan every request directory under `<repo>/.autonomous-dev/requests/` and
 * promote any `*.needs_promotion` files found. Updates `report.promotedCount`
 * (real renames only) and `report.corruptQuarantined` (schema-invalid +
 * conflicts). Errors land in `report.errors`.
 */
async function runPromotionPhase(
  repo: string,
  report: RecoveryReport,
): Promise<void> {
  const requestsDir = path.join(repo, '.autonomous-dev', 'requests');
  if (!fs.existsSync(requestsDir)) return;

  let entries: string[];
  try {
    entries = fs.readdirSync(requestsDir);
  } catch (err) {
    report.errors.push({
      phase: 'promotion.scan',
      error: `${requestsDir}: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  for (const entry of entries) {
    const reqDir = path.join(requestsDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(reqDir);
    } catch {
      continue; // raced removal
    }
    if (!stat.isDirectory()) continue;

    let files: string[];
    try {
      files = fs.readdirSync(reqDir);
    } catch (err) {
      report.errors.push({
        requestId: entry,
        phase: 'promotion.readdir',
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    for (const file of files) {
      if (!file.endsWith(NEEDS_PROMOTION_SUFFIX)) continue;
      const full = path.join(reqDir, file);

      const result = await promoteNeedsPromotion(full);
      if (result.ok) {
        if (result.promoted) {
          report.promotedCount += 1;
        }
        // result.promoted === false ⇒ idempotent no-op; not counted.
        continue;
      }

      // Failure paths.
      if (result.reason === 'SCHEMA_INVALID' || result.reason === 'CONFLICT') {
        report.corruptQuarantined += 1;
      }
      report.errors.push({
        requestId: entry,
        phase: `promotion.${result.reason}`,
        error: result.details ?? '(no details)',
      });
    }
  }
}
