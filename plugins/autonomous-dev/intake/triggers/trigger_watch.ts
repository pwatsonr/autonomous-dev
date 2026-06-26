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
  /** Max gap between OBSERVED-green ticks before the streak resets (default 1d).
   *  Forces `stable` to require continuously-observed green rather than mere
   *  elapsed wall-clock across unobserved/red windows. Must be ≫ tick cadence. */
  maxGapMs: number;
}

export const DEFAULT_WATCH_OPTS: WatchOpts = { nDays: 3, maxWatchDays: 14, maxGapMs: DAY_MS };

export type WatchTerminal = 'stable' | 'regressed' | 'expired';

export interface WatchEval {
  /** Resulting record status after this evaluation. */
  status: TriggerRecordStatus;
  /** Resulting green-streak start (undefined = no active streak). */
  greenSinceMs: number | undefined;
  /** Resulting last-observed-green time (undefined = never observed green). */
  lastGreenMs: number | undefined;
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
  const hold: WatchEval = {
    status: record.status,
    greenSinceMs: record.greenSinceMs,
    lastGreenMs: record.lastGreenMs,
    transitioned: false,
  };
  if (record.status !== 'watching') return hold;

  // Hard cap first — a watch never runs forever.
  if (
    record.watchStartedAtMs !== undefined &&
    nowMs - record.watchStartedAtMs > opts.maxWatchDays * DAY_MS
  ) {
    return { ...hold, status: 'expired', transitioned: true, reason: 'window expired — manual review' };
  }

  // A revert undoes the change → regressed (alert-only v1; terminal).
  if (check.hasRevert === true) {
    return {
      status: 'regressed',
      greenSinceMs: undefined,
      lastGreenMs: record.lastGreenMs,
      transitioned: true,
      reason: 'change reverted',
    };
  }

  if (check.state === 'green') {
    // The streak only CONTINUES if green was observed within maxGapMs; a longer
    // gap (red, pending, or a missed/errored tick) means we can't claim
    // continuous green, so the streak restarts now.
    // A NEGATIVE gap (clock skew / a future-dated lastGreenMs from a clock
    // rewind) must NOT count as "recent" — we can't prove continuity, so the
    // streak restarts (this closes the round-1 blocker via the skew path).
    const gap = record.lastGreenMs !== undefined ? nowMs - record.lastGreenMs : Number.POSITIVE_INFINITY;
    const recent = gap >= 0 && gap <= opts.maxGapMs;
    const greenSince = record.greenSinceMs !== undefined && recent ? record.greenSinceMs : nowMs;
    if (nowMs - greenSince >= opts.nDays * DAY_MS) {
      return {
        status: 'stable',
        greenSinceMs: greenSince,
        lastGreenMs: nowMs,
        transitioned: true,
        reason: `CI green for ${opts.nDays} days`,
      };
    }
    return { status: 'watching', greenSinceMs: greenSince, lastGreenMs: nowMs, transitioned: false };
  }

  if (check.state === 'red') {
    // Streak broken — reset greenSinceMs; keep the last-green marker so a later
    // green still sees the gap. Keep watching.
    return { status: 'watching', greenSinceMs: undefined, lastGreenMs: record.lastGreenMs, transitioned: false };
  }

  // pending / unknown → hold; don't disturb the streak markers.
  return hold;
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

// Serialize overlapping ticks within this process — load-modify-save on the
// store is not safe under concurrency. Calls are CHAINED (queued), not
// coalesced: a second call while one is in flight runs AFTER it (so a tick that
// started new watches mid-loop is not silently dropped). (Cross-process safety
// would need a versioned store; the daemon invokes this from one ticker,
// documented in the deploy guide.)
let advanceTail: Promise<void> = Promise.resolve();

/**
 * Advance every active watch one tick: read CI, evaluate, persist any change,
 * and on a terminal transition audit + report. Best-effort: a checks/report
 * error for one record never aborts the others. Serialized via a promise chain.
 */
export function advanceWatches(deps: AdvanceWatchesDeps): Promise<void> {
  const next = advanceTail.then(
    () => runAdvance(deps),
    () => runAdvance(deps),
  );
  // The tail never rejects, so one failed run can't break the chain.
  advanceTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function runAdvance(deps: AdvanceWatchesDeps): Promise<void> {
  const opts = deps.opts ?? DEFAULT_WATCH_OPTS;
  const nowMs = deps.now();
  // A watch is only active with BOTH a branch and a start time — a record set
  // to 'watching' without startWatch (so no hard cap) is not ticked.
  const active = listRecords(deps.storeIO).filter(
    (r) =>
      r.status === 'watching' &&
      typeof r.watchPrBranch === 'string' &&
      typeof r.watchStartedAtMs === 'number',
  );

  for (const record of active) {
    let check: WatchCheckStatus;
    try {
      check = await deps.checks.getStatus(record.targetRepo, record.watchPrBranch as string);
    } catch (err) {
      // Surface (don't silently swallow) a misconfigured branch / gh failure.
      deps.audit.append({
        event: 'watch_check_error',
        request_id: record.requestId,
        repo: record.targetRepo,
        error: err instanceof Error ? err.message : String(err),
      });
      continue; // transient — retry next tick
    }

    const ev = evaluateWatch(record, check, nowMs, opts);

    if (
      ev.status !== record.status ||
      ev.greenSinceMs !== record.greenSinceMs ||
      ev.lastGreenMs !== record.lastGreenMs
    ) {
      patchRecord(
        record.requestId,
        { status: ev.status, greenSinceMs: ev.greenSinceMs, lastGreenMs: ev.lastGreenMs },
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
