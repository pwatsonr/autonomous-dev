/**
 * Public re-exports for the specialist reviewer suite runtime helpers
 * and the PLAN-020-2 reviewer-chain pipeline orchestrator.
 *
 * Consumers (eval runner, integration tests, future daemon
 * in-process gate evaluation) should import from this barrel rather
 * than the individual modules so the underlying file layout can move
 * without breaking call sites.
 *
 * @module intake/reviewers
 */

export * from './frontend-detection';
export * from './aggregate';

// PLAN-020-2: chain pipeline.
export * from './types';
export { ChainConfigError, loadChainConfig, resolveChain } from './chain-resolver';
export { ReviewerScheduler } from './scheduler';
export { ReviewerRunner } from './runner';
export type { InvokeReviewerFn, TelemetryEmitFn } from './runner';
export { ScoreAggregator } from './aggregator';
export type { AggregateMetadata } from './aggregator';
export {
  emitReviewerInvocation,
  setReviewerMetricsClient,
  getReviewerMetricsClient,
} from './telemetry';
export type {
  ReviewerInvocationLog,
  ReviewerMetricsClient,
} from './telemetry';
export { invokeReviewer, getRegisteredReviewerNames } from './invoke-reviewer';

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ChangeSetContext, GateVerdict } from './types';
import { resolveChain } from './chain-resolver';
import { ReviewerScheduler } from './scheduler';
import { ReviewerRunner, type InvokeReviewerFn } from './runner';
import { ScoreAggregator } from './aggregator';
import { emitReviewerInvocation } from './telemetry';
import { invokeReviewer as productionInvokeReviewer } from './invoke-reviewer';

/**
 * Inputs for `runReviewGate`. Mirrors SPEC-020-2-04 §Orchestrator.
 *
 * `invokeReviewer` and `stateDir` are exposed to allow tests and the
 * future daemon to inject custom dispatchers / state-file destinations.
 * Production wiring (CLI evaluator) supplies the production
 * `invokeReviewer` and the canonical state directory layout.
 */
export interface RunReviewGateInput {
  repoPath: string;
  requestType: string;
  gate: string;
  requestId: string;
  changedFiles: string[];
  isFrontendChange: boolean;
  /** Directory where `<gate>.json` will be written under `gates/`. */
  stateDir: string;
  /** Optional override of the production InvokeReviewerFn (tests). */
  invokeReviewer?: InvokeReviewerFn;
  /** Optional: skip writing the verdict file (tests / dry-runs). */
  writeVerdictFile?: boolean;
}

/**
 * End-to-end orchestrator for a single review gate. Pulls the chain
 * via the resolver, schedules invocations, runs them via the runner
 * (with telemetry), aggregates into a GateVerdict, writes the verdict
 * file, and returns the verdict.
 *
 * Centralizing this in `index.ts` (rather than in `bin/score-evaluator.sh`)
 * keeps the wiring testable and lets future callers (e.g., the daemon's
 * in-process gate evaluation in TDD-024) skip the shell layer entirely.
 */
export async function runReviewGate(input: RunReviewGateInput): Promise<GateVerdict> {
  const chain = await resolveChain(input.repoPath, input.requestType, input.gate);

  const context: ChangeSetContext = {
    repoPath: input.repoPath,
    changedFiles: input.changedFiles,
    requestId: input.requestId,
    gate: input.gate,
    requestType: input.requestType,
    isFrontendChange: input.isFrontendChange,
  };

  const scheduler = new ReviewerScheduler();
  const execution = scheduler.schedule(chain, context);

  const runner = new ReviewerRunner(
    input.invokeReviewer ?? productionInvokeReviewer,
    emitReviewerInvocation,
  );
  const results = await runner.run(execution);

  const aggregator = new ScoreAggregator();
  const verdict = aggregator.aggregate(results, chain, {
    gate: input.gate,
    request_id: input.requestId,
  });

  if (input.writeVerdictFile !== false) {
    const outPath = join(input.stateDir, 'gates', `${input.gate}.json`);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(verdict, null, 2), 'utf8');
  }

  return verdict;
}
