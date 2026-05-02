/**
 * Reviewer invocation runner (SPEC-020-2-03, Task 5).
 *
 * Consumes a ScheduledExecution from the scheduler and runs each
 * concurrency group via Promise.all, capturing per-reviewer
 * verdict/duration/error into a ReviewerResult[] in flattened chain
 * order. Errors thrown by individual reviewers are CAPTURED inline (not
 * propagated) so a single failure does not strand the rest of the
 * group: this is required by the aggregator's built-in-min rule, which
 * needs to count every completed built-in.
 *
 * The injected `InvokeReviewerFn` is the seam used by tests (deterministic
 * mocks) and production (real Claude Agent SDK calls — wired in
 * SPEC-020-2-04 via `invoke-reviewer.ts`).
 *
 * Telemetry hook (TelemetryEmitFn) is fire-and-forget: invoked after
 * each runOne resolves, regardless of outcome. SPEC-020-2-04 supplies
 * the production emitter (`emitReviewerInvocation`); tests inject a
 * recording mock to assert payload shape.
 *
 * @module intake/reviewers/runner
 */

import { performance } from 'node:perf_hooks';

import type {
  ChangeSetContext,
  ReviewerEntry,
  ReviewerInvocation,
  ReviewerResult,
  ReviewerVerdict,
  ScheduledExecution,
} from './types';

/**
 * Production reviewer invocation contract. The runner does not care how
 * the reviewer is implemented (Claude Agent SDK, in-process module,
 * subprocess); it only needs a Promise of a verdict.
 *
 * On success: resolve with {score, verdict, findings?}.
 * On failure: throw — the runner records `verdict: 'ERROR'` with the
 * thrown error's message.
 */
export type InvokeReviewerFn = (
  entry: ReviewerEntry,
  context: ChangeSetContext,
) => Promise<{ score: number; verdict: 'APPROVE' | 'REQUEST_CHANGES'; findings?: object }>;

/**
 * Telemetry-emit callback contract. Matches `emitReviewerInvocation`
 * (SPEC-020-2-04). Defined here as a type-only seam so the runner
 * stays decoupled from the metrics module.
 *
 * Implementations MUST be fire-and-forget: never throw, never block
 * the runner. The default no-op emitter is used until the orchestrator
 * wires the production emitter in SPEC-020-2-04.
 */
export type TelemetryEmitFn = (log: {
  reviewer: string;
  request_id: string;
  gate: string;
  score: number | null;
  verdict: ReviewerVerdict;
  duration_ms: number;
}) => void;

const noopTelemetry: TelemetryEmitFn = () => {
  /* no-op default; replaced by SPEC-020-2-04's emitReviewerInvocation. */
};

export class ReviewerRunner {
  private readonly emit: TelemetryEmitFn;

  /**
   * @param invoke   Production InvokeReviewerFn (or test mock).
   * @param emit     Optional telemetry hook. Defaults to no-op so
   *                 tests can omit it; SPEC-020-2-04's
   *                 `runReviewGate` orchestrator passes
   *                 `emitReviewerInvocation` here.
   */
  constructor(
    private readonly invoke: InvokeReviewerFn,
    emit?: TelemetryEmitFn,
  ) {
    this.emit = emit ?? noopTelemetry;
  }

  /**
   * Execute a ScheduledExecution. Within a group: parallel via
   * Promise.all. Across groups: strictly sequential (group N+1 waits
   * for group N). Returns the flattened ReviewerResult[] in original
   * chain order.
   */
  async run(execution: ScheduledExecution): Promise<ReviewerResult[]> {
    const all: ReviewerResult[] = [];
    for (const group of execution.groups) {
      // Empty groups are allowed defensively; Promise.all([]) resolves
      // synchronously to []. The scheduler is specified to omit empty
      // groups, but defending here costs nothing.
      const results = await Promise.all(group.map((inv) => this.runOne(inv)));
      for (const r of results) all.push(r);
    }
    return all;
  }

  /**
   * Run a single invocation. Wraps the injected `invoke` so any thrown
   * error is converted to `verdict: 'ERROR'` (rather than rejecting the
   * outer Promise.all and stranding sibling reviewers).
   */
  private async runOne(invocation: ReviewerInvocation): Promise<ReviewerResult> {
    const { entry, context } = invocation;
    const start = performance.now();
    try {
      const out = await this.invoke(entry, context);
      const duration_ms = performance.now() - start;
      const result: ReviewerResult = {
        reviewer_name: entry.name,
        reviewer_type: entry.type,
        blocking: entry.blocking,
        threshold: entry.threshold,
        score: out.score,
        verdict: out.verdict,
        duration_ms,
        findings: out.findings,
      };
      this.safeEmit(result, context);
      return result;
    } catch (err) {
      const duration_ms = performance.now() - start;
      const result: ReviewerResult = {
        reviewer_name: entry.name,
        reviewer_type: entry.type,
        blocking: entry.blocking,
        threshold: entry.threshold,
        score: null,
        verdict: 'ERROR',
        duration_ms,
        error_message: (err as Error)?.message ?? String(err),
      };
      this.safeEmit(result, context);
      return result;
    }
  }

  /**
   * Telemetry emission must never affect the runner's outcome. Wrap
   * the (already fire-and-forget) emit in a try/catch as a final
   * safety net so a misbehaving emitter cannot crash the gate.
   */
  private safeEmit(result: ReviewerResult, context: ChangeSetContext): void {
    try {
      this.emit({
        reviewer: result.reviewer_name,
        request_id: context.requestId,
        gate: context.gate,
        score: result.score,
        verdict: result.verdict,
        duration_ms: result.duration_ms,
      });
    } catch {
      // Swallow: telemetry must not affect the runner's return value.
    }
  }
}
