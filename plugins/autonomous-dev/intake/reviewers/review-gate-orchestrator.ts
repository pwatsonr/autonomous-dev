/**
 * Review-gate orchestrator (SPEC-020-2-04, Task 8).
 *
 * Composes the existing reviewer-chain pipeline pieces end-to-end for a
 * single review gate invocation:
 *
 *   resolveChain → ReviewerScheduler → ReviewerRunner → ScoreAggregator
 *
 * Decoupled from file I/O and from any concrete InvokeReviewerFn — both are
 * injected by the caller so that:
 *   - The CLI (`bin/review-gate-cli.ts`) injects `createClaudeDispatcher()`
 *     from `invoke-reviewer.ts`.
 *   - Tests inject deterministic mocks without spawning Claude.
 *   - The future daemon (TDD-024) can inject its own in-process dispatcher.
 *
 * Empty chain semantics: when `resolveChain` returns `[]` (gate absent from
 * the config, or all entries disabled), this function returns an APPROVE
 * `GateDecision` with a note explaining why. This matches the resolver
 * contract — an absent gate is treated as "pass" so optional gates do not
 * block pipelines that haven't configured them.
 *
 * @module intake/reviewers/review-gate-orchestrator
 */

import { resolveChain } from './chain-resolver';
import { ReviewerScheduler } from './scheduler';
import { ReviewerRunner, type InvokeReviewerFn, type TelemetryEmitFn } from './runner';
import { ScoreAggregator } from './aggregator';
import type { ChangeSetContext, GateOutcome, GateVerdict, ReviewerResult } from './types';

/**
 * Full decision returned by `runReviewGate`. Extends the aggregator's
 * `GateVerdict` with the per-reviewer result array and the resolved
 * gate/requestType identifiers so that callers (CLI, tests) can emit a
 * self-contained decision JSON without needing to re-join inputs.
 *
 * `results` is the same array as `verdict.per_reviewer` — it is surfaced
 * as a top-level field for ergonomic destructuring in the CLI and tests.
 */
export interface GateDecision {
  /** The resolved gate name (echoed from opts.gate). */
  gate: string;
  /** The resolved request type (echoed from opts.requestType). */
  requestType: string;
  /** Final outcome of the gate. */
  outcome: GateOutcome;
  /** Human-readable explanation of the outcome. */
  reason: string;
  /** Per-reviewer results in flattened chain order. */
  results: ReviewerResult[];
  /** Advisory warnings from non-blocking reviewers. */
  warnings: string[];
  /** Count of built-in reviewers that completed without error. */
  built_in_count_completed: number;
  /** The request_id taken from the ChangeSetContext. */
  request_id: string;
}

/**
 * Options for `runReviewGate`. All fields are required except `emit`.
 *
 * `invoke` is intentionally required (no default) so that nothing can
 * accidentally invoke the real Claude subprocess without an explicit
 * wiring decision. Callers that want the production dispatcher must
 * import and pass `createClaudeDispatcher()` from `invoke-reviewer.ts`.
 */
export interface RunReviewGateOpts {
  /** Absolute path to the repository root. */
  repoPath: string;
  /** Canonical request type: feature | bug | infra | refactor | hotfix. */
  requestType: string;
  /** Gate name, e.g. "code_review" or "spec_review". */
  gate: string;
  /**
   * Change-set context handed to every reviewer. The caller is responsible
   * for constructing this (including `isFrontendChange` via
   * `detectFrontendChanges()` if needed).
   */
  context: ChangeSetContext;
  /**
   * Required dispatcher. CLI passes `createClaudeDispatcher()`; tests pass
   * a deterministic mock.
   */
  invoke: InvokeReviewerFn;
  /**
   * Optional telemetry hook. Defaults to no-op if omitted. The production
   * CLI passes `emitReviewerInvocation` from `telemetry.ts`.
   */
  emit?: TelemetryEmitFn;
}

/**
 * Normalize a `GateVerdict` from the aggregator into a `GateDecision` by
 * adding the top-level `gate`, `requestType`, and flattened `results` fields.
 */
function toGateDecision(
  verdict: GateVerdict,
  requestType: string,
  results: ReviewerResult[],
): GateDecision {
  return {
    gate: verdict.gate,
    requestType,
    outcome: verdict.outcome,
    reason: verdict.reason,
    results,
    warnings: verdict.warnings,
    built_in_count_completed: verdict.built_in_count_completed,
    request_id: verdict.request_id,
  };
}

/**
 * Run all configured reviewers for a single gate and return a
 * `GateDecision` summarising the outcome.
 *
 * Steps:
 *   1. `resolveChain(repoPath, requestType, gate)` — load + filter the chain.
 *   2. If the chain is empty, return APPROVE with a note (no reviewers
 *      configured = pass, matching resolver semantics).
 *   3. `new ReviewerScheduler().schedule(chain, context)` — partition into
 *      concurrency groups.
 *   4. `new ReviewerRunner(invoke, emit).run(execution)` — run groups in
 *      order, capturing per-reviewer results.
 *   5. `new ScoreAggregator().aggregate(results, chain, metadata)` — roll
 *      results into a single `GateVerdict`.
 *   6. Wrap the verdict into a `GateDecision` and return.
 *
 * @throws `ChainConfigError` if the chain config cannot be loaded or parsed.
 *   All other errors are captured per-reviewer by the runner (verdict: ERROR).
 */
export async function runReviewGate(opts: RunReviewGateOpts): Promise<GateDecision> {
  const { repoPath, requestType, gate, context, invoke, emit } = opts;

  // Step 1: resolve chain.
  const chain = await resolveChain(repoPath, requestType, gate);

  // Step 2: empty-chain fast path.
  if (chain.length === 0) {
    return {
      gate,
      requestType,
      outcome: 'APPROVE',
      reason: `no reviewers configured for ${gate}`,
      results: [],
      warnings: [],
      built_in_count_completed: 0,
      request_id: context.requestId,
    };
  }

  // Step 3: schedule.
  const scheduler = new ReviewerScheduler();
  const execution = scheduler.schedule(chain, context);

  // Step 4: run.
  const runner = new ReviewerRunner(invoke, emit);
  const results = await runner.run(execution);

  // Step 5: aggregate.
  const aggregator = new ScoreAggregator();
  const verdict = aggregator.aggregate(results, chain, {
    gate,
    request_id: context.requestId,
  });

  // Step 6: wrap and return.
  return toGateDecision(verdict, requestType, results);
}
