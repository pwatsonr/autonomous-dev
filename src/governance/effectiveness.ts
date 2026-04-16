/**
 * Effectiveness evaluator (SPEC-007-5-2, Task 3).
 *
 * Measures whether a fix actually worked by comparing pre-fix and post-fix
 * metric averages via Prometheus. Classifies the result as improved, degraded,
 * unchanged, or pending.
 *
 * The evaluator runs after a cooldown period expires and the post-fix
 * measurement window has elapsed. It queries Prometheus for the target metric
 * in both the pre-fix and post-fix time windows, computes an improvement
 * percentage accounting for metric direction (decrease is good for error
 * rate/latency; increase is good for throughput), and classifies the result.
 */

import type {
  EffectivenessResult,
  EffectivenessDetail,
  EffectivenessCandidate,
  GovernanceConfig,
  DeploymentInfo,
  PrometheusClient,
  MetricDirection,
} from './types';

// ---------------------------------------------------------------------------
// Main evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluate the effectiveness of a fix by comparing pre-fix and post-fix
 * metric averages.
 *
 * Returns 'pending' if:
 *   - No linked deployment exists
 *   - The post-fix measurement window has not yet elapsed
 *   - Prometheus is unreachable
 *
 * Returns 'improved' if improvement_pct >= threshold (in the expected direction).
 * Returns 'degraded' if improvement_pct <= -threshold.
 * Returns 'unchanged' if -threshold < improvement_pct < threshold.
 */
export async function evaluateEffectiveness(
  observation: EffectivenessCandidate,
  config: GovernanceConfig,
  getDeployment: (deploymentId: string) => DeploymentInfo | null,
  prometheus: PrometheusClient,
  now?: Date,
): Promise<EffectivenessResult> {
  // Guard: already evaluated
  if (observation.effectiveness !== null && observation.effectiveness !== 'pending') {
    return {
      status: observation.effectiveness,
      reason: 'Already evaluated',
    };
  }

  // Guard: no linked deployment
  if (!observation.linked_deployment) {
    return {
      status: 'pending',
      reason: 'No linked deployment',
    };
  }

  const deployment = getDeployment(observation.linked_deployment);
  if (!deployment) {
    return {
      status: 'pending',
      reason: `Deployment ${observation.linked_deployment} not found`,
    };
  }

  const deployDate = new Date(deployment.deployed_at);
  const currentTime = now ?? new Date();

  // Compute time windows
  const preWindowStart = new Date(deployDate);
  preWindowStart.setDate(preWindowStart.getDate() - config.effectiveness_comparison_days);
  const preWindowEnd = deployDate;

  const postWindowStart = new Date(deployDate);
  postWindowStart.setDate(postWindowStart.getDate() + config.cooldown_days);
  const postWindowEnd = new Date(postWindowStart);
  postWindowEnd.setDate(postWindowEnd.getDate() + config.effectiveness_comparison_days);

  // Guard: post-fix window has not elapsed yet
  if (currentTime < postWindowEnd) {
    return {
      status: 'pending',
      reason: `Post-fix measurement window ends ${postWindowEnd.toISOString()}, not yet elapsed`,
    };
  }

  // Query Prometheus for both windows
  const stepSeconds = 300; // 5-minute resolution
  let preAvg: number | null;
  let postAvg: number | null;

  try {
    preAvg = await prometheus.queryRangeAverage(
      observation.target_metric,
      preWindowStart,
      preWindowEnd,
      stepSeconds,
    );
  } catch (err) {
    return {
      status: 'pending',
      reason: `Prometheus query failed for pre-fix window: ${err}`,
    };
  }

  try {
    postAvg = await prometheus.queryRangeAverage(
      observation.target_metric,
      postWindowStart,
      postWindowEnd,
      stepSeconds,
    );
  } catch (err) {
    return {
      status: 'pending',
      reason: `Prometheus query failed for post-fix window: ${err}`,
    };
  }

  // Guard: no data in either window
  if (preAvg === null || postAvg === null) {
    return {
      status: 'pending',
      reason: `Insufficient Prometheus data (pre: ${preAvg}, post: ${postAvg})`,
    };
  }

  // Compute improvement percentage
  const improvementPct = computeImprovement(
    observation.metric_direction,
    preAvg,
    postAvg,
  );

  const detail: EffectivenessDetail = {
    pre_fix_avg: round(preAvg, 2),
    post_fix_avg: round(postAvg, 2),
    improvement_pct: round(improvementPct, 1),
    measured_window: `${formatDate(postWindowStart)} to ${formatDate(postWindowEnd)}`,
  };

  // Classify
  const threshold = config.effectiveness_improvement_threshold;
  let status: 'improved' | 'unchanged' | 'degraded';

  if (improvementPct >= threshold) {
    status = 'improved';
  } else if (improvementPct <= -threshold) {
    status = 'degraded';
  } else {
    status = 'unchanged';
  }

  return { status, detail };
}

// ---------------------------------------------------------------------------
// Improvement computation
// ---------------------------------------------------------------------------

/**
 * Compute improvement percentage accounting for metric direction.
 *
 * For 'decrease' metrics (error rate, latency):
 *   improvement = ((pre - post) / |pre|) * 100
 *   Positive result = metric went down = good
 *
 * For 'increase' metrics (throughput):
 *   improvement = ((post - pre) / |pre|) * 100
 *   Positive result = metric went up = good
 *
 * If pre_avg is 0, avoids division by zero:
 *   - If post is also 0: return 0 (unchanged)
 *   - If post > 0 and direction is decrease: return -100 (degraded)
 *   - If post > 0 and direction is increase: return 100 (improved)
 */
export function computeImprovement(
  direction: MetricDirection,
  preAvg: number,
  postAvg: number,
): number {
  if (preAvg === 0) {
    if (postAvg === 0) return 0;
    if (direction === 'decrease') return postAvg > 0 ? -100 : 100;
    if (direction === 'increase') return postAvg > 0 ? 100 : -100;
  }

  if (direction === 'decrease') {
    return ((preAvg - postAvg) / Math.abs(preAvg)) * 100;
  } else {
    return ((postAvg - preAvg) / Math.abs(preAvg)) * 100;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}
