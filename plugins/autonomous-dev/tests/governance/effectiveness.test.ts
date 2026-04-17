/**
 * Unit tests for the effectiveness evaluator (SPEC-007-5-2, Task 3).
 *
 * Covers all test cases TC-5-2-01 through TC-5-2-12, TC-5-2-18, TC-5-2-19.
 */

import {
  evaluateEffectiveness,
  computeImprovement,
} from '../../src/governance/effectiveness';
import type {
  EffectivenessCandidate,
  GovernanceConfig,
  DeploymentInfo,
  PrometheusClient,
  MetricDirection,
} from '../../src/governance/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<GovernanceConfig> = {}): GovernanceConfig {
  return {
    cooldown_days: 7,
    oscillation_window_days: 30,
    oscillation_threshold: 3,
    effectiveness_comparison_days: 7,
    effectiveness_improvement_threshold: 10,
    ...overrides,
  };
}

function makeObservation(
  overrides: Partial<EffectivenessCandidate> = {},
): EffectivenessCandidate {
  return {
    id: 'OBS-001',
    file_path: '/tmp/observations/OBS-001.md',
    linked_deployment: 'deploy-001',
    effectiveness: null,
    target_metric: 'rate(http_errors_total[5m])',
    metric_direction: 'decrease',
    service: 'api-gateway',
    ...overrides,
  };
}

function makeDeployment(
  overrides: Partial<DeploymentInfo> = {},
): DeploymentInfo {
  return {
    id: 'deploy-001',
    deployed_at: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function makePrometheus(
  preAvg: number | null,
  postAvg: number | null,
): PrometheusClient {
  let callCount = 0;
  return {
    async queryRangeAverage(): Promise<number | null> {
      callCount++;
      return callCount === 1 ? preAvg : postAvg;
    },
  };
}

function makeFailingPrometheus(
  failWindow: 'pre' | 'post',
): PrometheusClient {
  let callCount = 0;
  return {
    async queryRangeAverage(): Promise<number | null> {
      callCount++;
      if (
        (failWindow === 'pre' && callCount === 1) ||
        (failWindow === 'post' && callCount === 2)
      ) {
        throw new Error('Connection refused');
      }
      return 5.0;
    },
  };
}

/** A "now" date well after any post-fix window in default config.
 *  Deploy 2026-03-01 + 7 cooldown + 7 comparison = 2026-03-15.
 *  So 2026-04-01 is safely past.
 */
const NOW = new Date('2026-04-01T00:00:00Z');

// ---------------------------------------------------------------------------
// computeImprovement
// ---------------------------------------------------------------------------

describe('computeImprovement', () => {
  // TC-5-2-01: Error rate improved
  it('TC-5-2-01: error rate improved (decrease direction)', () => {
    const result = computeImprovement('decrease', 12.3, 0.6);
    // ((12.3 - 0.6) / 12.3) * 100 = 95.12...
    expect(result).toBeCloseTo(95.1, 0);
  });

  // TC-5-2-02: Error rate unchanged
  it('TC-5-2-02: error rate unchanged (decrease direction)', () => {
    const result = computeImprovement('decrease', 5.0, 5.1);
    // ((5.0 - 5.1) / 5.0) * 100 = -2.0
    expect(result).toBeCloseTo(-2.0, 1);
  });

  // TC-5-2-03: Error rate degraded
  it('TC-5-2-03: error rate degraded (decrease direction)', () => {
    const result = computeImprovement('decrease', 0.5, 3.0);
    // ((0.5 - 3.0) / 0.5) * 100 = -500.0
    expect(result).toBeCloseTo(-500.0, 1);
  });

  // TC-5-2-04: Latency improved
  it('TC-5-2-04: latency improved (decrease direction)', () => {
    const result = computeImprovement('decrease', 1200, 980);
    // ((1200 - 980) / 1200) * 100 = 18.333...
    expect(result).toBeCloseTo(18.3, 0);
  });

  // TC-5-2-05: Throughput improved
  it('TC-5-2-05: throughput improved (increase direction)', () => {
    const result = computeImprovement('increase', 500, 650);
    // ((650 - 500) / 500) * 100 = 30.0
    expect(result).toBeCloseTo(30.0, 1);
  });

  // TC-5-2-06: Throughput degraded
  it('TC-5-2-06: throughput degraded (increase direction)', () => {
    const result = computeImprovement('increase', 500, 400);
    // ((400 - 500) / 500) * 100 = -20.0
    expect(result).toBeCloseTo(-20.0, 1);
  });

  // TC-5-2-07: Zero pre-average, both zero
  it('TC-5-2-07: zero pre-average, both zero (decrease)', () => {
    const result = computeImprovement('decrease', 0, 0);
    expect(result).toBe(0);
  });

  // TC-5-2-08: Zero pre-average, nonzero post, decrease
  it('TC-5-2-08: zero pre-average, nonzero post (decrease)', () => {
    const result = computeImprovement('decrease', 0, 5.0);
    expect(result).toBe(-100);
  });

  it('zero pre-average, nonzero post (increase direction)', () => {
    const result = computeImprovement('increase', 0, 5.0);
    expect(result).toBe(100);
  });

  it('zero pre-average, negative post (decrease direction)', () => {
    const result = computeImprovement('decrease', 0, -1.0);
    expect(result).toBe(100);
  });

  it('zero pre-average, negative post (increase direction)', () => {
    const result = computeImprovement('increase', 0, -1.0);
    expect(result).toBe(-100);
  });
});

// ---------------------------------------------------------------------------
// evaluateEffectiveness
// ---------------------------------------------------------------------------

describe('evaluateEffectiveness', () => {
  const config = makeConfig();
  const deployment = makeDeployment();
  const getDeployment = (id: string) => (id === 'deploy-001' ? deployment : null);

  // TC-5-2-01: Error rate improved (full end-to-end)
  it('TC-5-2-01: classifies error rate improvement as improved', async () => {
    const observation = makeObservation({ metric_direction: 'decrease' });
    const prometheus = makePrometheus(12.3, 0.6);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('improved');
    expect(result.detail).toBeDefined();
    expect(result.detail!.improvement_pct).toBeCloseTo(95.1, 0);
    expect(result.detail!.pre_fix_avg).toBe(12.3);
    expect(result.detail!.post_fix_avg).toBe(0.6);
  });

  // TC-5-2-02: Error rate unchanged
  it('TC-5-2-02: classifies small error rate change as unchanged', async () => {
    const observation = makeObservation({ metric_direction: 'decrease' });
    const prometheus = makePrometheus(5.0, 5.1);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('unchanged');
    expect(result.detail!.improvement_pct).toBeCloseTo(-2.0, 1);
  });

  // TC-5-2-03: Error rate degraded
  it('TC-5-2-03: classifies large error rate increase as degraded', async () => {
    const observation = makeObservation({ metric_direction: 'decrease' });
    const prometheus = makePrometheus(0.5, 3.0);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('degraded');
    expect(result.detail!.improvement_pct).toBeCloseTo(-500.0, 1);
  });

  // TC-5-2-04: Latency improved
  it('TC-5-2-04: classifies latency decrease as improved', async () => {
    const observation = makeObservation({ metric_direction: 'decrease' });
    const prometheus = makePrometheus(1200, 980);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('improved');
    expect(result.detail!.improvement_pct).toBeCloseTo(18.3, 0);
  });

  // TC-5-2-05: Throughput improved
  it('TC-5-2-05: classifies throughput increase as improved', async () => {
    const observation = makeObservation({ metric_direction: 'increase' });
    const prometheus = makePrometheus(500, 650);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('improved');
    expect(result.detail!.improvement_pct).toBeCloseTo(30.0, 1);
  });

  // TC-5-2-06: Throughput degraded
  it('TC-5-2-06: classifies throughput decrease as degraded', async () => {
    const observation = makeObservation({ metric_direction: 'increase' });
    const prometheus = makePrometheus(500, 400);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('degraded');
    expect(result.detail!.improvement_pct).toBeCloseTo(-20.0, 1);
  });

  // TC-5-2-09: Pending -- no deployment
  it('TC-5-2-09: returns pending when no linked deployment', async () => {
    const observation = makeObservation({ linked_deployment: null });
    const prometheus = makePrometheus(1, 1);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('pending');
    expect(result.reason).toBe('No linked deployment');
  });

  it('returns pending when deployment ID is not found', async () => {
    const observation = makeObservation({ linked_deployment: 'deploy-999' });
    const prometheus = makePrometheus(1, 1);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('Deployment deploy-999 not found');
  });

  // TC-5-2-10: Pending -- window not elapsed
  it('TC-5-2-10: returns pending when post-fix window has not elapsed', async () => {
    // Deploy 5 days ago, cooldown=7, comparison=7 -> post window ends at day 14
    const recentDeployDate = new Date(NOW);
    recentDeployDate.setDate(recentDeployDate.getDate() - 5);
    const recentDeploy = makeDeployment({
      id: 'deploy-recent',
      deployed_at: recentDeployDate.toISOString(),
    });
    const getRecentDeploy = (id: string) => (id === 'deploy-recent' ? recentDeploy : null);
    const observation = makeObservation({ linked_deployment: 'deploy-recent' });
    const prometheus = makePrometheus(1, 1);
    const result = await evaluateEffectiveness(observation, config, getRecentDeploy, prometheus, NOW);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('not yet elapsed');
  });

  // TC-5-2-11: Pending -- Prometheus unreachable (pre-fix window)
  it('TC-5-2-11: returns pending when Prometheus fails on pre-fix query', async () => {
    const observation = makeObservation();
    const prometheus = makeFailingPrometheus('pre');
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('Prometheus query failed for pre-fix window');
  });

  // TC-5-2-11: Pending -- Prometheus unreachable (post-fix window)
  it('TC-5-2-11: returns pending when Prometheus fails on post-fix query', async () => {
    const observation = makeObservation();
    const prometheus = makeFailingPrometheus('post');
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('Prometheus query failed for post-fix window');
  });

  // TC-5-2-12: Pending -- no Prometheus data
  it('TC-5-2-12: returns pending when Prometheus returns null for pre', async () => {
    const observation = makeObservation();
    const prometheus = makePrometheus(null, 5.0);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('Insufficient Prometheus data');
  });

  it('TC-5-2-12: returns pending when Prometheus returns null for post', async () => {
    const observation = makeObservation();
    const prometheus = makePrometheus(5.0, null);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('pending');
    expect(result.reason).toContain('Insufficient Prometheus data');
  });

  // TC-5-2-18: At-threshold improvement
  it('TC-5-2-18: classifies at-threshold improvement as improved (>= comparison)', async () => {
    // Need improvement_pct = exactly 10.0 with threshold = 10
    // For decrease: ((pre - post) / |pre|) * 100 = 10
    // If pre = 100, post = 90: ((100-90)/100)*100 = 10.0
    const observation = makeObservation({ metric_direction: 'decrease' });
    const prometheus = makePrometheus(100, 90);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('improved');
    expect(result.detail!.improvement_pct).toBe(10.0);
  });

  // TC-5-2-19: At-threshold degradation
  it('TC-5-2-19: classifies at-threshold degradation as degraded (<= comparison)', async () => {
    // Need improvement_pct = exactly -10.0 with threshold = 10
    // For decrease: ((pre - post) / |pre|) * 100 = -10
    // If pre = 100, post = 110: ((100-110)/100)*100 = -10.0
    const observation = makeObservation({ metric_direction: 'decrease' });
    const prometheus = makePrometheus(100, 110);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('degraded');
    expect(result.detail!.improvement_pct).toBe(-10.0);
  });

  it('skips evaluation when effectiveness is already terminal', async () => {
    const observation = makeObservation({ effectiveness: 'improved' });
    const prometheus = makePrometheus(1, 1);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('improved');
    expect(result.reason).toBe('Already evaluated');
    expect(result.detail).toBeUndefined();
  });

  it('proceeds with evaluation when effectiveness is pending', async () => {
    const observation = makeObservation({ effectiveness: 'pending' });
    const prometheus = makePrometheus(10, 1);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.status).toBe('improved');
    expect(result.detail).toBeDefined();
  });

  it('includes measured_window in detail', async () => {
    const observation = makeObservation();
    const prometheus = makePrometheus(10, 5);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.detail!.measured_window).toMatch(/^\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/);
  });

  it('computes pre-fix window as [deploy_date - comparison_days, deploy_date]', async () => {
    const calls: { start: Date; end: Date }[] = [];
    const prometheus: PrometheusClient = {
      async queryRangeAverage(_q: string, start: Date, end: Date): Promise<number | null> {
        calls.push({ start, end });
        return 5.0;
      },
    };
    const observation = makeObservation();
    await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);

    // Pre-fix window: [2026-02-22, 2026-03-01]
    const deployDate = new Date('2026-03-01T00:00:00Z');
    const expectedPreStart = new Date(deployDate);
    expectedPreStart.setDate(expectedPreStart.getDate() - 7);

    expect(calls[0].start.toISOString()).toBe(expectedPreStart.toISOString());
    expect(calls[0].end.toISOString()).toBe(deployDate.toISOString());
  });

  it('computes post-fix window as [deploy_date + cooldown, deploy_date + cooldown + comparison]', async () => {
    const calls: { start: Date; end: Date }[] = [];
    const prometheus: PrometheusClient = {
      async queryRangeAverage(_q: string, start: Date, end: Date): Promise<number | null> {
        calls.push({ start, end });
        return 5.0;
      },
    };
    const observation = makeObservation();
    await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);

    // Post-fix window: [2026-03-08, 2026-03-15]
    const deployDate = new Date('2026-03-01T00:00:00Z');
    const expectedPostStart = new Date(deployDate);
    expectedPostStart.setDate(expectedPostStart.getDate() + 7);
    const expectedPostEnd = new Date(expectedPostStart);
    expectedPostEnd.setDate(expectedPostEnd.getDate() + 7);

    expect(calls[1].start.toISOString()).toBe(expectedPostStart.toISOString());
    expect(calls[1].end.toISOString()).toBe(expectedPostEnd.toISOString());
  });

  it('uses 300-second step resolution for Prometheus queries', async () => {
    let capturedStep = 0;
    const prometheus: PrometheusClient = {
      async queryRangeAverage(_q: string, _s: Date, _e: Date, step: number): Promise<number | null> {
        capturedStep = step;
        return 5.0;
      },
    };
    const observation = makeObservation();
    await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(capturedStep).toBe(300);
  });

  it('rounds detail values appropriately', async () => {
    const observation = makeObservation({ metric_direction: 'decrease' });
    // pre=12.345, post=0.678 -> improvement = ((12.345 - 0.678) / 12.345) * 100 = 94.508...
    const prometheus = makePrometheus(12.345, 0.678);
    const result = await evaluateEffectiveness(observation, config, getDeployment, prometheus, NOW);
    expect(result.detail!.pre_fix_avg).toBe(12.35); // rounded to 2 decimal places
    expect(result.detail!.post_fix_avg).toBe(0.68);  // rounded to 2 decimal places
    // improvement_pct rounded to 1 decimal place
    expect(typeof result.detail!.improvement_pct).toBe('number');
  });
});
