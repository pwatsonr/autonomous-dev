/**
 * ONBOARD Phase 4 (#596) — stabilization watch (OQ-1: CI-green-for-N-days).
 *
 * After a triggered request reaches `done`, its record enters `watching`
 * (`startWatch`). Each tick `advanceWatches` checks the PR HEAD branch's CI via
 * an INJECTED checks client and advances a per-record state machine:
 *
 *   watching ──CI green ≥ N days (no revert)──▶ stable
 *   watching ──change reverted────────────────▶ regressed   (alert-only v1)
 *   watching ──now − start > MAX_WATCH_DAYS────▶ expired     (manual review)
 *
 * A red CI resets the green streak (keep watching); pending/unknown holds. All
 * state lives ON the record (watchPrBranch / watchStartedAtMs / greenSinceMs)
 * so the watch is restart-safe — a tick after a daemon restart resumes from
 * disk. Transitions are audited and reported to the trigger's origin via an
 * injected callback. The checks client + clock + report are all injectable, so
 * this builds + tests with no live GitHub/bot credentials.
 *
 * @module intake/triggers/trigger_watch
 */

import {
  listRecords,
  patchRecord,
  type TriggerRecord,
  type TriggerRecordStatus,
  type TriggerStoreIO,
} from './trigger_store';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface WatchCheckStatus {
  state: 'green' | 'red' | 'pending' | 'unknown';
  /** True when the change appears to have been reverted (a strong regression). */
  hasRevert?: boolean;
}

export interface WatchChecksClient {
  getStatus(repo: string, branch: string): Promise<WatchCheckStatus>;
}

export interface WatchAuditSink {
  append(entry: { event: string; [k: string]: unknown }): void;
}

export interface WatchOpts {
  /** Consecutive green days required for `stable` (OQ-1 default 3). */
  nDays: number;
  /** Hard cap before `expired` (default 14). */
  maxWatchDays: number;
}

export const DEFAULT_WATCH_OPTS: WatchOpts = { nDays: 3, maxWatchDays: 14 };

export type WatchTerminal = 'stable' | 'regressed' | 'expired';

export interface WatchEval {
  /** Resulting record status after this evaluation. */
  status: TriggerRecordStatus;
  /** Resulting green-streak start (undefined = no active streak). */
  greenSinceMs: number | undefined;
  /** True iff the status moved to a terminal watch state. */
  transitioned: boolean;
  reason?: string;
}

/**
 * Pure evaluation of one record against a CI status at `nowMs`. Only records in
 * `watching` advance; others are returned unchanged.
 */
export function evaluateWatch(
  record: TriggerRecord,
  check: WatchCheckStatus,
  nowMs: number,
  opts: WatchOpts = DEFAULT_WATCH_OPTS,
): WatchEval {
  if (record.status !== 'watching') {
    return { status: record.status, greenSinceMs: record.greenSinceMs, transitioned: false };
  }

  // Hard cap first — a watch never runs forever.
  if (
    record.watchStartedAtMs !== undefined &&
    nowMs - record.watchStartedAtMs > opts.maxWatchDays * DAY_MS
  ) {
    return {
      status: 'expired',
      greenSinceMs: record.greenSinceMs,
      transitioned: true,
      reason: 'window expired — manual review',
    };
  }

  // A revert undoes the change → regressed (alert-only v1; terminal).
  if (check.hasRevert === true) {
    return { status: 'regressed', greenSinceMs: undefined, transitioned: true, reason: 'change reverted' };
  }

  if (check.state === 'green') {
    const greenSince = record.greenSinceMs ?? nowMs;
    if (nowMs - greenSince >= opts.nDays * DAY_MS) {
      return {
        status: 'stable',
        greenSinceMs: greenSince,
        transitioned: true,
        reason: `CI green for ${opts.nDays} days`,
      };
    }
    // Streak continues (or just started).
    return { status: 'watching', greenSinceMs: greenSince, transitioned: false };
  }

  if (check.state === 'red') {
    // Streak broken — reset and keep watching.
    return { status: 'watching', greenSinceMs: undefined, transitioned: false };
  }

  // pending / unknown → hold; don't disturb the streak.
  return { status: 'watching', greenSinceMs: record.greenSinceMs, transitioned: false };
}

export interface AdvanceWatchesDeps {
  storeIO: TriggerStoreIO;
  checks: WatchChecksClient;
  now: () => number;
  audit: WatchAuditSink;
  /** Report a terminal watch transition to the trigger's origin (best-effort). */
  onTransition: (record: TriggerRecord, status: WatchTerminal, reason: string) => Promise<void>;
  opts?: WatchOpts;
}

/**
 * Advance every active watch one tick: read CI, evaluate, persist any change,
 * and on a terminal transition audit + report. Best-effort: a checks/report
 * error for one record never aborts the others.
 */
export async function advanceWatches(deps: AdvanceWatchesDeps): Promise<void> {
  const opts = deps.opts ?? DEFAULT_WATCH_OPTS;
  const nowMs = deps.now();
  const active = listRecords(deps.storeIO).filter(
    (r) => r.status === 'watching' && typeof r.watchPrBranch === 'string',
  );

  for (const record of active) {
    let check: WatchCheckStatus;
    try {
      check = await deps.checks.getStatus(record.targetRepo, record.watchPrBranch as string);
    } catch {
      continue; // transient — retry next tick
    }

    const ev = evaluateWatch(record, check, nowMs, opts);

    if (ev.status !== record.status || ev.greenSinceMs !== record.greenSinceMs) {
      patchRecord(
        record.requestId,
        { status: ev.status, greenSinceMs: ev.greenSinceMs },
        deps.storeIO,
      );
    }

    if (ev.transitioned) {
      deps.audit.append({
        event: `watch_${ev.status}`,
        request_id: record.requestId,
        repo: record.targetRepo,
        scope: record.scope,
        reason: ev.reason,
      });
      try {
        await deps.onTransition(record, ev.status as WatchTerminal, ev.reason ?? '');
      } catch {
        /* best-effort report */
      }
    }
  }
}

/**
 * Begin watching a triggered request that has reached `done`. Called by the
 * completion-detection integration (the daemon tick observing request status).
 */
export function startWatch(
  requestId: string,
  prBranch: string,
  nowMs: number,
  io: TriggerStoreIO,
): void {
  patchRecord(
    requestId,
    { status: 'watching', watchPrBranch: prBranch, watchStartedAtMs: nowMs, greenSinceMs: undefined },
    io,
  );
}
