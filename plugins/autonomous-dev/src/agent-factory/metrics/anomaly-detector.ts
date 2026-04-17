/**
 * Anomaly detection rules and alert management (SPEC-005-2-3, Tasks 6 & 7).
 *
 * Implements 6 anomaly detection rules that evaluate agent health after each
 * invocation, plus alert lifecycle management including deduplication,
 * auto-resolution, acknowledgment, and recurrence handling.
 */

import * as crypto from 'crypto';

import type {
  InvocationMetric,
  AlertRecord,
  AlertSeverity,
  AggregateSnapshot,
} from './types';
import type { SqliteStore } from './sqlite-store';

// ---------------------------------------------------------------------------
// Threshold configuration
// ---------------------------------------------------------------------------

export interface AnomalyThresholds {
  /** Minimum acceptable 30-day approval rate (default 0.70). */
  approvalRateDrop: number;
  /** Quality score decline in points below 30-day average (default 0.5). */
  qualityDeclinePoints: number;
  /** Number of recent invocations used for quality decline window (default 10). */
  qualityDeclineWindow: number;
  /** Maximum acceptable rejection rate over 30 days (default 0.30). */
  escalationRate: number;
  /** Multiplier over 30-day average token usage (default 2.0). */
  tokenBudgetMultiplier: number;
}

export const DEFAULT_THRESHOLDS: AnomalyThresholds = {
  approvalRateDrop: 0.70,
  qualityDeclinePoints: 0.5,
  qualityDeclineWindow: 10,
  escalationRate: 0.30,
  tokenBudgetMultiplier: 2.0,
};

// ---------------------------------------------------------------------------
// Rule interfaces
// ---------------------------------------------------------------------------

/** Result produced by a rule when an anomaly condition is met. */
export interface AnomalyFinding {
  ruleId: string;
  severity: AlertSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

/** A single anomaly detection rule. */
export interface AnomalyRule {
  id: string;
  name: string;
  severity: AlertSeverity;
  evaluate(
    agentName: string,
    metrics: InvocationMetric[],
    aggregate: AnomalyAggregateContext,
    config: AnomalyThresholds,
  ): AnomalyFinding | null;
}

/**
 * Aggregate metrics context supplied to each rule.
 *
 * The current and previous aggregate snapshots are provided so rules like
 * trend reversal can compare across snapshots.
 */
export interface AnomalyAggregateContext {
  current: AggregateSnapshot | null;
  previous: AggregateSnapshot | null;
}

// ---------------------------------------------------------------------------
// Consecutive-good check helpers (per-rule "good" definitions)
// ---------------------------------------------------------------------------

/** Number of consecutive good invocations required for auto-resolution. */
const AUTO_RESOLVE_COUNT = 5;

/**
 * Per-rule predicate that determines whether a single invocation is "good"
 * relative to the alert's rule.  Used by auto-resolution logic.
 */
type GoodPredicate = (
  metric: InvocationMetric,
  context: {
    overallAvg: number;
    qualityDeclinePoints: number;
    p95ReviewIterations: number;
    avgTokens: number;
    tokenMultiplier: number;
    trendDirection: string | null;
  },
) => boolean;

const GOOD_PREDICATES: Record<string, GoodPredicate> = {
  ANOMALY_001_APPROVAL_RATE_DROP: (m) => m.review_outcome === 'approved',
  ANOMALY_002_QUALITY_DECLINE: (m, ctx) =>
    m.output_quality_score >= ctx.overallAvg - ctx.qualityDeclinePoints,
  ANOMALY_003_REVIEW_ITERATION_SPIKE: (m, ctx) =>
    m.review_iteration_count < ctx.p95ReviewIterations,
  ANOMALY_004_ESCALATION_RATE: (m) => m.review_outcome !== 'rejected',
  ANOMALY_005_TREND_REVERSAL: (_m, ctx) => ctx.trendDirection !== 'declining',
  ANOMALY_006_TOKEN_BUDGET: (m, ctx) =>
    m.input_tokens + m.output_tokens <= ctx.avgTokens * ctx.tokenMultiplier,
};

// ---------------------------------------------------------------------------
// Rule implementations
// ---------------------------------------------------------------------------

/**
 * Rule 1: Approval Rate Drop (CRITICAL)
 *
 * Fires when the rolling 30-day approval rate drops below threshold.
 */
const approvalRateDropRule: AnomalyRule = {
  id: 'ANOMALY_001_APPROVAL_RATE_DROP',
  name: 'Approval Rate Drop',
  severity: 'critical',
  evaluate(agentName, metrics, _aggregate, config) {
    if (metrics.length === 0) return null;

    const approved = metrics.filter(
      (m) => m.review_outcome === 'approved',
    ).length;
    const rate = approved / metrics.length;

    if (rate < config.approvalRateDrop) {
      return {
        ruleId: this.id,
        severity: this.severity,
        message: `Approval rate for '${agentName}' is ${rate.toFixed(2)} (below threshold ${config.approvalRateDrop})`,
        evidence: {
          current_rate: round(rate, 4),
          threshold: config.approvalRateDrop,
          invocation_count: metrics.length,
        },
      };
    }
    return null;
  },
};

/**
 * Rule 2: Quality Score Decline (WARNING)
 *
 * Fires when the average quality score over the last N invocations is more
 * than X points below the 30-day average.
 */
const qualityDeclineRule: AnomalyRule = {
  id: 'ANOMALY_002_QUALITY_DECLINE',
  name: 'Quality Score Decline',
  severity: 'warning',
  evaluate(agentName, metrics, aggregate, config) {
    if (metrics.length === 0) return null;
    if (!aggregate.current) return null;

    const overallAvg = aggregate.current.avg_quality_score;
    const windowSize = Math.min(config.qualityDeclineWindow, metrics.length);

    // metrics are ordered DESC by timestamp; take the most recent N
    const recentMetrics = metrics.slice(0, windowSize);
    const recentAvg =
      recentMetrics.reduce((sum, m) => sum + m.output_quality_score, 0) /
      recentMetrics.length;

    const decline = overallAvg - recentAvg;

    if (decline > config.qualityDeclinePoints) {
      return {
        ruleId: this.id,
        severity: this.severity,
        message: `Quality score for '${agentName}' declined by ${decline.toFixed(2)} points over last ${windowSize} invocations`,
        evidence: {
          recent_avg: round(recentAvg, 4),
          overall_avg: round(overallAvg, 4),
          decline_points: round(decline, 4),
          window_size: windowSize,
        },
      };
    }
    return null;
  },
};

/**
 * Rule 3: Review Iteration Spike (WARNING)
 *
 * Fires when the last 3 consecutive invocations have review_iteration_count
 * at or above the p95 of all historical review iterations.
 */
const reviewIterationSpikeRule: AnomalyRule = {
  id: 'ANOMALY_003_REVIEW_ITERATION_SPIKE',
  name: 'Review Iteration Spike',
  severity: 'warning',
  evaluate(agentName, metrics, _aggregate, _config) {
    // Need at least 10 total invocations for reliable p95
    if (metrics.length < 10) return null;

    const allIterations = metrics
      .map((m) => m.review_iteration_count)
      .sort((a, b) => a - b);
    const p95 = percentile(allIterations, 95);

    // metrics are ordered DESC by timestamp; last 3 = first 3 in array
    const last3 = metrics.slice(0, 3);
    if (last3.length < 3) return null;

    const allAtOrAboveP95 = last3.every(
      (m) => m.review_iteration_count >= p95,
    );

    if (allAtOrAboveP95) {
      return {
        ruleId: this.id,
        severity: this.severity,
        message: `Review iterations for '${agentName}' spiked: last 3 invocations at ${JSON.stringify(last3.map((m) => m.review_iteration_count))} (p95 = ${p95})`,
        evidence: {
          last_3_iterations: last3.map((m) => m.review_iteration_count),
          p95_threshold: p95,
        },
      };
    }
    return null;
  },
};

/**
 * Rule 4: Escalation Rate Exceeded (CRITICAL)
 *
 * Fires when the rate of rejected invocations in the last 30 days exceeds
 * the configured threshold.
 */
const escalationRateRule: AnomalyRule = {
  id: 'ANOMALY_004_ESCALATION_RATE',
  name: 'Escalation Rate Exceeded',
  severity: 'critical',
  evaluate(agentName, metrics, _aggregate, config) {
    if (metrics.length === 0) return null;

    const rejected = metrics.filter(
      (m) => m.review_outcome === 'rejected',
    ).length;
    const rate = rejected / metrics.length;

    if (rate > config.escalationRate) {
      return {
        ruleId: this.id,
        severity: this.severity,
        message: `Escalation rate for '${agentName}' is ${rate.toFixed(2)} (threshold ${config.escalationRate})`,
        evidence: {
          rejection_rate: round(rate, 4),
          threshold: config.escalationRate,
          rejected_count: rejected,
          total_count: metrics.length,
        },
      };
    }
    return null;
  },
};

/**
 * Rule 5: Trend Reversal (WARNING)
 *
 * Fires when the trend direction changes from 'improving' to 'declining'
 * between the previous and current aggregate snapshot.
 */
const trendReversalRule: AnomalyRule = {
  id: 'ANOMALY_005_TREND_REVERSAL',
  name: 'Trend Reversal',
  severity: 'warning',
  evaluate(agentName, _metrics, aggregate, _config) {
    if (!aggregate.current || !aggregate.previous) return null;

    const prev = aggregate.previous.trend_direction;
    const curr = aggregate.current.trend_direction;

    if (prev === 'improving' && curr === 'declining') {
      return {
        ruleId: this.id,
        severity: this.severity,
        message: `Trend reversal detected for '${agentName}': was ${prev}, now ${curr}`,
        evidence: {
          previous_direction: prev,
          current_direction: curr,
          previous_slope: aggregate.previous.trend_slope,
          current_slope: aggregate.current.trend_slope,
        },
      };
    }
    return null;
  },
};

/**
 * Rule 6: Token Budget Exceeded (INFO)
 *
 * Fires when the last invocation's total tokens exceed N times the 30-day
 * average total tokens per invocation.
 */
const tokenBudgetRule: AnomalyRule = {
  id: 'ANOMALY_006_TOKEN_BUDGET',
  name: 'Token Budget Exceeded',
  severity: 'info',
  evaluate(agentName, metrics, aggregate, config) {
    if (metrics.length === 0) return null;
    if (!aggregate.current) return null;
    if (aggregate.current.invocation_count === 0) return null;

    const lastMetric = metrics[0]; // most recent (DESC order)
    const invocationTokens = lastMetric.input_tokens + lastMetric.output_tokens;
    const avgTokens =
      aggregate.current.total_tokens / aggregate.current.invocation_count;
    const budget = avgTokens * config.tokenBudgetMultiplier;

    if (invocationTokens > budget) {
      return {
        ruleId: this.id,
        severity: this.severity,
        message: `Token usage for '${agentName}' last invocation (${invocationTokens}) exceeded ${config.tokenBudgetMultiplier}x average (${Math.round(avgTokens)})`,
        evidence: {
          invocation_tokens: invocationTokens,
          avg_tokens: round(avgTokens, 2),
          multiplier: config.tokenBudgetMultiplier,
        },
      };
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Exported rule set
// ---------------------------------------------------------------------------

/** All 6 anomaly detection rules, exported for introspection and testing. */
export const ANOMALY_RULES: AnomalyRule[] = [
  approvalRateDropRule,
  qualityDeclineRule,
  reviewIterationSpikeRule,
  escalationRateRule,
  trendReversalRule,
  tokenBudgetRule,
];

// ---------------------------------------------------------------------------
// AnomalyDetector
// ---------------------------------------------------------------------------

export class AnomalyDetector {
  private readonly store: SqliteStore;
  private readonly thresholds: AnomalyThresholds;

  constructor(store: SqliteStore, thresholds?: Partial<AnomalyThresholds>) {
    this.store = store;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  // -----------------------------------------------------------------------
  // Core evaluation
  // -----------------------------------------------------------------------

  /**
   * Evaluate all anomaly rules for the given agent.
   *
   * 1. Fetches 30-day invocations and aggregate snapshots from the store.
   * 2. Runs each rule against the data.
   * 3. Deduplicates: if an active alert already exists for the same
   *    agent + rule, the existing alert is returned instead of a new one.
   * 4. Persists any newly created alerts to the store.
   *
   * Returns all alerts produced (both existing and newly created).
   */
  evaluate(agentName: string): AlertRecord[] {
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const metrics = this.store.getInvocations(agentName, {
      since: thirtyDaysAgo,
    });

    const aggregateContext = this.buildAggregateContext(agentName);
    const alerts: AlertRecord[] = [];

    for (const rule of ANOMALY_RULES) {
      const finding = rule.evaluate(
        agentName,
        metrics,
        aggregateContext,
        this.thresholds,
      );

      if (finding) {
        const alert = this.deduplicateOrCreate(agentName, finding);
        alerts.push(alert);
      }
    }

    return alerts;
  }

  // -----------------------------------------------------------------------
  // Auto-resolution
  // -----------------------------------------------------------------------

  /**
   * Check all active alerts for the given agent and auto-resolve any where
   * 5 consecutive "good" invocations have occurred since the alert was
   * created.
   *
   * Should be called after each invocation is recorded.
   */
  autoResolve(agentName: string): void {
    const activeAlerts = this.store.getAlerts({
      agentName,
      activeOnly: true,
    });

    if (activeAlerts.length === 0) return;

    const aggregateContext = this.buildAggregateContext(agentName);
    const goodContext = this.buildGoodContext(agentName, aggregateContext);

    for (const alert of activeAlerts) {
      const predicate = GOOD_PREDICATES[alert.rule_id];
      if (!predicate) continue;

      const consecutiveGood = this.store.countConsecutiveGoodInvocations(
        agentName,
        alert.created_at,
        (metric: InvocationMetric) => predicate(metric, goodContext),
      );

      if (consecutiveGood >= AUTO_RESOLVE_COUNT) {
        this.store.resolveAlert(alert.alert_id);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Acknowledgment
  // -----------------------------------------------------------------------

  /**
   * Acknowledge an alert. Sets `acknowledged = true` without resolving it.
   */
  acknowledgeAlert(alertId: string): void {
    this.store.acknowledgeAlert(alertId);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Build the aggregate context (current and previous snapshots) for rule
   * evaluation.
   */
  private buildAggregateContext(agentName: string): AnomalyAggregateContext {
    const snapshots = this.store.getLatestSnapshots(agentName, 2);
    return {
      current: snapshots[0] ?? null,
      previous: snapshots[1] ?? null,
    };
  }

  /**
   * Build the context object needed by per-rule "good" predicates.
   */
  private buildGoodContext(
    agentName: string,
    aggregateContext: AnomalyAggregateContext,
  ): {
    overallAvg: number;
    qualityDeclinePoints: number;
    p95ReviewIterations: number;
    avgTokens: number;
    tokenMultiplier: number;
    trendDirection: string | null;
  } {
    const thirtyDaysAgo = new Date(
      Date.now() - 30 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const allMetrics = this.store.getInvocations(agentName, {
      since: thirtyDaysAgo,
    });

    const overallAvg = aggregateContext.current?.avg_quality_score ?? 0;

    // Compute p95 of review iterations
    const allIterations = allMetrics
      .map((m) => m.review_iteration_count)
      .sort((a, b) => a - b);
    const p95 =
      allIterations.length >= 10 ? percentile(allIterations, 95) : Infinity;

    // Compute average tokens
    const avgTokens =
      aggregateContext.current && aggregateContext.current.invocation_count > 0
        ? aggregateContext.current.total_tokens /
          aggregateContext.current.invocation_count
        : 0;

    return {
      overallAvg,
      qualityDeclinePoints: this.thresholds.qualityDeclinePoints,
      p95ReviewIterations: p95,
      avgTokens,
      tokenMultiplier: this.thresholds.tokenBudgetMultiplier,
      trendDirection: aggregateContext.current?.trend_direction ?? null,
    };
  }

  /**
   * Deduplicate alerts: if an active (unresolved) alert exists for the same
   * agent + rule, return it.  Otherwise create and persist a new alert.
   */
  private deduplicateOrCreate(
    agentName: string,
    finding: AnomalyFinding,
  ): AlertRecord {
    const existing = this.store.findActiveAlert(agentName, finding.ruleId);
    if (existing) return existing;

    const alert: AlertRecord = {
      alert_id: crypto.randomUUID(),
      agent_name: agentName,
      rule_id: finding.ruleId,
      severity: finding.severity,
      message: finding.message,
      evidence: finding.evidence,
      created_at: new Date().toISOString(),
      resolved_at: null,
      acknowledged: false,
    };

    this.store.insertAlert(alert);
    return alert;
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Compute the k-th percentile of a sorted (ascending) array. */
function percentile(sorted: number[], k: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];

  const index = (k / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) return sorted[lower];

  const fraction = index - lower;
  return sorted[lower] + fraction * (sorted[upper] - sorted[lower]);
}

/** Round a number to N decimal places. */
function round(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}
