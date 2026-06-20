/**
 * Unit tests for the PURE aggregation (#524). No daemon, no I/O — every
 * case feeds a synthetic RunResult[] and asserts the derived metrics that
 * make up the #532 acceptance signal.
 *
 * Coverage: all-pass, all-fail, mixed, single-task-flaky-across-repeats,
 * plus the numeric/histogram/phase-history helpers and empty edge cases.
 */

import {
  byTask,
  computeSummary,
  determinismByTask,
  histogram,
  isSuccess,
  numericStats,
  perPhaseFailureHistogram,
  summarizePhaseHistory,
} from '../aggregate';
import { fail, pass, phaseHistory, timeout } from './fixtures';

describe('isSuccess', () => {
  test('keys on status==done (currentPhase is monitor on a healthy run)', () => {
    expect(isSuccess(pass('t'))).toBe(true);
    expect(isSuccess(fail('t'))).toBe(false);
    expect(isSuccess(timeout('t'))).toBe(false);
  });
  test('a done status is a success even though terminalPhase is monitor, not done', () => {
    expect(pass('t').terminalPhase).toBe('monitor');
    expect(isSuccess(pass('t'))).toBe(true);
  });
});

describe('histogram', () => {
  test('tallies keys and preserves first-seen order', () => {
    expect(histogram(['a', 'b', 'a', 'c', 'b', 'a'])).toEqual({ a: 3, b: 2, c: 1 });
    expect(Object.keys(histogram(['z', 'a']))).toEqual(['z', 'a']);
  });
  test('empty input yields empty object', () => {
    expect(histogram([])).toEqual({});
  });
});

describe('numericStats', () => {
  test('empty sample is all zeros, not NaN', () => {
    expect(numericStats([])).toEqual({ count: 0, total: 0, mean: 0, min: 0, max: 0, p50: 0 });
  });
  test('computes min/mean/max/total/p50 (lower median)', () => {
    const s = numericStats([3, 1, 2]);
    expect(s).toMatchObject({ count: 3, total: 6, mean: 2, min: 1, max: 3, p50: 2 });
  });
  test('p50 lower-median for even-sized samples', () => {
    // sorted [1,2,3,4] -> ceil(0.5*4)-1 = 1 -> value 2
    expect(numericStats([4, 1, 3, 2]).p50).toBe(2);
  });
});

describe('determinismByTask', () => {
  test('1.0 for always-green, 0.0 for always-red', () => {
    const results = [pass('green'), pass('green'), fail('red'), fail('red')];
    expect(determinismByTask(results)).toEqual({ green: 1, red: 0 });
  });
  test('fractional for a task flaky across repeats', () => {
    const results = [pass('flaky', 1), fail('flaky', 2), pass('flaky', 3), fail('flaky', 4)];
    expect(determinismByTask(results).flaky).toBeCloseTo(0.5, 10);
  });
});

describe('byTask', () => {
  test('flags flaky strictly between 0 and 1; not flaky at the extremes', () => {
    const results = [
      pass('green'),
      fail('red'),
      pass('flaky', 1),
      fail('flaky', 2),
    ];
    const bt = byTask(results);
    expect(bt.green).toMatchObject({ runs: 1, successes: 1, successRate: 1, flaky: false });
    expect(bt.red).toMatchObject({ runs: 1, successes: 0, successRate: 0, flaky: false });
    expect(bt.flaky).toMatchObject({ runs: 2, successes: 1, flaky: true });
    expect(bt.flaky.successRate).toBeCloseTo(0.5, 10);
  });
});

describe('perPhaseFailureHistogram', () => {
  test('attributes each failure to its highest-retried phase', () => {
    const a = fail('a', 1, 'code', 3);
    const b = fail('b', 1, 'spec', 2);
    const c = { ...fail('c', 1, 'code', 1), perPhaseRetries: { spec: 1, code: 4 } };
    expect(perPhaseFailureHistogram([a, b, c])).toEqual({ code: 2, spec: 1 });
  });
  test('failing run with no retries buckets under <none>; successes ignored', () => {
    const noRetry = { ...fail('x'), perPhaseRetries: {}, totalRetries: 0 };
    expect(perPhaseFailureHistogram([noRetry, pass('ok')])).toEqual({ '<none>': 1 });
  });
});

describe('computeSummary — empty', () => {
  test('zero runs: successRate 0, empty histograms, zeroed stats', () => {
    const s = computeSummary([]);
    expect(s.totalRuns).toBe(0);
    expect(s.successRate).toBe(0);
    expect(s.byTerminalStatus).toEqual({});
    expect(s.perPhaseFailureHistogram).toEqual({});
    expect(s.totalCostUsd).toBe(0);
    expect(s.retryStats.count).toBe(0);
  });
});

describe('computeSummary — all pass', () => {
  test('successRate 1.0 and determinism 1.0 for every task', () => {
    const results = [pass('a', 1, 1.0), pass('a', 2, 1.0), pass('b', 1, 2.0)];
    const s = computeSummary(results);
    expect(s.successRate).toBe(1);
    expect(s.successCount).toBe(3);
    expect(s.byTerminalStatus).toEqual({ done: 3 });
    expect(s.byTerminalPhase).toEqual({ monitor: 3 });
    expect(s.perPhaseFailureHistogram).toEqual({});
    expect(s.determinismByTask).toEqual({ a: 1, b: 1 });
    expect(s.totalCostUsd).toBeCloseTo(4.0, 10);
  });
});

describe('computeSummary — all fail', () => {
  test('successRate 0.0, failures attributed by phase', () => {
    const results = [fail('a', 1, 'code', 3), fail('b', 1, 'integration', 2)];
    const s = computeSummary(results);
    expect(s.successRate).toBe(0);
    expect(s.successCount).toBe(0);
    expect(s.byTerminalStatus).toEqual({ failed: 2 });
    expect(s.perPhaseFailureHistogram).toEqual({ code: 1, integration: 1 });
    expect(s.determinismByTask).toEqual({ a: 0, b: 0 });
    expect(s.retryStats.total).toBe(5);
    expect(s.retryStats.max).toBe(3);
  });
});

describe('computeSummary — mixed (pass/fail/timeout)', () => {
  test('rate is successes / total across all outcome kinds', () => {
    const results = [pass('a'), fail('b', 1, 'code', 1), timeout('c')];
    const s = computeSummary(results);
    expect(s.totalRuns).toBe(3);
    expect(s.successCount).toBe(1);
    expect(s.successRate).toBeCloseTo(1 / 3, 10);
    expect(s.byTerminalStatus).toEqual({ done: 1, failed: 1, timeout: 1 });
    // timeout has no per-phase retries -> bucketed under <none>
    expect(s.perPhaseFailureHistogram).toEqual({ code: 1, '<none>': 1 });
  });
});

describe('computeSummary — single task flaky across repeats', () => {
  test('determinism + flaky flag surface the non-determinism', () => {
    const results = [
      pass('flaky', 1),
      fail('flaky', 2, 'code', 2),
      pass('flaky', 3),
      fail('flaky', 4, 'code', 1),
      pass('flaky', 5),
    ];
    const s = computeSummary(results);
    expect(s.successRate).toBeCloseTo(3 / 5, 10);
    expect(s.determinismByTask.flaky).toBeCloseTo(0.6, 10);
    expect(s.byTask.flaky.flaky).toBe(true);
    expect(s.perPhaseFailureHistogram).toEqual({ code: 2 });
  });
});

describe('summarizePhaseHistory', () => {
  test('rolls up per-phase retries, total retries, and cost', () => {
    const ph = phaseHistory([
      { state: 'prd', retry_count: 0, cost_usd: 0.4 },
      { state: 'code', retry_count: 2, cost_usd: 1.1 },
      { state: 'code_review', retry_count: 1, cost_usd: 0.3 },
    ]);
    const out = summarizePhaseHistory(ph);
    expect(out.perPhaseRetries).toEqual({ prd: 0, code: 2, code_review: 1 });
    expect(out.totalRetries).toBe(3);
    expect(out.costUsd).toBeCloseTo(1.8, 10);
  });
  test('sums retries when a phase repeats in history', () => {
    const ph = phaseHistory([
      { state: 'code', retry_count: 1 },
      { state: 'code', retry_count: 2 },
    ]);
    expect(summarizePhaseHistory(ph)).toMatchObject({
      perPhaseRetries: { code: 3 },
      totalRetries: 3,
    });
  });
  test('empty history is zeroed', () => {
    expect(summarizePhaseHistory([])).toEqual({
      perPhaseRetries: {},
      totalRetries: 0,
      costUsd: 0,
    });
  });
});
