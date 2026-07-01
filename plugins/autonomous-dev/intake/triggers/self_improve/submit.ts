/**
 * TASK-010 — `submitFromIssue`: the sequenced submit adapter.
 *
 * Sequence (ADR-005 ledger-before-comment):
 * 1. Build payload.
 * 2. Emit truncation event if body was truncated.
 * 3. Call `requestSubmit`. On failure: emit error, return {ok:false}. No ledger write.
 * 4. On success: write ledger (recordSubmission).
 * 5. Best-effort GitHub comment. Failure: emit error. Ledger stays.
 * 6. Emit `self_improve_request_submitted`.
 * 7. Return `{ok:true, requestId}`.
 *
 * @module intake/triggers/self_improve/submit
 */

import type { IssueSnapshot } from './actionable';
import type { ActionableClassId } from './actionable';
import type { SelfImproveConfig } from './config';
import type { LedgerMutator, LedgerEntry } from './ledger';
import type { EventEmitter } from './events';
import type { SourceIssueMeta } from './description';
import { buildSubmitPayload } from './description';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input to the router submit command. */
export interface RequestSubmitInput {
  description: string;
  repo: string;
  priority: 'high' | 'normal' | 'low';
  type: 'bug' | 'refactor';
  source: 'self-improve';
  selfImproveContext: { sourceIssue: SourceIssueMeta };
}

/** Result from the router submit command. */
export interface RequestSubmitResult {
  requestId: string;
  prUrl?: string;
}

/** Injectable dependencies for `submitFromIssue`. */
export interface SubmitDeps {
  /** Call the router to create a new fix request. */
  requestSubmit: (input: RequestSubmitInput) => Promise<RequestSubmitResult>;
  /** Post a comment on the source issue (best-effort). */
  postGithubComment: (repoId: string, issueNumber: number, body: string) => Promise<void>;
  /** Mutable ledger for tracking in-flight requests. */
  ledger: LedgerMutator;
  /** Event emitter for audit and observability. */
  emit: EventEmitter;
  /** Clock injection. */
  now: () => number;
  /** Resolve a repoId to a local path. */
  resolveRepoPath: (repoId: string) => string;
}

/** Return value of `submitFromIssue`. */
export interface SubmitOutcome {
  ok: boolean;
  requestId?: string;
  error?: { code: 'SUBMIT_FAILED' | 'GH_COMMENT_FAILED'; message: string };
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Submit a fix request for a self-improvement issue and track it in the ledger.
 *
 * @param issue - The source issue snapshot.
 * @param klass - The actionable class that matched.
 * @param cfg - Self-improvement config.
 * @param deps - Injected dependencies.
 * @returns A `SubmitOutcome` indicating success or the first error encountered.
 */
export async function submitFromIssue(
  issue: IssueSnapshot,
  klass: ActionableClassId,
  cfg: SelfImproveConfig,
  deps: SubmitDeps,
): Promise<SubmitOutcome> {
  // Step 1: build payload
  const payload = buildSubmitPayload(issue, klass, cfg);

  // Step 2: emit truncation event if applicable
  if (payload.truncation.truncated) {
    deps.emit({
      type: 'self_improve_body_truncated',
      ts: new Date(deps.now()).toISOString(),
      repoId: issue.repoId,
      issueNumber: issue.number,
      originalBytes: payload.truncation.originalBytes,
      truncatedBytes: payload.truncation.truncatedBytes,
    });
  }

  // Step 3: build router input
  const input: RequestSubmitInput = {
    description: payload.description,
    repo: deps.resolveRepoPath(issue.repoId),
    priority: payload.priority,
    type: payload.type,
    source: 'self-improve',
    selfImproveContext: { sourceIssue: payload.sourceIssue },
  };

  // Step 4: call router
  let result: RequestSubmitResult;
  try {
    result = await deps.requestSubmit(input);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.emit({
      type: 'self_improve_error',
      ts: new Date(deps.now()).toISOString(),
      error: message,
      code: 'SUBMIT_FAILED',
      repoId: issue.repoId,
      issueNumber: issue.number,
    });
    return { ok: false, error: { code: 'SUBMIT_FAILED', message } };
  }

  // Step 5: write ledger (BEFORE comment — ADR-005)
  const key = `${issue.repoId}#${issue.number}`;
  const snap = deps.ledger.snapshot();
  const prev = snap.entries[key];
  const entry: LedgerEntry = {
    repoId: issue.repoId,
    issueNumber: issue.number,
    issueFingerprint: issue.fingerprint,
    requestIds: [...(prev?.requestIds ?? []), result.requestId],
    attempts: (prev?.attempts ?? 0) + 1,
    lastAttemptAt: new Date(deps.now()).toISOString(),
    lastOutcome: 'unknown',
    backoffUntil: null,
    status: 'in_flight',
  };
  deps.ledger.recordSubmission(key, entry);

  // Step 6: best-effort GitHub comment
  const commentBody =
    `autonomous-dev has opened ${result.requestId} to address this issue.\n\n` +
    `<!-- autodev-self-improve: ${result.requestId} -->`;
  try {
    await deps.postGithubComment(issue.repoId, issue.number, commentBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.emit({
      type: 'self_improve_error',
      ts: new Date(deps.now()).toISOString(),
      error: message,
      code: 'GH_COMMENT_FAILED',
      repoId: issue.repoId,
      issueNumber: issue.number,
    });
    // Do NOT roll back ledger — the request is real, the comment is best-effort
  }

  // Step 7: emit submitted event
  deps.emit({
    type: 'self_improve_request_submitted',
    ts: new Date(deps.now()).toISOString(),
    repoId: issue.repoId,
    issueNumber: issue.number,
    requestId: result.requestId,
    class: klass,
  });

  return { ok: true, requestId: result.requestId };
}
