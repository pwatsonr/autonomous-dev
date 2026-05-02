/**
 * SPEC-023-3-04: HMAC-chained cost ledger tests.
 *
 * Covers genesis, sequential chain integrity, tamper detection, malformed
 * tail recovery, restart resume, aggregation by env/backend, recordActual
 * follow-ups, and the missing-key error path.
 *
 * @module tests/deploy/test-cost-ledger.test
 */

import { mkdtemp, rm, readFile, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CostLedger,
  computeHmac,
  computeWindow,
} from '../../intake/deploy/cost-ledger';
import {
  CostLedgerCorruptError,
  CostLedgerKeyMissingError,
} from '../../intake/deploy/errors';
import {
  GENESIS_PREV_HMAC,
  type CostLedgerEntry,
} from '../../intake/deploy/cost-ledger-types';
import { TEST_HMAC_KEY } from './fixtures/cost-ledger-fixtures';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cost-ledger-'));
}

function fixedClock(iso = '2026-05-02T12:00:00.000Z'): () => Date {
  return () => new Date(iso);
}

describe('SPEC-023-3-04 CostLedger', () => {
  it('genesis entry has prev_hmac of 64 zero hex chars and verifiable hmac', async () => {
    const dir = await tmp();
    try {
      const ledger = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      const entry = await ledger.appendEstimated({
        deployId: 'dep-0',
        env: 'prod',
        backend: 'static',
        estimated_cost_usd: 1.5,
      });
      expect(entry.prev_hmac).toBe(GENESIS_PREV_HMAC);
      expect(entry.prev_hmac).toMatch(/^0{64}$/);
      expect(entry.hmac).toMatch(/^[0-9a-f]{64}$/);
      const verified = await ledger.verify();
      expect(verified.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sequential append of N entries produces a valid HMAC chain', async () => {
    const dir = await tmp();
    try {
      const ledger = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      const N = 50; // smaller than 1000 to keep the test fast
      for (let i = 0; i < N; i++) {
        await ledger.appendEstimated({
          deployId: `dep-${i}`,
          env: i % 2 === 0 ? 'prod' : 'stage',
          backend: 'static',
          estimated_cost_usd: 0.5,
        });
      }
      const verified = await ledger.verify();
      expect(verified.ok).toBe(true);
      const entries = await ledger.readAll();
      expect(entries).toHaveLength(N);
      // Walk and re-verify hmacs manually.
      const key = Buffer.from(TEST_HMAC_KEY, 'hex');
      let prev = GENESIS_PREV_HMAC;
      for (const e of entries) {
        expect(e.prev_hmac).toBe(prev);
        const { hmac, ...rest } = e;
        const expected = computeHmac(key, prev, rest);
        expect(expected).toBe(hmac);
        prev = e.hmac;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tampered estimated_cost_usd is detected on next append', async () => {
    const dir = await tmp();
    try {
      const ledger = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      await ledger.appendEstimated({
        deployId: 'dep-0',
        env: 'prod',
        backend: 'static',
        estimated_cost_usd: 1.0,
      });
      // Read, mutate, write back.
      const path = join(dir, 'deploy-cost-ledger.jsonl');
      const text = await readFile(path, 'utf8');
      const entry = JSON.parse(text.trim()) as CostLedgerEntry;
      entry.estimated_cost_usd = 999.0;
      await writeFile(path, JSON.stringify(entry) + '\n', { encoding: 'utf8' });

      await expect(
        ledger.appendEstimated({
          deployId: 'dep-1',
          env: 'prod',
          backend: 'static',
          estimated_cost_usd: 1.0,
        }),
      ).rejects.toBeInstanceOf(CostLedgerCorruptError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('malformed trailing line: readAll skips silently; verify reports it', async () => {
    const dir = await tmp();
    try {
      const ledger = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      await ledger.appendEstimated({
        deployId: 'dep-0',
        env: 'prod',
        backend: 'static',
        estimated_cost_usd: 1.0,
      });
      const path = join(dir, 'deploy-cost-ledger.jsonl');
      // Append a partial line (mid-write crash simulation).
      await appendFile(path, '{"deployId":"d');
      const all = await ledger.readAll();
      expect(all).toHaveLength(1); // partial line is skipped
      const verified = await ledger.verify();
      expect(verified.ok).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('daemon restart resumes from last entry hmac', async () => {
    const dir = await tmp();
    try {
      const a = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      const first = await a.appendEstimated({
        deployId: 'dep-0',
        env: 'prod',
        backend: 'static',
        estimated_cost_usd: 1.0,
      });
      // Simulate restart: brand-new instance pointed at the same dir.
      const b = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      const second = await b.appendEstimated({
        deployId: 'dep-1',
        env: 'prod',
        backend: 'static',
        estimated_cost_usd: 1.0,
      });
      expect(second.prev_hmac).toBe(first.hmac);
      const verified = await b.verify();
      expect(verified.ok).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aggregate over day window returns correct totals + byEnv + byBackend', async () => {
    const dir = await tmp();
    try {
      const ledger = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      await ledger.appendEstimated({
        deployId: 'd1',
        env: 'prod',
        backend: 'static',
        estimated_cost_usd: 5.0,
      });
      await ledger.appendEstimated({
        deployId: 'd2',
        env: 'stage',
        backend: 'docker-local',
        estimated_cost_usd: 3.0,
      });
      const agg = await ledger.aggregate({
        window: 'day',
        asOf: new Date('2026-05-02T12:00:00.000Z'),
      });
      expect(agg.totalEstimated).toBeCloseTo(8.0);
      expect(agg.totalActual).toBe(0);
      expect(agg.openEstimates).toBeCloseTo(8.0);
      expect(agg.byEnv['prod']).toBeCloseTo(5.0);
      expect(agg.byEnv['stage']).toBeCloseTo(3.0);
      expect(agg.byBackend['static']).toBeCloseTo(5.0);
      expect(agg.byBackend['docker-local']).toBeCloseTo(3.0);
      expect(agg.entryCount).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recordActual appends follow-up; aggregate distinguishes estimated vs actual', async () => {
    const dir = await tmp();
    try {
      const ledger = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      await ledger.appendEstimated({
        deployId: 'd1',
        env: 'prod',
        backend: 'static',
        estimated_cost_usd: 5.0,
      });
      await ledger.recordActual('d1', 4.5);
      const agg = await ledger.aggregate({
        window: 'day',
        asOf: new Date('2026-05-02T12:00:00.000Z'),
      });
      expect(agg.totalEstimated).toBeCloseTo(5.0);
      expect(agg.totalActual).toBeCloseTo(4.5);
      // d1 was reconciled, so openEstimates should not include it.
      expect(agg.openEstimates).toBeCloseTo(0);
      expect(agg.entryCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('missing DEPLOY_COST_HMAC_KEY env throws CostLedgerKeyMissingError', async () => {
    const dir = await tmp();
    const prev = process.env.DEPLOY_COST_HMAC_KEY;
    delete process.env.DEPLOY_COST_HMAC_KEY;
    try {
      const ledger = new CostLedger({ dir, clock: fixedClock() });
      await expect(
        ledger.appendEstimated({
          deployId: 'd1',
          env: 'prod',
          backend: 'static',
          estimated_cost_usd: 1.0,
        }),
      ).rejects.toBeInstanceOf(CostLedgerKeyMissingError);
    } finally {
      if (prev !== undefined) process.env.DEPLOY_COST_HMAC_KEY = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recordActual with no prior entry throws', async () => {
    const dir = await tmp();
    try {
      const ledger = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      await expect(ledger.recordActual('nonexistent', 1.0)).rejects.toThrow(
        /no prior entry/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aggregate filters by env and backend', async () => {
    const dir = await tmp();
    try {
      const ledger = new CostLedger({
        dir,
        keyHex: TEST_HMAC_KEY,
        clock: fixedClock(),
      });
      await ledger.appendEstimated({
        deployId: 'd1',
        env: 'prod',
        backend: 'static',
        estimated_cost_usd: 5,
      });
      await ledger.appendEstimated({
        deployId: 'd2',
        env: 'stage',
        backend: 'static',
        estimated_cost_usd: 3,
      });
      const prodOnly = await ledger.aggregate({
        window: 'day',
        asOf: new Date('2026-05-02T12:00:00.000Z'),
        env: 'prod',
      });
      expect(prodOnly.totalEstimated).toBeCloseTo(5);
      expect(prodOnly.entryCount).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SPEC-023-3-04 computeWindow', () => {
  it('day window covers exactly 24h UTC', () => {
    const [start, end] = computeWindow(
      'day',
      new Date('2026-05-02T15:00:00.000Z'),
    );
    expect(end - start).toBe(24 * 60 * 60 * 1000);
    expect(new Date(start).toISOString()).toBe('2026-05-02T00:00:00.000Z');
  });

  it('month window covers the calendar month UTC', () => {
    const [start, end] = computeWindow(
      'month',
      new Date('2026-05-15T00:00:00.000Z'),
    );
    expect(new Date(start).toISOString()).toBe('2026-05-01T00:00:00.000Z');
    expect(new Date(end).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });
});
