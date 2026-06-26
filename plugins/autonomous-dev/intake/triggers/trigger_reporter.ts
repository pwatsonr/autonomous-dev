/**
 * ONBOARD Phase 4 (#596) — scoped status reporting back to a trigger's origin.
 *
 * Formats + delivers status messages (accepted / terminal) to the channel a
 * trigger came from, via an INJECTED notifier seam. The notifier is the only
 * platform-specific, credential-bearing piece (Discord/Slack bot post to
 * origin.channelId) — it is wired at deploy; the build + tests use a fake.
 *
 * Two invariants (PRD FR-E):
 *   - Delivery is BEST-EFFORT: a send failure never throws and never blocks the
 *     pipeline; the failure is itself audited.
 *   - The TERMINAL outcome is ALWAYS written to the audit trail regardless of
 *     chat-delivery success, so a chat outage never loses the result (the
 *     portal/CLI surface it independently).
 *
 * @module intake/triggers/trigger_reporter
 */

import type { TriggerOrigin, TriggerRecord } from './trigger_store';

export interface TriggerMessage {
  title: string;
  body: string;
}

/** Best-effort delivery to a trigger's origin channel (prod: bot post). */
export interface TriggerNotifier {
  send(origin: TriggerOrigin, message: TriggerMessage): Promise<{ ok: boolean; error?: string }>;
}

/** Minimal audit sink (prod adapts the daemon AuditLogger). */
export interface TriggerAuditSink {
  append(entry: { event: string; [k: string]: unknown }): void;
}

export interface ReporterDeps {
  notifier: TriggerNotifier;
  audit: TriggerAuditSink;
}

export interface AcceptedInfo {
  /** Rough budgeted cost in USD for a full pipeline run. */
  costUsd?: number;
  /** Human ETA string (e.g. '20m'). */
  eta?: string;
}

export type TerminalOutcome =
  | { status: 'done'; prUrl?: string }
  | { status: 'failed'; reason?: string };

// ---------------------------------------------------------------------------
// Formatting (pure)
// ---------------------------------------------------------------------------

/** Collapse newlines so user-/PR-derived text can't break audit-log lines. */
function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

export function formatAccepted(record: TriggerRecord, info: AcceptedInfo = {}): TriggerMessage {
  const cost =
    info.costUsd !== undefined && Number.isFinite(info.costUsd) && info.costUsd >= 0
      ? `~$${info.costUsd.toFixed(2)}`
      : 'an estimated cost';
  const eta = info.eta ? `, ETA ${oneLine(info.eta)}` : '';
  return {
    title: `Accepted — ${record.requestId}`,
    body:
      `Working on ${record.scope}: ${record.targetRepo}.\n` +
      `This runs the full pipeline (${cost}${eta}) and opens a PR. ` +
      `I'll report back here when it's done.`,
  };
}

export function formatTerminal(record: TriggerRecord, outcome: TerminalOutcome): TriggerMessage {
  if (outcome.status === 'done') {
    const pr = outcome.prUrl ? `\nPR: ${oneLine(outcome.prUrl)}` : '';
    return {
      title: `Done — ${record.requestId}`,
      body: `Finished ${record.scope}: ${record.targetRepo}.${pr}`,
    };
  }
  const reason = outcome.reason ? `\nReason: ${oneLine(outcome.reason)}` : '';
  return {
    title: `Failed — ${record.requestId}`,
    body: `Could not complete ${record.scope}: ${record.targetRepo}.${reason}`,
  };
}

// ---------------------------------------------------------------------------
// Delivery (best-effort; never throws)
// ---------------------------------------------------------------------------

async function trySend(
  record: TriggerRecord,
  message: TriggerMessage,
  deps: ReporterDeps,
): Promise<void> {
  // No origin channel → nothing to deliver to (the audit trail still has it).
  if (!record.origin.channelId) {
    deps.audit.append({
      event: 'trigger_report_skipped',
      request_id: record.requestId,
      reason: 'no-origin-channel',
    });
    return;
  }
  try {
    const res = await deps.notifier.send(record.origin, message);
    if (!res.ok) {
      deps.audit.append({
        event: 'trigger_report_failed',
        request_id: record.requestId,
        error: res.error ?? 'unknown',
      });
    }
  } catch (err) {
    deps.audit.append({
      event: 'trigger_report_failed',
      request_id: record.requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Report that a trigger was accepted + enqueued. Best-effort delivery. */
export async function reportAccepted(
  record: TriggerRecord,
  info: AcceptedInfo,
  deps: ReporterDeps,
): Promise<void> {
  deps.audit.append({
    event: 'trigger_accepted',
    request_id: record.requestId,
    repo: record.targetRepo,
    scope: record.scope,
  });
  await trySend(record, formatAccepted(record, info), deps);
}

/**
 * Report a terminal outcome. The audit entry is written FIRST and
 * unconditionally (the chat-outage fallback), then delivery is attempted.
 */
export async function reportTerminal(
  record: TriggerRecord,
  outcome: TerminalOutcome,
  deps: ReporterDeps,
): Promise<void> {
  deps.audit.append({
    event: outcome.status === 'done' ? 'trigger_done' : 'trigger_failed',
    request_id: record.requestId,
    repo: record.targetRepo,
    scope: record.scope,
    ...(outcome.status === 'done' && outcome.prUrl ? { pr: outcome.prUrl } : {}),
    ...(outcome.status === 'failed' && outcome.reason ? { reason: outcome.reason } : {}),
  });
  await trySend(record, formatTerminal(record, outcome), deps);
}

export type WatchOutcome = 'stable' | 'regressed' | 'expired';

export function formatWatch(record: TriggerRecord, status: WatchOutcome, reason: string): TriggerMessage {
  const r = reason ? ` — ${oneLine(reason)}` : '';
  if (status === 'stable') {
    return {
      title: `Stabilized — ${record.requestId}`,
      body: `${record.scope}: ${record.targetRepo} held green${r}. Disengaging the watch.`,
    };
  }
  if (status === 'regressed') {
    return {
      title: `Regressed — ${record.requestId}`,
      body: `Heads up: ${record.scope}: ${record.targetRepo}${r}.`,
    };
  }
  return {
    title: `Watch expired — ${record.requestId}`,
    body: `${record.scope}: ${record.targetRepo}${r}.`,
  };
}

/**
 * Report a terminal WATCH transition to origin. The watch loop already audits
 * the transition (watch_stable/regressed/expired); this is the best-effort send.
 */
export async function reportWatch(
  record: TriggerRecord,
  status: WatchOutcome,
  reason: string,
  deps: ReporterDeps,
): Promise<void> {
  await trySend(record, formatWatch(record, status, reason), deps);
}
