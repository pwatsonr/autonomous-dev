/**
 * Per-cloud cost-estimator unit tests (SPEC-024-3-04).
 *
 * Validates AWS / GCP / Azure / K8s heuristics, performance, and the
 * shared-invariants on `EstimateResult` (currency, breakdown sum, fixture
 * provenance).
 *
 * No real cloud SDK calls — every estimator is a pure heuristic.
 */

import { performance } from 'node:perf_hooks';

import { AwsCostEstimator } from '../../../autonomous-dev-deploy-aws/src/cost-estimator';
import { GcpCostEstimator } from '../../../autonomous-dev-deploy-gcp/src/cost-estimator';
import { AzureCostEstimator } from '../../../autonomous-dev-deploy-azure/src/cost-estimator';
import { K8sCostEstimator } from '../../../autonomous-dev-deploy-k8s/src/cost-estimator';
import { PRICING } from '../../intake/deploy/pricing-fixtures';
import { sumBreakdown } from '../../intake/deploy/cost-estimation';

describe('AwsCostEstimator', () => {
  const aws = new AwsCostEstimator();

  test('canonical scenario: 2 tasks × 0.5 vCPU × 1h matches the closed-form formula', async () => {
    const r = await aws.estimateDeployCost({
      tasks: 2,
      vcpu: 0.5,
      memory_gb: 1,
      vcpu_hours: 1,
      image_size_gb: 0.5,
      run_hours: 1,
    });
    const p = PRICING.aws;
    const expected =
      2 * 0.5 * 1.0 * p.fargate_vcpu_hour_usd +
      2 * 1.0 * 1.0 * p.fargate_gb_hour_usd +
      0.5 * p.ecr_storage_gb_month_usd * (1 / 730);
    expect(r.estimated_cost_usd).toBeCloseTo(expected, 4);
    expect(Math.abs(r.estimated_cost_usd - expected)).toBeLessThan(0.005);
    expect(r.confidence).toBe(0.85);
    expect(r.currency).toBe('USD');
  });

  test('zero tasks yields a zero estimate but a non-empty breakdown', async () => {
    const r = await aws.estimateDeployCost({
      tasks: 0,
      vcpu: 0.5,
      memory_gb: 1,
      vcpu_hours: 1,
      image_size_gb: 0.5,
      run_hours: 1,
    });
    expect(r.estimated_cost_usd).toBeGreaterThanOrEqual(0);
    // image storage is unrelated to tasks, so total may be > 0 but vcpu/mem rows must be 0.
    const fargateRows = r.breakdown.filter((b) => /Fargate/.test(b.label));
    for (const row of fargateRows) expect(row.subtotal_usd).toBe(0);
    expect(r.breakdown.length).toBeGreaterThan(0);
  });
});

describe('GcpCostEstimator', () => {
  const gcp = new GcpCostEstimator();

  test('1M requests with no compute time → exactly $0.40', async () => {
    const r = await gcp.estimateDeployCost({
      expected_requests: 1_000_000,
      vcpu: 0,
      vcpu_seconds: 0,
      gib: 0,
      gib_seconds: 0,
    });
    expect(r.estimated_cost_usd).toBeCloseTo(0.40, 6);
    expect(r.confidence).toBe(0.65);
  });

  test('zero requests → $0', async () => {
    const r = await gcp.estimateDeployCost({
      expected_requests: 0,
      vcpu: 0,
      vcpu_seconds: 0,
      gib: 0,
      gib_seconds: 0,
    });
    expect(r.estimated_cost_usd).toBe(0);
  });
});

describe('AzureCostEstimator', () => {
  const azure = new AzureCostEstimator();

  test('well-formed params produce a non-negative estimate at confidence 0.6', async () => {
    const r = await azure.estimateDeployCost({
      expected_requests: 500_000,
      vcpu: 1,
      vcpu_seconds: 3600,
      gib: 1,
      gib_seconds: 3600,
    });
    expect(r.estimated_cost_usd).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBe(0.6);
  });
});

describe('K8sCostEstimator', () => {
  const k8s = new K8sCostEstimator();

  test('always returns $0, confidence 0, empty breakdown, non-empty notes', async () => {
    const r = await k8s.estimateDeployCost({});
    expect(r.estimated_cost_usd).toBe(0);
    expect(r.confidence).toBe(0);
    expect(r.breakdown).toEqual([]);
    expect(r.notes && r.notes.length > 0).toBe(true);
  });
});

describe('Cross-backend invariants', () => {
  const estimators = [
    {
      name: 'aws',
      estimator: new AwsCostEstimator() as any,
      sample: { tasks: 1, vcpu: 1, memory_gb: 2, vcpu_hours: 24, image_size_gb: 0.3, run_hours: 24 },
    },
    {
      name: 'gcp',
      estimator: new GcpCostEstimator() as any,
      sample: { expected_requests: 5_000_000, vcpu: 1, vcpu_seconds: 3600, gib: 0.5, gib_seconds: 3600 },
    },
    {
      name: 'azure',
      estimator: new AzureCostEstimator() as any,
      sample: { expected_requests: 5_000_000, vcpu: 1, vcpu_seconds: 3600, gib: 0.5, gib_seconds: 3600 },
    },
    {
      name: 'k8s',
      estimator: new K8sCostEstimator() as any,
      sample: {},
    },
  ];

  test.each(estimators)('total of $name equals sum(breakdown.subtotal_usd)', async ({ estimator, sample }) => {
    const r = await estimator.estimateDeployCost(sample);
    expect(r.estimated_cost_usd).toBeCloseTo(sumBreakdown(r.breakdown), 9);
  });

  test.each(estimators)('currency of $name is USD', async ({ estimator, sample }) => {
    const r = await estimator.estimateDeployCost(sample);
    expect(r.currency).toBe('USD');
  });

  test('every backend averages <50ms over 100 iterations', async () => {
    for (const { name, estimator, sample } of estimators) {
      // warm-up
      await estimator.estimateDeployCost(sample);
      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        await estimator.estimateDeployCost(sample);
      }
      const avg = (performance.now() - start) / 100;
      // Generous bound to avoid CI flakiness while still catching pathological regressions.
      expect(avg).toBeLessThan(50);
      // Helpful trace if it ever fails.
      if (avg >= 50) {
        // eslint-disable-next-line no-console
        console.warn(`backend=${name} avg=${avg.toFixed(2)}ms`);
      }
    }
  });
});

describe('PRICING fixtures', () => {
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  const URL_RE = /^https?:\/\//;

  test('every cloud has source_url and captured_on', () => {
    for (const cloud of Object.keys(PRICING) as Array<keyof typeof PRICING>) {
      const fix = PRICING[cloud] as { source_url: string; captured_on: string };
      expect(typeof fix.source_url).toBe('string');
      expect(URL_RE.test(fix.source_url)).toBe(true);
      expect(ISO_DATE.test(fix.captured_on)).toBe(true);
    }
  });
});
