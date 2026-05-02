/**
 * `runEstimateAndCapCheck` orchestrator wiring tests (SPEC-024-3-04).
 *
 * Covers the pre-deploy estimate, cap pre-check, and ledger emission. No
 * cloud SDKs — the estimator and ledger are hand-rolled fakes.
 */

import {
  runEstimateAndCapCheck,
  DeployRejectedError,
  type CostLedger,
} from '../../intake/deploy/cost-estimate-wiring';
import type { CostEstimator, EstimateResult } from '../../intake/deploy/cost-estimation';

function mkEstimate(overrides: Partial<EstimateResult> = {}): EstimateResult {
  return {
    estimated_cost_usd: 50,
    currency: 'USD',
    breakdown: [
      { label: 'a', quantity: 1, unit: 'u', unit_price_usd: 50, subtotal_usd: 50 },
    ],
    confidence: 0.85,
    ...overrides,
  };
}

function mkEstimator(result: EstimateResult | Error): {
  estimator: CostEstimator<any>;
  calls: number;
} {
  let calls = 0;
  const estimator: CostEstimator<any> = {
    async estimateDeployCost(_p: any) {
      calls++;
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return {
    estimator,
    get calls() {
      return calls;
    },
  } as any;
}

function mkLedger(opts: {
  capOk: boolean;
  capUsd?: number;
  currentUsd?: number;
}): { ledger: CostLedger; recorded: any[]; capChecks: any[] } {
  const recorded: any[] = [];
  const capChecks: any[] = [];
  const ledger: CostLedger = {
    async checkCap(env, amount) {
      capChecks.push({ env, amount });
      return {
        ok: opts.capOk,
        windowLabel: 'daily',
        capUsd: opts.capUsd ?? 100,
        currentUsd: opts.currentUsd ?? 0,
      };
    },
    async recordEstimate(entry) {
      recorded.push(entry);
    },
  };
  return { ledger, recorded, capChecks };
}

describe('runEstimateAndCapCheck', () => {
  const baseArgs = {
    env: 'staging',
    backendName: 'aws',
    deployId: 'deploy-1',
    params: { tasks: 1 },
    now: () => 1_000_000,
  };

  test('proceeds when estimate < cap and records the estimate', async () => {
    const e = mkEstimator(mkEstimate({ estimated_cost_usd: 50 }));
    const l = mkLedger({ capOk: true, capUsd: 100, currentUsd: 0 });
    const r = await runEstimateAndCapCheck({ ...baseArgs, estimator: e.estimator, ledger: l.ledger });
    expect(r.estimated_cost_usd).toBe(50);
    expect(l.recorded).toHaveLength(1);
    expect(l.recorded[0]).toMatchObject({
      env: 'staging',
      backend: 'aws',
      deploy_id: 'deploy-1',
      estimated_cost_usd: 50,
      confidence: 0.85,
      ts: 1_000_000,
    });
    expect(l.recorded[0].breakdown).toEqual(r.breakdown);
  });

  test('throws DeployRejectedError when cap pre-check rejects, mentioning env, total, cap, confidence', async () => {
    const e = mkEstimator(mkEstimate({ estimated_cost_usd: 50, confidence: 0.85 }));
    const l = mkLedger({ capOk: false, capUsd: 40, currentUsd: 0 });
    await expect(
      runEstimateAndCapCheck({ ...baseArgs, estimator: e.estimator, ledger: l.ledger }),
    ).rejects.toBeInstanceOf(DeployRejectedError);
    try {
      await runEstimateAndCapCheck({ ...baseArgs, estimator: e.estimator, ledger: l.ledger });
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('staging');
      expect(msg).toContain('50');
      expect(msg).toContain('40');
      expect(msg).toContain('0.85');
    }
  });

  test('on cap rejection, recordEstimate is NOT invoked', async () => {
    const e = mkEstimator(mkEstimate({ estimated_cost_usd: 50 }));
    const l = mkLedger({ capOk: false, capUsd: 40 });
    await expect(
      runEstimateAndCapCheck({ ...baseArgs, estimator: e.estimator, ledger: l.ledger }),
    ).rejects.toBeInstanceOf(DeployRejectedError);
    expect(l.recorded).toHaveLength(0);
  });

  test('estimate is computed exactly once even on rejection', async () => {
    let calls = 0;
    const estimator: CostEstimator<any> = {
      async estimateDeployCost() {
        calls++;
        return mkEstimate({ estimated_cost_usd: 50 });
      },
    };
    const l = mkLedger({ capOk: false, capUsd: 40 });
    await expect(
      runEstimateAndCapCheck({ ...baseArgs, estimator, ledger: l.ledger }),
    ).rejects.toBeInstanceOf(DeployRejectedError);
    expect(calls).toBe(1);
  });

  test('estimator throwing propagates and skips cap check + ledger', async () => {
    const boom = new Error('quotas API down');
    const estimator: CostEstimator<any> = {
      async estimateDeployCost() {
        throw boom;
      },
    };
    const l = mkLedger({ capOk: true });
    await expect(
      runEstimateAndCapCheck({ ...baseArgs, estimator, ledger: l.ledger }),
    ).rejects.toBe(boom);
    expect(l.capChecks).toHaveLength(0);
    expect(l.recorded).toHaveLength(0);
  });

  test('payload to recordEstimate carries all required fields', async () => {
    const estimate = mkEstimate({
      estimated_cost_usd: 12.34,
      confidence: 0.42,
      breakdown: [
        { label: 'x', quantity: 2, unit: 'u', unit_price_usd: 6.17, subtotal_usd: 12.34 },
      ],
    });
    const e = mkEstimator(estimate);
    const l = mkLedger({ capOk: true });
    await runEstimateAndCapCheck({ ...baseArgs, estimator: e.estimator, ledger: l.ledger });
    const entry = l.recorded[0];
    expect(Object.keys(entry).sort()).toEqual(
      ['backend', 'breakdown', 'confidence', 'deploy_id', 'env', 'estimated_cost_usd', 'ts'].sort(),
    );
  });
});
