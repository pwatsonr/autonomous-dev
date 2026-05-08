/**
 * SPEC-032-1-01: orchestrator-side cost-cap helper memoization tests.
 *
 * Verifies the module-private `getOrCreateCostCapEnforcer(requestDir)`
 * helper returns the same `CostCapEnforcer` instance for identical
 * `requestDir` and a different instance for distinct values. The helper
 * itself is not exported; we exercise it via the
 * `__getOrCreateCostCapEnforcerForTest` escape hatch.
 *
 * SPEC-032-1-02 will add cutover-branching cases and SPEC-032-1-04 the
 * full integration matrix.
 *
 * @module tests/deploy/test-orchestrator-cost-cap.test
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  __getOrCreateCostCapEnforcerForTest,
  __resetCostCapEnforcerCacheForTest,
} from '../../intake/deploy/orchestrator';
import { CostCapEnforcer } from '../../intake/deploy/cost-cap-enforcer';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'orch-cost-cap-'));
}

describe('SPEC-032-1-01 getOrCreateCostCapEnforcer memoization', () => {
  beforeEach(() => {
    __resetCostCapEnforcerCacheForTest();
  });
  afterEach(() => {
    __resetCostCapEnforcerCacheForTest();
  });

  it('returns the same instance for the same requestDir', async () => {
    const dir = await tmp();
    try {
      const a = __getOrCreateCostCapEnforcerForTest(dir);
      const b = __getOrCreateCostCapEnforcerForTest(dir);
      expect(a).toBeInstanceOf(CostCapEnforcer);
      expect(a).toBe(b);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('returns distinct instances for distinct requestDirs', async () => {
    const dirA = await tmp();
    const dirB = await tmp();
    try {
      const a = __getOrCreateCostCapEnforcerForTest(dirA);
      const b = __getOrCreateCostCapEnforcerForTest(dirB);
      expect(a).not.toBe(b);
    } finally {
      await rm(dirA, { recursive: true, force: true });
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it('cache survives multiple synchronous calls in one block', async () => {
    const dir = await tmp();
    try {
      const refs = [
        __getOrCreateCostCapEnforcerForTest(dir),
        __getOrCreateCostCapEnforcerForTest(dir),
        __getOrCreateCostCapEnforcerForTest(dir),
      ];
      expect(refs[0]).toBe(refs[1]);
      expect(refs[1]).toBe(refs[2]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
