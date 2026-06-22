/**
 * SPEC-032-1-03 cost-cap-shim contract tests.
 *
 * Verifies:
 *   - Once-per-process warning fires on the first shim call regardless
 *     of which entry point (FR-6, FR-7).
 *   - Subsequent shim calls in the same module-load do not re-warn.
 *   - Each `jest.isolateModules` block sees a fresh warned-Set.
 *   - Legacy `{ allowed, reason }` shape is preserved end-to-end.
 *   - `recordCost` is idempotent on `deployId`.
 *
 * @module tests/deploy/test-cost-cap-shim.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FIXED_DAY = '2026-05-02';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cost-cap-shim-'));
}

describe('SPEC-032-1-03 cost-cap-shim once-per-process warning', () => {
  it('emits the deprecation warning exactly once on first checkCostCap call', async () => {
    const dir = await tmp();
    try {
      await jest.isolateModulesAsync(async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const shim = await import('../../intake/deploy/cost-cap-shim');
        shim.__setCostCapDayForTest(() => FIXED_DAY);
        try {
          await shim.checkCostCap({
            requestDir: dir,
            envName: 'dev',
            capUsd: 0,
            estimatedUsd: 1,
          });
          await shim.checkCostCap({
            requestDir: dir,
            envName: 'dev',
            capUsd: 0,
            estimatedUsd: 1,
          });
          expect(warnSpy).toHaveBeenCalledTimes(1);
          expect(warnSpy).toHaveBeenCalledWith(shim.COST_CAP_SHIM_WARNING_TEXT);
        } finally {
          shim.__setCostCapDayForTest(null);
          warnSpy.mockRestore();
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('warns on first recordCost call when checkCostCap was not called yet', async () => {
    const dir = await tmp();
    try {
      await jest.isolateModulesAsync(async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const shim = await import('../../intake/deploy/cost-cap-shim');
        shim.__setCostCapDayForTest(() => FIXED_DAY);
        try {
          await shim.recordCost({
            requestDir: dir,
            envName: 'dev',
            deployId: 'a',
            usd: 1,
          });
          expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
          shim.__setCostCapDayForTest(null);
          warnSpy.mockRestore();
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('warns on first readTodayLedger call', async () => {
    const dir = await tmp();
    try {
      await jest.isolateModulesAsync(async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const shim = await import('../../intake/deploy/cost-cap-shim');
        shim.__setCostCapDayForTest(() => FIXED_DAY);
        try {
          await shim.readTodayLedger(dir, 'dev');
          expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
          shim.__setCostCapDayForTest(null);
          warnSpy.mockRestore();
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not re-warn across mixed shim calls in same module-load', async () => {
    const dir = await tmp();
    try {
      await jest.isolateModulesAsync(async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const shim = await import('../../intake/deploy/cost-cap-shim');
        shim.__setCostCapDayForTest(() => FIXED_DAY);
        try {
          await shim.checkCostCap({
            requestDir: dir,
            envName: 'dev',
            capUsd: 0,
            estimatedUsd: 0,
          });
          await shim.recordCost({
            requestDir: dir,
            envName: 'dev',
            deployId: 'b',
            usd: 1,
          });
          await shim.readTodayLedger(dir, 'dev');
          expect(warnSpy).toHaveBeenCalledTimes(1);
        } finally {
          shim.__setCostCapDayForTest(null);
          warnSpy.mockRestore();
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('SPEC-032-1-03 cost-cap-shim legacy-shape parity', () => {
  it('returns { allowed: true } when within cap', async () => {
    const dir = await tmp();
    try {
      await jest.isolateModulesAsync(async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const shim = await import('../../intake/deploy/cost-cap-shim');
        shim.__setCostCapDayForTest(() => FIXED_DAY);
        try {
          const r = await shim.checkCostCap({
            requestDir: dir,
            envName: 'dev',
            capUsd: 50,
            estimatedUsd: 30,
          });
          expect(r.allowed).toBe(true);
        } finally {
          shim.__setCostCapDayForTest(null);
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns { allowed: false, reason } when single deploy exceeds cap', async () => {
    const dir = await tmp();
    try {
      await jest.isolateModulesAsync(async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const shim = await import('../../intake/deploy/cost-cap-shim');
        shim.__setCostCapDayForTest(() => FIXED_DAY);
        try {
          const r = await shim.checkCostCap({
            requestDir: dir,
            envName: 'staging',
            capUsd: 5,
            estimatedUsd: 75,
          });
          expect(r.allowed).toBe(false);
          if (!r.allowed) {
            expect(r.reason).toMatch(/single deploy/);
          }
        } finally {
          shim.__setCostCapDayForTest(null);
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('recordCost is idempotent on deployId', async () => {
    const dir = await tmp();
    try {
      await jest.isolateModulesAsync(async () => {
        jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const shim = await import('../../intake/deploy/cost-cap-shim');
        shim.__setCostCapDayForTest(() => FIXED_DAY);
        try {
          await shim.recordCost({
            requestDir: dir,
            envName: 'dev',
            deployId: 'idem-1',
            usd: 5,
          });
          await shim.recordCost({
            requestDir: dir,
            envName: 'dev',
            deployId: 'idem-1',
            usd: 5,
          });
          const ledger = await shim.readTodayLedger(dir, 'dev');
          expect(ledger.entries).toHaveLength(1);
          expect(ledger.totalUsd).toBe(5);
        } finally {
          shim.__setCostCapDayForTest(null);
        }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
