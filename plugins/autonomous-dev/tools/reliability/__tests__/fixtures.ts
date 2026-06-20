/**
 * Shared synthetic-result factory for the reliability harness tests (#524).
 *
 * Builds {@link RunResult} records without touching a daemon, so the pure
 * aggregation and the dry-run wiring can be asserted deterministically.
 *
 * @module tools/reliability/__tests__/fixtures
 */

import type { PhaseHistoryEntry, RunResult, RunStatus } from '../types';

/** Build one RunResult, overriding any field. Defaults to a clean 'done'. */
export function makeResult(overrides: Partial<RunResult> = {}): RunResult {
  const base: RunResult = {
    taskId: 'task-a',
    sizeClass: 'small',
    repeat: 1,
    requestId: 'REQ-000001',
    status: 'done',
    terminalPhase: 'monitor',
    perPhaseRetries: {},
    totalRetries: 0,
    blocker: null,
    costUsd: 1.5,
    wallClockMs: 1000,
  };
  return { ...base, ...overrides };
}

/**
 * A clean successful run for `taskId` at the given `repeat`. Mirrors the live
 * pipeline: a 'done' status reports its last phase ('monitor') in
 * `terminalPhase`, NOT the literal string 'done'.
 */
export function pass(taskId: string, repeat = 1, costUsd = 1.0): RunResult {
  return makeResult({ taskId, repeat, status: 'done', terminalPhase: 'monitor', costUsd });
}

/**
 * A failing run for `taskId`, stalled at `phase` with `retries` retries on
 * that phase (so it shows up in the per-phase failure histogram).
 */
export function fail(
  taskId: string,
  repeat = 1,
  phase = 'code',
  retries = 3,
  costUsd = 2.0,
): RunResult {
  const perPhaseRetries: Record<string, number> = { [phase]: retries };
  return makeResult({
    taskId,
    repeat,
    status: 'failed',
    terminalPhase: phase,
    perPhaseRetries,
    totalRetries: retries,
    blocker: `stuck in ${phase}`,
    costUsd,
  });
}

/** A run that never reached a terminal status. */
export function timeout(taskId: string, repeat = 1): RunResult {
  return makeResult({
    taskId,
    repeat,
    status: 'timeout' as RunStatus,
    terminalPhase: 'code',
    blocker: 'poll timeout',
    costUsd: 0.5,
  });
}

/** Canonical phase_history matching the live state.json shape. */
export function phaseHistory(
  entries: Array<Partial<PhaseHistoryEntry> & { state: string }>,
): PhaseHistoryEntry[] {
  return entries.map((e) => ({
    state: e.state,
    retry_count: e.retry_count ?? 0,
    exit_reason: e.exit_reason ?? 'completed',
    cost_usd: e.cost_usd ?? 0,
  }));
}
