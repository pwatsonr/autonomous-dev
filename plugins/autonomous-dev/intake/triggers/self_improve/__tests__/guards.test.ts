/**
 * T006 — Guard pipeline table-driven unit tests.
 */
import { evaluateGuards, computeBackoffUntil } from '../guards';
import type { GuardCtx } from '../guards';
import { readSelfImproveConfig } from '../config';
import type { LedgerReader } from '../ledger';

const DEFAULT_CFG = readSelfImproveConfig({ AUTONOMOUS_DEV_SELF_IMPROVE: '1' });
const NOW = Date.now();

function makeLedgerReader(overrides: Partial<LedgerReader> = {}): LedgerReader {
  return {
    getEntry: () => undefined,
    getInFlightAutoFixRequest: () => undefined,
    countActiveGlobal: () => 0,
    countActivePerRepo: () => 0,
    costLast24h: () => 0,
    costLast7d: () => 0,
    ...overrides,
  };
}

function baseCtx(overrides: Partial<GuardCtx> = {}): GuardCtx {
  return {
    env: DEFAULT_CFG,
    ownership: {
      repos: [{ repoId: 'owner/repo', path: '/repos/owner/repo', enrolled: true }],
    },
    ledger: makeLedgerReader(),
    issue: {
      repoId: 'owner/repo',
      number: 42,
      htmlUrl: 'https://github.com/owner/repo/issues/42',
      title: 'Test issue',
      body: '',
      labels: [],
      authorLogin: 'bot',
      updatedAt: '2026-07-01T00:00:00Z',
      fingerprint: null,
      reviewerBlockFp: null,
    },
    klass: 'A1',
    evidence: { ok: true },
    now: NOW,
    fnRegistry: new Set(),
    tickSubmittedSoFar: 0,
    concurrencyView: { activeGlobal: 0, activePerRepo: 0 },
    costWindow: { last24h: 0, last7d: 0 },
    ...overrides,
  };
}

describe('evaluateGuards', () => {
  it('T006-01: GD1 trips when enabled=false', () => {
    const cfg = readSelfImproveConfig({ AUTONOMOUS_DEV_SELF_IMPROVE: '0' });
    const ctx = baseCtx({ env: cfg });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD1');
  });

  it('T006-02: GD2 trips when repo not enrolled', () => {
    const ctx = baseCtx({
      ownership: { repos: [{ repoId: 'owner/repo', path: '/x', enrolled: false }] },
    });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD2');
  });

  it('T006-03: GD10 trips when klass===null', () => {
    const ctx = baseCtx({ klass: null });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD10');
  });

  it('T006-04: GD9 trips when fingerprint in registry', () => {
    const ctx = baseCtx({
      issue: { ...baseCtx().issue, fingerprint: 'abc123' },
      fnRegistry: new Set(['abc123']),
    });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD9');
  });

  it('T006-05: NA1 trips for A3 + in-progress label + addInProgressLabel=false', () => {
    const cfg = readSelfImproveConfig({
      AUTONOMOUS_DEV_SELF_IMPROVE: '1',
      AUTONOMOUS_DEV_SELF_IMPROVE_ADD_INPROGRESS_LABEL: '0',
    });
    const ctx = baseCtx({
      env: cfg,
      klass: 'A3',
      issue: { ...baseCtx().issue, labels: ['autodev:in-progress'] },
    });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('NA1');
  });

  it('T006-06: GD4 trips when activeGlobal >= max', () => {
    const ctx = baseCtx({
      concurrencyView: { activeGlobal: 2, activePerRepo: 0 },
    });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD4');
  });

  it('T006-07: GD5 trips when activePerRepo >= max', () => {
    const ctx = baseCtx({
      concurrencyView: { activeGlobal: 0, activePerRepo: 1 },
    });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD5');
  });

  it('T006-08: GD6 trips when last24h >= maxCostUsdPerDay', () => {
    const ctx = baseCtx({ costWindow: { last24h: 5.0, last7d: 0 } });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD6');
  });

  it('T006-09: GD7 trips when last7d >= maxCostUsdPerWeek', () => {
    const ctx = baseCtx({ costWindow: { last24h: 0, last7d: 25.0 } });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD7');
  });

  it('T006-10: NA3 trips when attempts >= maxAttemptsPerIssue', () => {
    const ledger = makeLedgerReader({
      getEntry: () => ({
        repoId: 'owner/repo',
        issueNumber: 42,
        issueFingerprint: null,
        requestIds: [],
        attempts: 3,
        lastAttemptAt: '2026-07-01T00:00:00Z',
        lastOutcome: 'failed',
        backoffUntil: null,
        status: 'idle',
      }),
    });
    const ctx = baseCtx({ ledger });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('NA3');
  });

  it('T006-11: NA4 trips when backoffUntil > now', () => {
    const futureBackoff = new Date(NOW + 3600_000).toISOString();
    const ledger = makeLedgerReader({
      getEntry: () => ({
        repoId: 'owner/repo',
        issueNumber: 42,
        issueFingerprint: null,
        requestIds: [],
        attempts: 1,
        lastAttemptAt: '2026-07-01T00:00:00Z',
        lastOutcome: 'failed',
        backoffUntil: futureBackoff,
        status: 'backoff',
      }),
    });
    const ctx = baseCtx({ ledger });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('NA4');
  });

  it('T006-12: NA2 trips when in-flight request exists', () => {
    const ledger = makeLedgerReader({
      getInFlightAutoFixRequest: () => 'REQ-000001',
    });
    const ctx = baseCtx({ ledger });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('NA2');
  });

  it('T006-13: GD11 trips when tickSubmittedSoFar >= maxIssuesPerTick', () => {
    const ctx = baseCtx({ tickSubmittedSoFar: 5 });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('GD11');
  });

  it('T006-14: NA7 trips when evidence.ok !== true', () => {
    const ctx = baseCtx({ evidence: { ok: false, reason: 'NA7_STATE_MISMATCH' } });
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.trip.guard).toBe('NA7');
  });

  it('T006-15: all pass → { ok: true }', () => {
    const ctx = baseCtx();
    const r = evaluateGuards(ctx);
    expect(r.ok).toBe(true);
  });
});

describe('computeBackoffUntil', () => {
  const T = 1_000_000;

  it('T006-16: attempts=1, base=60 → T + 60*60_000', () => {
    expect(computeBackoffUntil(1, T, 60)).toBe(T + 60 * 60_000);
  });

  it('T006-17: attempts=6, base=60 → capped at T + 24*60*60_000', () => {
    // 60 * 2^(6-1) = 60 * 32 = 1920 min > 1440 min cap → capped at 24 h
    expect(computeBackoffUntil(6, T, 60)).toBe(T + 24 * 60 * 60_000);
  });

  it('T006-18: attempts=0, base=60 → T + 60*60_000 (Math.max(0, -1)=0)', () => {
    expect(computeBackoffUntil(0, T, 60)).toBe(T + 60 * 60_000);
  });
});
