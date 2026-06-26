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

import { failureFingerprint, type IssueFiler } from './issue_filer';
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
  // The pipeline writes a RequestStatus: queued | active | paused | cancelled |
  // done | failed (see adapter_interface RequestStatus). Trim — a stray newline
  // in state.json must not read as 'running'.
  const status = typeof state?.status === 'string' ? state.status.trim().toLowerCase() : '';
  const prUrl = typeof state?.pr_url === 'string' ? state.pr_url : undefined;
  const reason = typeof state?.blocker === 'string' ? state.blocker : undefined;
  if (status === 'done') return { status: 'done', ...(prUrl ? { prUrl } : {}) };
  if (status === 'failed' || status === 'cancelled') {
    return { status: 'failed', ...(reason ? { reason } : {}) };
  }
  if (status === '') return { status: 'unknown' };
  return { status: 'running' }; // queued / active / paused → still in flight
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
  /** Optional auto-issue filer: opens a GitHub issue on a terminal FAILURE
   *  (pipeline failed, watch regressed/expired). Omitted = no issues filed. */
  issueFiler?: IssueFiler;
  opts?: WatchOpts;
}

export interface WatchTickResult {
  started: number;
  reportedDone: number;
  reportedFailed: number;
  issuesFiled: number;
}

async function safe(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch {
    /* best-effort */
  }
}

/** Build + file a failure issue, best-effort. Returns whether one was filed.
 *  The repo SLUG is the record's targetRepo (e.g. `owner/name`); the dedup
 *  fingerprint keys on repo+request+class so recurrences collapse to one issue. */
async function fileFailureIssue(
  filer: IssueFiler | undefined,
  record: TriggerRecord,
  failureClass: string,
  detail: string,
): Promise<boolean> {
  if (!filer) return false;
  try {
    const res = await filer.file({
      repo: record.targetRepo,
      title: `[autodev:${failureClass}] ${record.requestId} on ${record.scope}`,
      body: failureIssueBody(record, failureClass, detail),
      fingerprint: failureFingerprint({
        repo: record.targetRepo,
        requestId: record.requestId,
        failureClass,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function failureIssueBody(record: TriggerRecord, failureClass: string, detail: string): string {
  const lines = [
    `Autonomous-dev recorded a **${failureClass}** for request \`${record.requestId}\`.`,
    '',
    `- Scope: \`${record.scope}\``,
    `- Target repo: \`${record.targetRepo}\``,
  ];
  if (record.watchPrBranch) lines.push(`- PR branch: \`${record.watchPrBranch}\``);
  const clean = detail.replace(/[\r\n]+/g, ' ').trim();
  if (clean) lines.push(`- Detail: ${clean}`);
  lines.push('', 'Filed automatically by autonomous-dev; recurrences dedup onto this issue.');
  return lines.join('\n');
}

/**
 * Run one tick: detect completions of enqueued triggers, then advance the
 * active stabilization watches. Never throws; returns a small summary.
 */
export async function runWatchTick(deps: WatchTickDeps): Promise<WatchTickResult> {
  const result: WatchTickResult = { started: 0, reportedDone: 0, reportedFailed: 0, issuesFiled: 0 };
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
      if (await fileFailureIssue(deps.issueFiler, record, 'pipeline-failed', outcome.reason ?? '')) {
        result.issuesFiled += 1;
      }
    }
    // running / unknown → leave enqueued for a later tick
  }

  // 2. Advance the active watches (re-entrancy-guarded inside advanceWatches).
  await advanceWatches({
    storeIO: deps.storeIO,
    checks: deps.checks,
    now: deps.now,
    audit: deps.audit,
    onTransition: async (rec, status, reason) => {
      await safe(() => reportWatch(rec, status, reason, deps.reporter));
      if (status === 'regressed' || status === 'expired') {
        if (await fileFailureIssue(deps.issueFiler, rec, status, reason)) {
          result.issuesFiled += 1;
        }
      }
    },
    opts,
  });

  return result;
}
