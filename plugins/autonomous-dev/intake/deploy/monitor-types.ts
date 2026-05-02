/**
 * Type contract for the deployment health monitor (SPEC-023-3-01).
 *
 * Cross-reference: TDD-023 §12 (continuous health-check monitor).
 *
 * The monitor polls each active deployment's `healthCheck()` at a
 * configurable interval, tracks healthy/unhealthy in a rolling window,
 * and triggers `backend.rollback()` on consecutive failures. SLA
 * resolution order: per-backend deploy.yaml → defaults → DEFAULT_SLA.
 *
 * @module intake/deploy/monitor-types
 */

/** SLA + monitor cadence configuration. */
export interface SlaConfig {
  /** Aspirational uptime fraction (0..1). Default 0.99. */
  uptime_pct: number;
  /** Trigger rollback after N consecutive failed samples. Default 3. */
  consecutive_failures_for_rollback: number;
  /** Health-check tick interval, milliseconds. Default 30_000. */
  health_check_interval_ms: number;
  /** Per-tick health-check timeout, milliseconds. Default 5_000. */
  health_check_timeout_ms: number;
  /** Capacity of the rolling sample window. Default 100. */
  rolling_window_size: number;
}

/** Defaults used when no per-backend override is configured. */
export const DEFAULT_SLA: SlaConfig = Object.freeze({
  uptime_pct: 0.99,
  consecutive_failures_for_rollback: 3,
  health_check_interval_ms: 30_000,
  health_check_timeout_ms: 5_000,
  rolling_window_size: 100,
});

/** One health-check observation. */
export interface HealthSample {
  /** epoch ms */
  ts: number;
  healthy: boolean;
  latency_ms: number;
  /** Populated only when `healthy === false`. */
  error?: string;
}

/** Result of attempting an auto-rollback. */
export type RollbackOutcome =
  | { kind: 'success'; newDeployId: string }
  | { kind: 'failure'; error: string };

/** State the monitor reports for one tracked deployment. */
export interface MonitorStatus {
  deployId: string;
  consecutiveFailures: number;
  /** Healthy sample count / total sample count in the rolling window. */
  uptimePct: number;
  lastSample?: HealthSample;
  state: 'healthy' | 'degraded' | 'rolling-back' | 'escalated' | 'stopped';
}

/**
 * Escalation message shape consumed by the optional `escalate()` callback.
 * Keeps this module decoupled from PLAN-009-X's full router types.
 */
export interface EscalationMessage {
  severity: 'info' | 'warn' | 'critical';
  deployId: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Resolve an `SlaConfig` from a partial per-backend override + defaults.
 * Missing fields fall back to `DEFAULT_SLA`. `null`/`undefined` overrides
 * yield the defaults verbatim.
 */
export function resolveSla(override?: Partial<SlaConfig> | null): SlaConfig {
  if (!override) return { ...DEFAULT_SLA };
  return {
    uptime_pct: numOr(override.uptime_pct, DEFAULT_SLA.uptime_pct),
    consecutive_failures_for_rollback: numOr(
      override.consecutive_failures_for_rollback,
      DEFAULT_SLA.consecutive_failures_for_rollback,
    ),
    health_check_interval_ms: numOr(
      override.health_check_interval_ms,
      DEFAULT_SLA.health_check_interval_ms,
    ),
    health_check_timeout_ms: numOr(
      override.health_check_timeout_ms,
      DEFAULT_SLA.health_check_timeout_ms,
    ),
    rolling_window_size: numOr(
      override.rolling_window_size,
      DEFAULT_SLA.rolling_window_size,
    ),
  };
}

function numOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
