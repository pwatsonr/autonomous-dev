/**
 * ALB target-group health polling (SPEC-024-1-02 §"AWSBackend.healthCheck").
 *
 * Polls `describeTargetHealth` every 5s until either ALL targets report
 * `state: 'healthy'` AND target count >= `desiredCount`, or the
 * timeout fires. Returns a structured `PollAlbResult` shaped to map
 * directly to `HealthStatus`.
 *
 * @module @autonomous-dev/deploy-aws/health-checker
 */

import { mapAwsError } from './error-mapper';

/** Subset of ELBv2 `TargetHealthDescription`. */
export interface TargetHealthDescription {
  Target?: { Id?: string | null; Port?: number | null };
  TargetHealth?: {
    State?: 'initial' | 'healthy' | 'unhealthy' | 'unused' | 'draining' | 'unavailable' | string | null;
    Reason?: string | null;
    Description?: string | null;
  };
}

/** Structural subset of ELBv2 client. */
export interface ElbV2LikeClient {
  send(command: { __op: 'DescribeTargetHealth'; TargetGroupArn: string }): Promise<{
    TargetHealthDescriptions?: ReadonlyArray<TargetHealthDescription>;
  }>;
}

/** Options for `pollAlbHealth`. */
export interface PollAlbHealthOptions {
  client: ElbV2LikeClient;
  targetGroupArn: string;
  desiredCount: number;
  timeoutSeconds: number;
  /** Default 5_000. */
  intervalMs?: number;
  /** Cap on retained probe entries. Default `max(5, desiredCount)`. */
  maxChecks?: number;
  /** Test seam. */
  now?: () => number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

/** Single probe outcome. */
export interface AlbProbe {
  name: string;
  passed: boolean;
  message?: string;
}

/** Result of `pollAlbHealth`. */
export interface PollAlbResult {
  healthy: boolean;
  checks: AlbProbe[];
  unhealthyReason?: string;
}

export async function pollAlbHealth(opts: PollAlbHealthOptions): Promise<PollAlbResult> {
  const interval = opts.intervalMs ?? 5_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cap = opts.maxChecks ?? Math.max(5, opts.desiredCount);
  const deadline = now() + opts.timeoutSeconds * 1000;

  let lastProbes: AlbProbe[] = [];
  while (true) {
    let resp;
    try {
      resp = await opts.client.send({
        __op: 'DescribeTargetHealth',
        TargetGroupArn: opts.targetGroupArn,
      });
    } catch (err) {
      throw mapAwsError(err, 'ELBv2:DescribeTargetHealth');
    }
    const descriptions = resp.TargetHealthDescriptions ?? [];
    lastProbes = descriptions.slice(0, cap).map((d) => describeProbe(d));
    const healthyCount = descriptions.filter((d) => d.TargetHealth?.State === 'healthy').length;
    if (healthyCount >= opts.desiredCount && descriptions.length >= opts.desiredCount) {
      return { healthy: true, checks: lastProbes };
    }
    if (now() >= deadline) {
      const reason = describeUnhealthyReason(descriptions, opts.desiredCount, healthyCount);
      return { healthy: false, checks: lastProbes, unhealthyReason: reason };
    }
    await sleep(interval);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function describeProbe(d: TargetHealthDescription): AlbProbe {
  const id = d.Target?.Id ?? '<unknown-target>';
  const state = d.TargetHealth?.State ?? 'unknown';
  const reason = d.TargetHealth?.Reason ?? '';
  return {
    name: `target ${id}`,
    passed: state === 'healthy',
    message: reason ? `${state} (${reason})` : state,
  };
}

function describeUnhealthyReason(
  descriptions: ReadonlyArray<TargetHealthDescription>,
  desired: number,
  healthyCount: number,
): string {
  if (descriptions.length === 0) return 'no targets registered with target group';
  if (descriptions.length < desired) {
    return `only ${descriptions.length} of ${desired} targets registered`;
  }
  if (healthyCount === 0) {
    const firstReason = descriptions[0]?.TargetHealth?.Reason ?? descriptions[0]?.TargetHealth?.State ?? 'unknown';
    return `all targets unhealthy (first reason: ${firstReason})`;
  }
  return `${healthyCount} of ${desired} targets healthy`;
}
