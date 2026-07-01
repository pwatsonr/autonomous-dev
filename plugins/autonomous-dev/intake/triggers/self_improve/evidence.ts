/**
 * TASK-005 — Evidence check for confirmed-real self-improvement issues.
 *
 * Before submitting a fix request, we verify that the issue reflects a
 * genuine, confirmed failure (not a false negative from the verification
 * harness). Class-specific logic:
 *
 * - A1: verify the referenced pipeline request actually failed.
 * - A2: verify the reviewer block is genuine (`REQUEST_CHANGES`).
 * - A3: verify the `autodev/auto-fix` label was applied by a human, not
 *   the bot.
 *
 * All external calls are raced against `deps.timeoutMs`. Timeout →
 * `{ ok: false, reason: 'EVIDENCE_TIMEOUT' }`, which maps to NA7 in guards.
 *
 * @module intake/triggers/self_improve/evidence
 */

import type { ActionableClassId } from './actionable';
import type { IssueSnapshot, IssueEventsSnapshot } from './actionable';
import { LABEL_AUTO_FIX } from './labels';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of an evidence check. */
export interface EvidenceCheck {
  ok: boolean;
  reason?: string;
  detail?: unknown;
}

/** Injectable dependencies for evidence checks. */
export interface EvidenceDeps {
  /**
   * Read a request's `state.json` from the given repo path.
   *
   * @param repoPath - Absolute path to the repo on disk.
   * @param requestId - The request identifier to look up.
   * @returns The state object if found, or `null` when the request is unknown.
   */
  readState: (repoPath: string, requestId: string) => Promise<{ status?: unknown } | null>;

  /**
   * Fetch the reduced events snapshot for an issue.
   *
   * @param repoId - Repository identifier (`owner/name`).
   * @param issueNumber - Issue number.
   */
  fetchIssueEvents: (repoId: string, issueNumber: number) => Promise<IssueEventsSnapshot>;

  /**
   * Optionally verify the reviewer block fingerprint.
   * Absent → `mode: 'marker-only'` is accepted.
   */
  readReviewerBlock?: (
    repoId: string,
    issueNumber: number,
    fp: string,
  ) => Promise<{ verdict: 'REQUEST_CHANGES' | 'ERROR' | 'APPROVE' | 'COMMENT' } | null>;

  /** Max milliseconds to wait for any remote call. Default: 500. */
  timeoutMs: number;

  /** Bot login for A3 human-labeler verification. */
  botLogin: string;
}

/** Minimal ownership type used by the evidence module. */
export interface Ownership {
  repos: Array<{ repoId: string; path: string; enrolled: boolean }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error('EVIDENCE_TIMEOUT')), ms),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Check whether an issue provides genuine evidence of a confirmed failure.
 *
 * @param klass - The actionable class (`'A1'`, `'A2'`, or `'A3'`).
 * @param issue - The issue snapshot to check.
 * @param ownership - The ownership registry for repo path resolution.
 * @param deps - Injected dependencies.
 * @returns An `EvidenceCheck` result.
 */
export async function checkEvidence(
  klass: ActionableClassId,
  issue: IssueSnapshot,
  ownership: Ownership,
  deps: EvidenceDeps,
): Promise<EvidenceCheck> {
  try {
    if (klass === 'A1') {
      return await withTimeout(checkA1(issue, ownership, deps), deps.timeoutMs);
    }
    if (klass === 'A2') {
      return await withTimeout(checkA2(issue, deps), deps.timeoutMs);
    }
    if (klass === 'A3') {
      return await withTimeout(checkA3(issue, deps), deps.timeoutMs);
    }
    return { ok: false, reason: 'NA7_UNKNOWN_CLASS' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === 'EVIDENCE_TIMEOUT') {
      return { ok: false, reason: 'EVIDENCE_TIMEOUT' };
    }
    return { ok: false, reason: msg };
  }
}

// ---------------------------------------------------------------------------
// A1 evidence check
// ---------------------------------------------------------------------------

async function checkA1(
  issue: IssueSnapshot,
  ownership: Ownership,
  deps: EvidenceDeps,
): Promise<EvidenceCheck> {
  // Step 1: locate repo path
  const repoEntry = ownership.repos.find((r) => r.repoId === issue.repoId);
  if (!repoEntry) {
    return { ok: false, reason: 'NA7_NO_REPO_PATH' };
  }
  const repoPath = repoEntry.path;

  // Step 2: extract candidate request id from body
  const reqIdRe = /REQ-\d{6}/g;
  const matches = issue.body.match(reqIdRe);
  const reqId = matches ? matches[0] : null;

  if (!reqId) {
    // No REQ- reference — if fingerprint present, accept as marker-only
    if (issue.fingerprint !== null) {
      return { ok: true, detail: { mode: 'marker-only' } };
    }
    return { ok: false, reason: 'NA7_STATE_MISMATCH' };
  }

  // Step 3: read state for the referenced request
  const state = await deps.readState(repoPath, reqId);
  if (state !== null && state.status === 'failed') {
    return { ok: true, detail: { mode: 'state-verified', requestId: reqId } };
  }
  return { ok: false, reason: 'NA7_STATE_MISMATCH' };
}

// ---------------------------------------------------------------------------
// A2 evidence check
// ---------------------------------------------------------------------------

async function checkA2(issue: IssueSnapshot, deps: EvidenceDeps): Promise<EvidenceCheck> {
  // Step 1: require reviewer block fingerprint
  if (!issue.reviewerBlockFp) {
    return { ok: false, reason: 'NA7_NO_REVIEWER_BLOCK' };
  }

  // Step 2: if no verification function, accept marker-only
  if (!deps.readReviewerBlock) {
    return { ok: true, detail: { mode: 'marker-only' } };
  }

  // Step 3: verify
  const result = await deps.readReviewerBlock(issue.repoId, issue.number, issue.reviewerBlockFp);
  if (!result) {
    return { ok: false, reason: 'NA7_REVIEWER_VERDICT_UNKNOWN' };
  }
  if (result.verdict === 'REQUEST_CHANGES') {
    return { ok: true };
  }
  if (result.verdict === 'ERROR') {
    return { ok: false, reason: 'NA7_REVIEWER_ERROR' };
  }
  return { ok: false, reason: 'NA7_REVIEWER_VERDICT_UNKNOWN' };
}

// ---------------------------------------------------------------------------
// A3 evidence check
// ---------------------------------------------------------------------------

async function checkA3(issue: IssueSnapshot, deps: EvidenceDeps): Promise<EvidenceCheck> {
  // Step 1: fetch events
  const events = await deps.fetchIssueEvents(issue.repoId, issue.number);

  // Step 2: find who applied the LABEL_AUTO_FIX label
  const actor = events.labeledBy[LABEL_AUTO_FIX];
  if (!actor) {
    return { ok: false, reason: 'NA7_NO_AUTO_FIX_LABEL_EVENT' };
  }

  // Step 3: reject if the bot applied the label
  if (actor === deps.botLogin) {
    return { ok: false, reason: 'NA7_BOT_LABELER' };
  }

  return { ok: true, detail: { humanLabeler: actor } };
}
