/**
 * TASK-006 — Ordered guard pipeline for the self-improvement loop.
 *
 * `evaluateGuards` evaluates 14 named guards in the exact safety-critical
 * order defined below and short-circuits on the first trip. Each guard
 * has its own `GuardId` so downstream consumers (events, stats) can
 * attribute skips precisely.
 *
 * Guard order (verbatim — do NOT reorder):
 *   GD1 → GD2 → GD10 → GD9 → NA1 → GD4 → GD5 → GD6 → GD7 → NA3 → NA4 → NA2 → GD11 → NA7
 *
 * @module intake/triggers/self_improve/guards
 */

import type { SelfImproveConfig } from './config';
import type { LedgerReader } from './ledger';
import type { ActionableClassId, IssueSnapshot } from './actionable';
import type { EvidenceCheck } from './evidence';
import type { Ownership } from './evidence';
import { LABEL_IN_PROGRESS } from './labels';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** All valid guard identifiers. */
export type GuardId =
  | 'GD1'
  | 'GD2'
  | 'GD3'
  | 'GD4'
  | 'GD5'
  | 'GD6'
  | 'GD7'
  | 'GD8'
  | 'GD9'
  | 'GD10'
  | 'GD11'
  | 'GD12'
  | 'NA1'
  | 'NA2'
  | 'NA3'
  | 'NA4'
  | 'NA5'
  | 'NA6'
  | 'NA7';

/** Evidence recorded when a guard trips. */
export interface GuardTrip {
  guard: GuardId;
  evidence: Record<string, unknown>;
}

/** Snapshot of concurrency counters at the time of evaluation. */
export interface ConcurrencyView {
  activeGlobal: number;
  activePerRepo: number;
}

/** Snapshot of cost-window counters at the time of evaluation. */
export interface CostWindowView {
  last24h: number;
  last7d: number;
}

/** Full context passed to `evaluateGuards`. */
export interface GuardCtx {
  env: SelfImproveConfig;
  ownership: Ownership;
  ledger: LedgerReader;
  issue: IssueSnapshot;
  klass: ActionableClassId | null;
  evidence: EvidenceCheck | null;
  now: number;
  fnRegistry: Set<string>;
  tickSubmittedSoFar: number;
  concurrencyView: ConcurrencyView;
  costWindow: CostWindowView;
}

/** Discriminated union result of `evaluateGuards`. */
export type GuardResult = { ok: true } | { ok: false; trip: GuardTrip };

// ---------------------------------------------------------------------------
// Guard implementation
// ---------------------------------------------------------------------------

function trip(guard: GuardId, evidence: Record<string, unknown>): GuardResult {
  return { ok: false, trip: { guard, evidence } };
}

/**
 * Evaluate the 14-guard pipeline in the canonical safety-critical order.
 *
 * Ordering (verbatim):
 *   GD1 → GD2 → GD10 → GD9 → NA1 → GD4 → GD5 → GD6 → GD7 → NA3 → NA4 → NA2 → GD11 → NA7
 *
 * @param ctx - Full guard context.
 * @returns `{ ok: true }` if all guards pass, or `{ ok: false, trip }` on
 *   the first tripped guard.
 */
export function evaluateGuards(ctx: GuardCtx): GuardResult {
  const { env, issue, klass, evidence, ledger, fnRegistry, concurrencyView, costWindow, now } =
    ctx;
  const key = `${issue.repoId}#${issue.number}`;

  // GD1 — global kill-switch
  if (!env.enabled) return trip('GD1', {});

  // GD2 — repo must be enrolled
  const repoEntry = ctx.ownership.repos.find((r) => r.repoId === issue.repoId);
  if (!repoEntry?.enrolled) return trip('GD2', { repoId: issue.repoId });

  // GD10 — issue must be classifiable
  if (klass === null) return trip('GD10', { labels: issue.labels });

  // GD9 — false-negative registry
  if (issue.fingerprint !== null && fnRegistry.has(issue.fingerprint)) {
    return trip('GD9', { fingerprint: issue.fingerprint });
  }

  // NA1 — A3 + in-progress label guard
  if (
    klass === 'A3' &&
    !env.addInProgressLabel &&
    issue.labels.includes(LABEL_IN_PROGRESS)
  ) {
    return trip('NA1', {});
  }

  // GD4 — global concurrency cap
  if (concurrencyView.activeGlobal >= env.maxConcurrentGlobal) {
    return trip('GD4', { activeGlobal: concurrencyView.activeGlobal });
  }

  // GD5 — per-repo concurrency cap
  if (concurrencyView.activePerRepo >= env.maxConcurrentPerRepo) {
    return trip('GD5', { activePerRepo: concurrencyView.activePerRepo });
  }

  // GD6 — daily cost cap
  if (costWindow.last24h >= env.maxCostUsdPerDay) {
    return trip('GD6', { last24h: costWindow.last24h });
  }

  // GD7 — weekly cost cap
  if (costWindow.last7d >= env.maxCostUsdPerWeek) {
    return trip('GD7', { last7d: costWindow.last7d });
  }

  // NA3 — per-issue attempt cap
  const entry = ledger.getEntry(key);
  if (entry !== undefined && entry.attempts >= env.maxAttemptsPerIssue) {
    return trip('NA3', { attempts: entry.attempts });
  }

  // NA4 — backoff window
  if (entry?.backoffUntil) {
    const backoffMs = Date.parse(entry.backoffUntil);
    if (!isNaN(backoffMs) && backoffMs > now) {
      return trip('NA4', { backoffUntil: entry.backoffUntil });
    }
  }

  // NA2 — in-flight dedup
  const inFlightReqId = ledger.getInFlightAutoFixRequest(key);
  if (inFlightReqId !== undefined) {
    return trip('NA2', { requestId: inFlightReqId });
  }

  // GD11 — per-tick submission cap
  if (ctx.tickSubmittedSoFar >= env.maxIssuesPerTick) {
    return trip('GD11', { tickSubmittedSoFar: ctx.tickSubmittedSoFar });
  }

  // NA7 — evidence must be confirmed for A1/A2/A3
  if (
    (klass === 'A1' || klass === 'A2' || klass === 'A3') &&
    evidence?.ok !== true
  ) {
    return trip('NA7', { reason: evidence?.reason ?? 'no-evidence' });
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Backoff calculator
// ---------------------------------------------------------------------------

/**
 * Compute the backoff deadline for the next retry attempt.
 *
 * Uses exponential backoff: `baseMinutes * 2^(attempts - 1)`, capped at 24 h.
 * For `attempts <= 0`, `Math.max(0, attempts - 1) === 0`, giving `baseMinutes`.
 *
 * @param attempts - Number of attempts already made (0 → same as 1 for growth).
 * @param lastAttemptAt - Epoch ms of the most recent attempt.
 * @param baseMinutes - Exponential backoff base in minutes.
 * @returns Epoch ms of the earliest time the next attempt is allowed.
 */
export function computeBackoffUntil(
  attempts: number,
  lastAttemptAt: number,
  baseMinutes: number,
): number {
  const growthMinutes = baseMinutes * Math.pow(2, Math.max(0, attempts - 1));
  const cappedMinutes = Math.min(growthMinutes, 24 * 60);
  return lastAttemptAt + cappedMinutes * 60_000;
}
