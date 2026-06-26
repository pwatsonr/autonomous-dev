/**
 * ONBOARD Phase 4 (#596) — a `WatchChecksClient` backed by the `gh` CLI.
 *
 * The stabilization watch (trigger_watch.ts) asks "is the PR HEAD branch's CI
 * green?". This wraps `gh pr checks <branch> --repo <repo> --json …` and
 * reduces the per-check buckets to one `WatchCheckStatus`. The `gh` invocation
 * is an INJECTED exec seam so the reducer (pure) and the client (fake exec) are
 * both unit-testable with no network.
 *
 * v1 sets only `state` (green/red/pending/unknown). `hasRevert` — the no-revert
 * reinforcement from OQ-1 — needs git-history analysis (a revert commit
 * referencing the change) and is a documented fast-follow; CI-green-for-N-days
 * is the primary signal and works without it.
 *
 * @module intake/triggers/checks_client
 */

import type { WatchCheckStatus, WatchChecksClient } from './trigger_watch';

/** A single check run as emitted by `gh pr checks --json bucket,state,name`. */
export interface CheckRun {
  bucket?: string;
  state?: string;
  conclusion?: string;
}

type Norm = 'pass' | 'fail' | 'pending' | 'skip' | 'unknown';

function normalizeRun(run: CheckRun): Norm {
  // Field precedence: `bucket` (gh's own rollup) is authoritative when present.
  // Without a bucket, a run is only conclusive once `state === 'completed'` AND
  // it carries a `conclusion`; a completed run with no conclusion is `unknown`
  // (NOT pass), and any non-completed `state` (in_progress/queued/…) is pending.
  // This stops a `{conclusion:'success', state:'in_progress'}` row from reading
  // green while CI is still running.
  const bucket = typeof run.bucket === 'string' ? run.bucket.trim() : '';
  let raw: string;
  if (bucket !== '') {
    raw = bucket;
  } else if (run.state === 'completed') {
    raw = run.conclusion ?? 'unknown';
  } else {
    raw = run.state ?? run.conclusion ?? '';
  }
  const v = raw.trim().toLowerCase();
  if (['pass', 'success', 'neutral'].includes(v)) return 'pass';
  if (['fail', 'failure', 'error', 'timed_out'].includes(v)) return 'fail';
  // `action_required` is awaiting manual approval (pending), not a failure.
  if (['pending', 'in_progress', 'queued', 'waiting', 'expected', 'action_required'].includes(v)) {
    return 'pending';
  }
  // A cancelled/skipped run is not a failure of the change → treat as skip.
  if (['skip', 'skipping', 'skipped', 'cancel', 'cancelled', 'canceling', 'stale'].includes(v)) {
    return 'skip';
  }
  return 'unknown';
}

/**
 * Reduce a list of check runs to an overall status:
 *   any fail → red; else any pending → pending; else all pass/skip → green;
 *   no checks → unknown (don't treat "no CI" as green — the watch falls back).
 */
export function reduceChecks(runs: CheckRun[]): WatchCheckStatus {
  // Drop null / non-object entries (a malformed gh row must not crash the map).
  const valid = runs.filter((r): r is CheckRun => typeof r === 'object' && r !== null);
  if (valid.length === 0) return { state: 'unknown' };
  const norm = valid.map(normalizeRun);
  if (norm.some((s) => s === 'fail')) return { state: 'red' };
  if (norm.some((s) => s === 'pending')) return { state: 'pending' };
  if (norm.every((s) => s === 'pass' || s === 'skip')) return { state: 'green' };
  return { state: 'unknown' };
}

/** Injected command runner: returns the gh JSON stdout + whether it exited 0. */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; ok: boolean }>;

/**
 * Build a `WatchChecksClient` that shells `gh`. Never throws — any failure
 * (gh missing, non-zero exit, unparseable JSON) yields `{ state: 'unknown' }`,
 * which the watch treats as "hold" (no streak change).
 */
export function ghChecksClient(exec: ExecFn): WatchChecksClient {
  return {
    async getStatus(repo: string, branch: string): Promise<WatchCheckStatus> {
      try {
        const { stdout, ok } = await exec('gh', [
          'pr',
          'checks',
          branch,
          '--repo',
          repo,
          '--json',
          'bucket,state,name',
        ]);
        if (!ok) return { state: 'unknown' };
        const parsed: unknown = JSON.parse(stdout);
        return reduceChecks(Array.isArray(parsed) ? (parsed as CheckRun[]) : []);
      } catch {
        return { state: 'unknown' };
      }
    },
  };
}
