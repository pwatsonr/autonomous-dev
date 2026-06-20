/**
 * Pure aggregation for the reliability harness (#524).
 *
 * Every function here is PURE: it takes an already-recorded `RunResult[]`
 * (or a slice of one) and returns derived metrics. No I/O, no clock, no
 * daemon. That is precisely what makes the success-rate / determinism
 * acceptance metric for the "road to 100%" epic (#532) unit-testable
 * without spending ~$3/~30min per live run.
 *
 * The single entry point is {@link computeSummary}; the helpers it composes
 * are exported too so tests can pin them individually.
 *
 * @module tools/reliability/aggregate
 */

import type { NumericStats, RunResult, Summary } from './types';

/**
 * A run counts as a success iff its terminal lifecycle status is 'done'.
 *
 * NOTE: 'done' is the `request status` `.status`, not the `.currentPhase`.
 * A healthy completed request reports `status: 'done'` while its
 * `currentPhase` is the LAST pipeline phase (`monitor`) — see the live
 * state.json shape. Keying success on `.currentPhase === 'done'` would be a
 * bug (it never equals 'done'), so we key on `.status` alone.
 */
export function isSuccess(r: RunResult): boolean {
  return r.status === 'done';
}

/**
 * Tally a list of string keys into a `{ key: count }` histogram.
 * Insertion order is preserved (first-seen-first), which keeps printed
 * tables stable for a given input ordering.
 */
export function histogram(keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) {
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * Compute min/mean/max/p50 over a numeric sample. Empty input yields all
 * zeros (count 0) rather than NaN so downstream JSON/printers stay clean.
 * p50 uses the lower-median convention (nearest-rank, sorted ascending).
 */
export function numericStats(values: number[]): NumericStats {
  const count = values.length;
  if (count === 0) {
    return { count: 0, total: 0, mean: 0, min: 0, max: 0, p50: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const total = sorted.reduce((acc, v) => acc + v, 0);
  // Nearest-rank lower median: index = ceil(0.5 * n) - 1.
  const p50Index = Math.ceil(0.5 * count) - 1;
  return {
    count,
    total,
    mean: total / count,
    min: sorted[0],
    max: sorted[count - 1],
    p50: sorted[p50Index],
  };
}

/**
 * Per-task success rate over that task's repeats. A value of 1.0 means the
 * task was green on every repeat (deterministic-green); a value strictly
 * between 0 and 1 means it was flaky across repeats.
 */
export function determinismByTask(results: RunResult[]): Record<string, number> {
  const runs: Record<string, number> = {};
  const ok: Record<string, number> = {};
  for (const r of results) {
    runs[r.taskId] = (runs[r.taskId] ?? 0) + 1;
    if (isSuccess(r)) ok[r.taskId] = (ok[r.taskId] ?? 0) + 1;
  }
  const out: Record<string, number> = {};
  for (const taskId of Object.keys(runs)) {
    out[taskId] = (ok[taskId] ?? 0) / runs[taskId];
  }
  return out;
}

/**
 * Per-task breakdown including a `flaky` flag (0 < rate < 1). A task that
 * never ran is absent; a task that ran but always failed has rate 0 and
 * flaky=false (deterministically-red, not flaky).
 */
export function byTask(results: RunResult[]): Summary['byTask'] {
  const acc: Summary['byTask'] = {};
  for (const r of results) {
    const entry = (acc[r.taskId] ??= {
      runs: 0,
      successes: 0,
      successRate: 0,
      flaky: false,
    });
    entry.runs += 1;
    if (isSuccess(r)) entry.successes += 1;
  }
  for (const id of Object.keys(acc)) {
    const e = acc[id];
    e.successRate = e.runs === 0 ? 0 : e.successes / e.runs;
    e.flaky = e.successRate > 0 && e.successRate < 1;
  }
  return acc;
}

/**
 * Among NON-successful runs, attribute each failure to the phase with the
 * highest retry count (the phase most implicated). Ties resolve to the
 * first phase encountered in `perPhaseRetries` insertion order. Failing
 * runs with no recorded retries are bucketed under '<none>'. Successful
 * runs are ignored entirely.
 */
export function perPhaseFailureHistogram(
  results: RunResult[],
): Record<string, number> {
  const culprits: string[] = [];
  for (const r of results) {
    if (isSuccess(r)) continue;
    let worstPhase = '<none>';
    let worstRetries = 0;
    for (const [phase, retries] of Object.entries(r.perPhaseRetries)) {
      if (retries > worstRetries) {
        worstRetries = retries;
        worstPhase = phase;
      }
    }
    culprits.push(worstPhase);
  }
  return histogram(culprits);
}

/**
 * The top-level summary: the acceptance metrics for #532. Pure — given the
 * same `results` array it always returns the same `Summary`.
 */
export function computeSummary(results: RunResult[]): Summary {
  const totalRuns = results.length;
  const successCount = results.filter(isSuccess).length;

  return {
    totalRuns,
    successCount,
    successRate: totalRuns === 0 ? 0 : successCount / totalRuns,
    byTerminalStatus: histogram(results.map((r) => r.status)),
    byTerminalPhase: histogram(results.map((r) => r.terminalPhase)),
    perPhaseFailureHistogram: perPhaseFailureHistogram(results),
    determinismByTask: determinismByTask(results),
    byTask: byTask(results),
    totalCostUsd: results.reduce((acc, r) => acc + (r.costUsd ?? 0), 0),
    retryStats: numericStats(results.map((r) => r.totalRetries ?? 0)),
    costStats: numericStats(results.map((r) => r.costUsd ?? 0)),
  };
}

/**
 * Derive per-phase retry totals and the rolled-up `totalRetries`/`costUsd`
 * for a single run from its `state.json` `phase_history`. Pure helper the
 * runner uses; kept here (next to the other pure logic) so it can be tested
 * without a live daemon.
 */
export function summarizePhaseHistory(
  phaseHistory: Array<{ state: string; retry_count?: number; cost_usd?: number }>,
): { perPhaseRetries: Record<string, number>; totalRetries: number; costUsd: number } {
  const perPhaseRetries: Record<string, number> = {};
  let totalRetries = 0;
  let costUsd = 0;
  for (const entry of phaseHistory) {
    const retries = entry.retry_count ?? 0;
    // A phase can appear more than once across the history; sum its retries.
    perPhaseRetries[entry.state] = (perPhaseRetries[entry.state] ?? 0) + retries;
    totalRetries += retries;
    costUsd += entry.cost_usd ?? 0;
  }
  return { perPhaseRetries, totalRetries, costUsd };
}
