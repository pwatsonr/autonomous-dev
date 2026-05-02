/**
 * `autonomous-dev deploy estimate` CLI (SPEC-024-3-03, Task 9).
 *
 * Resolves the env's deploy spec, picks the backend's cost estimator,
 * and prints the estimate WITHOUT invoking `deploy()` and WITHOUT
 * touching the cost ledger. Two output modes:
 *   - default (table): backend name, env, total, confidence, then a
 *     row per breakdown line item; notes printed below.
 *   - `--json`:         single JSON object on stdout, no log lines.
 *
 * Exit codes:
 *   - 0 success
 *   - 2 missing env / unresolvable backend
 *   - 3 backend error during estimate
 *
 * @module intake/cli/deploy_estimate_command
 */

import type { CostEstimator, EstimateResult } from '../deploy/cost-estimation';

export interface DeployEstimateStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface DeployEstimateOptions {
  env: string;
  json?: boolean;
}

/**
 * Lookup contract for env → (backend, params, estimator). Tests inject a
 * fixture lookup; production code wires it to the existing config loader
 * + backend registry + per-cloud estimators (PLAN-023-2 surfaces).
 */
export interface DeployEstimateLookup {
  resolveEnv(env: string): Promise<
    | { ok: true; backend: string; params: unknown; estimator: CostEstimator<unknown> }
    | { ok: false; reason: string }
  >;
}

export async function runDeployEstimate(
  opts: DeployEstimateOptions,
  lookup: DeployEstimateLookup,
  streams: DeployEstimateStreams = {},
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const resolved = await lookup.resolveEnv(opts.env);
  if (!resolved.ok) {
    stderr.write(`env not found: ${opts.env} (${resolved.reason})\n`);
    return 2;
  }
  let estimate: EstimateResult;
  try {
    estimate = await resolved.estimator.estimateDeployCost(resolved.params);
  } catch (e) {
    stderr.write(`backend error during estimate: ${(e as Error).message}\n`);
    return 3;
  }
  if (opts.json) {
    stdout.write(
      JSON.stringify({ env: opts.env, backend: resolved.backend, ...estimate }) + '\n',
    );
    return 0;
  }
  // Table mode.
  stdout.write(`backend: ${resolved.backend}\n`);
  stdout.write(`env:     ${opts.env}\n`);
  stdout.write(`total:   $${estimate.estimated_cost_usd.toFixed(4)} ${estimate.currency}\n`);
  stdout.write(`confidence: ${estimate.confidence}\n`);
  stdout.write('breakdown:\n');
  for (const it of estimate.breakdown) {
    stdout.write(
      `  ${it.label.padEnd(36)} ${it.quantity.toFixed(6)} ${it.unit.padEnd(20)} ` +
        `@ $${it.unit_price_usd.toFixed(8)}/u = $${it.subtotal_usd.toFixed(6)}\n`,
    );
  }
  if (estimate.notes) {
    stdout.write(`notes: ${estimate.notes}\n`);
  }
  return 0;
}
