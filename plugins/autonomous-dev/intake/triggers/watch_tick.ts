/**
 * ONBOARD Phase 4 (#596) — the periodic watch tick (orchestration).
 *
 * One tick does two things, best-effort:
 *   1. COMPLETION DETECTION — for each still-`enqueued` trigger, read its
 *      request outcome; a `done` request starts the stabilization watch + posts
 *      a terminal "done" to origin; a `failed` request posts "failed" + stops.
 *   2. WATCH ADVANCE — tick every active watch via `advanceWatches`.
 *
 * Every external dependency (the outcome reader = state.json, the watch branch
 * resolver = default branch, the CI checks client = gh, the clock, the audit
 * sink, the reporter notifier) is injected, so this orchestration is fully
 * unit-testable; the bin (`bin/triggers-cli.ts`) wires the real ones.
 *
 * @module intake/triggers/watch_tick
 */

import { reportTerminal, reportWatch, type ReporterDeps } from './trigger_reporter';
import { listRecords, patchRecord, type TriggerRecord, type TriggerStoreIO } from './trigger_store';
import {
  advanceWatches,
  startWatch,
  DEFAULT_WATCH_OPTS,
  type WatchAuditSink,
  type WatchChecksClient,
  type WatchOpts,
} from './trigger_watch';

export interface RequestOutcome {
  status: 'done' | 'failed' | 'running' | 'unknown';
  prUrl?: string;
  reason?: string;
}

/** Map a request's state.json shape to a RequestOutcome (pure; the bin reads
 *  the file, this classifies it). Unknown/absent status → `unknown` (hold). */
export function outcomeFromState(
  state: { status?: unknown; pr_url?: unknown; blocker?: unknown } | null,
): RequestOutcome {
  const status = typeof state?.status === 'string' ? state.status.toLowerCase() : '';
  const prUrl = typeof state?.pr_url === 'string' ? state.pr_url : undefined;
  const reason = typeof state?.blocker === 'string' ? state.blocker : undefined;
  if (['done', 'integrated', 'completed', 'merged'].includes(status)) {
    return { status: 'done', ...(prUrl ? { prUrl } : {}) };
  }
  if (['failed', 'cancelled', 'canceled', 'error'].includes(status)) {
    return { status: 'failed', ...(reason ? { reason } : {}) };
  }
  if (status === '') return { status: 'unknown' };
  return { status: 'running' };
}

export interface WatchTickDeps {
  storeIO: TriggerStoreIO;
  /** Read a triggered request's outcome (prod: its per-repo state.json). */
  readOutcome: (record: TriggerRecord) => RequestOutcome;
  /** The branch whose CI the watch tracks (prod: `autonomous/<requestId>`). */
  branchFor: (record: TriggerRecord) => string;
  checks: WatchChecksClient;
  now: () => number;
  audit: WatchAuditSink;
  reporter: ReporterDeps;
  opts?: WatchOpts;
}

export interface WatchTickResult {
  started: number;
  reportedDone: number;
  reportedFailed: number;
}

async function safe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* best-effort */
  }
}

/**
 * Run one tick: detect completions of enqueued triggers, then advance the
 * active stabilization watches. Never throws; returns a small summary.
 */
export async function runWatchTick(deps: WatchTickDeps): Promise<WatchTickResult> {
  const result: WatchTickResult = { started: 0, reportedDone: 0, reportedFailed: 0 };
  const opts = deps.opts ?? DEFAULT_WATCH_OPTS;

  // 1. Completion detection over enqueued records.
  for (const record of listRecords(deps.storeIO).filter((r) => r.status === 'enqueued')) {
    let outcome: RequestOutcome;
    try {
      outcome = deps.readOutcome(record);
    } catch {
      continue; // can't read status this tick — try again later
    }

    if (outcome.status === 'done') {
      startWatch(record.requestId, deps.branchFor(record), deps.now(), deps.storeIO);
      result.started += 1;
      result.reportedDone += 1;
      await safe(() =>
        reportTerminal(
          record,
          { status: 'done', ...(outcome.prUrl ? { prUrl: outcome.prUrl } : {}) },
          deps.reporter,
        ),
      );
    } else if (outcome.status === 'failed') {
      patchRecord(record.requestId, { status: 'failed' }, deps.storeIO);
      result.reportedFailed += 1;
      await safe(() =>
        reportTerminal(
          record,
          { status: 'failed', ...(outcome.reason ? { reason: outcome.reason } : {}) },
          deps.reporter,
        ),
      );
    }
    // running / unknown → leave enqueued for a later tick
  }

  // 2. Advance the active watches (re-entrancy-guarded inside advanceWatches).
  await advanceWatches({
    storeIO: deps.storeIO,
    checks: deps.checks,
    now: deps.now,
    audit: deps.audit,
    onTransition: (rec, status, reason) => reportWatch(rec, status, reason, deps.reporter),
    opts,
  });

  return result;
}
