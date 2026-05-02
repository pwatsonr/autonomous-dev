/**
 * Glue between cost estimators and the deploy orchestrator
 * (SPEC-024-3-03 task 8).
 *
 * The orchestrator calls `runEstimateAndCapCheck` between "params resolved"
 * and "backend.deploy invoked": it computes the estimate, runs the cap
 * pre-check, and records the estimate in the cost ledger. A failed cap
 * pre-check throws `DeployRejectedError` with the env name, dollar amount,
 * cap, and confidence in the message — operators read this directly.
 *
 * @module intake/deploy/cost-estimate-wiring
 */

import type { CostEstimator, EstimateResult } from './cost-estimation';

/** Error thrown when the pre-deploy cap check fails. */
export class DeployRejectedError extends Error {
  readonly code = 'DEPLOY_REJECTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'DeployRejectedError';
  }
}

/** Cost ledger surface this module consumes (PLAN-023-3 contract). */
export interface CostLedger {
  checkCap(
    env: string,
    amountUsd: number,
  ): Promise<{
    ok: boolean;
    windowLabel: string;
    capUsd: number;
    currentUsd: number;
  }>;
  recordEstimate(entry: {
    env: string;
    backend: string;
    deploy_id: string;
    estimated_cost_usd: number;
    breakdown: EstimateResult['breakdown'];
    confidence: number;
    ts: number;
  }): Promise<void>;
}

export interface RunEstimateArgs<P> {
  env: string;
  backendName: string;
  deployId: string;
  params: P;
  estimator: CostEstimator<P>;
  ledger: CostLedger;
  /** Override clock for tests. */
  now?: () => number;
}

/**
 * Run the estimate + cap pre-check + ledger record. On rejection, throws
 * `DeployRejectedError` and does NOT record. On success, returns the
 * estimate so the caller can pass it on to telemetry.
 */
export async function runEstimateAndCapCheck<P>(
  args: RunEstimateArgs<P>,
): Promise<EstimateResult> {
  const estimate = await args.estimator.estimateDeployCost(args.params);
  const cap = await args.ledger.checkCap(args.env, estimate.estimated_cost_usd);
  if (!cap.ok) {
    throw new DeployRejectedError(
      `Deploy rejected for env=${args.env}: estimated $${estimate.estimated_cost_usd.toFixed(2)} would exceed ` +
        `${cap.windowLabel} cap of $${cap.capUsd.toFixed(2)} ` +
        `(current usage $${cap.currentUsd.toFixed(2)}, confidence ${estimate.confidence}).`,
    );
  }
  await args.ledger.recordEstimate({
    env: args.env,
    backend: args.backendName,
    deploy_id: args.deployId,
    estimated_cost_usd: estimate.estimated_cost_usd,
    breakdown: estimate.breakdown,
    confidence: estimate.confidence,
    ts: (args.now ?? Date.now)(),
  });
  return estimate;
}
