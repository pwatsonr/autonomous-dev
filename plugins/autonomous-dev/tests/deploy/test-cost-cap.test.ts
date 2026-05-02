/**
 * SPEC-023-2-04 cost-cap tests.
 *
 * @module tests/deploy/test-cost-cap.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __setCostCapDayForTest,
  checkCostCap,
  readTodayLedger,
  recordCost,
} from '../../intake/deploy/cost-cap';

const FIXED_DAY = '2026-05-02';

beforeEach(() => {
  __setCostCapDayForTest(() => FIXED_DAY);
});
afterEach(() => {
  __setCostCapDayForTest(null);
});

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cost-cap-'));
}

describe('SPEC-023-2-04 checkCostCap', () => {
  it('cap=0 always allowed', async () => {
    const dir = await tmp();
    try {
      const r = await checkCostCap({ requestDir: dir, envName: 'dev', capUsd: 0, estimatedUsd: 1_000 });
      expect(r.allowed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('single-deploy estimate exceeds cap -> rejected', async () => {
    const dir = await tmp();
    try {
      const r = await checkCostCap({ requestDir: dir, envName: 'staging', capUsd: 5, estimatedUsd: 6 });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toMatch(/single deploy/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('aggregate exceeds daily cap -> rejected', async () => {
    const dir = await tmp();
    try {
      await recordCost({ requestDir: dir, envName: 'staging', deployId: 'a', usd: 4 });
      const r = await checkCostCap({ requestDir: dir, envName: 'staging', capUsd: 10, estimatedUsd: 7 });
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason).toMatch(/daily cap/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('within budget -> allowed', async () => {
    const dir = await tmp();
    try {
      await recordCost({ requestDir: dir, envName: 'staging', deployId: 'a', usd: 4 });
      const r = await checkCostCap({ requestDir: dir, envName: 'staging', capUsd: 10, estimatedUsd: 5 });
      expect(r.allowed).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recordCost is idempotent on deployId', async () => {
    const dir = await tmp();
    try {
      await recordCost({ requestDir: dir, envName: 'staging', deployId: 'x', usd: 3 });
      await recordCost({ requestDir: dir, envName: 'staging', deployId: 'x', usd: 3 });
      const led = await readTodayLedger(dir, 'staging');
      expect(led.totalUsd).toBe(3);
      expect(led.entries).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('UTC day rollover archives old ledger and resets total', async () => {
    const dir = await tmp();
    try {
      __setCostCapDayForTest(() => '2026-05-01');
      await recordCost({ requestDir: dir, envName: 'prod', deployId: 'd1', usd: 10 });
      __setCostCapDayForTest(() => '2026-05-02');
      const r = await checkCostCap({ requestDir: dir, envName: 'prod', capUsd: 100, estimatedUsd: 1 });
      expect(r.allowed).toBe(true);
      expect(r.ledger.totalUsd).toBe(0);
      expect(r.ledger.dayUtc).toBe('2026-05-02');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
