/**
 * `HealthMonitor` — continuous health-check + auto-rollback (SPEC-023-3-01).
 *
 * Cross-reference: TDD-023 §12.
 *
 * Responsibilities:
 *   - Poll `backend.healthCheck(record)` per active deploy at the
 *     SLA-configured interval, with a per-tick AbortController to enforce
 *     `health_check_timeout_ms`.
 *   - Maintain an `SlaTracker` (rolling window) per deploy, exposing
 *     `consecutiveFailures()` and `uptimePct()`.
 *   - Trigger `backend.rollback()` exactly once when the consecutive-
 *     failure threshold is reached (state transitions to `rolling-back`).
 *     On success: write a follow-up `DeploymentRecord` with
 *     `cause: 'auto-rollback'` + `parent_deploy_id`.
 *     On failure: emit one `severity: 'critical'` escalation and stop
 *     monitoring the failed deploy.
 *   - Shut down cleanly via `stop()` — every pending check is aborted
 *     and the call resolves within `graceMs + 1s`.
 *
 * The monitor itself does NOT touch disk except via the injected
 * `writeRollbackRecord` callback. Logger / telemetry plumbing arrives in
 * SPEC-023-3-02; the public API exposes optional hooks for both.
 *
 * @module intake/deploy/monitor
 */

import { MonitorAlreadyStoppedError } from './errors';
import {
  DEFAULT_SLA,
  type EscalationMessage,
  type HealthSample,
  type MonitorStatus,
  type SlaConfig,
  resolveSla,
} from './monitor-types';
import { SlaTracker } from './sla-tracker';
import type { DeploymentBackend, DeploymentRecord } from './types';

/**
 * Optional logger injected for SPEC-023-3-02. Kept structural so this
 * module compiles before the logger lands.
 */
export interface MonitorLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** Hook for writing the auto-rollback follow-up `DeploymentRecord`. */
export type WriteRollbackRecord = (rec: {
  parentDeployId: string;
  rolledBackAt: string;
  backend: string;
  environment: string;
  cause: 'auto-rollback';
  details: Record<string, string | number | boolean>;
}) => Promise<{ deployId: string }>;

export interface HealthMonitorOptions {
  /**
   * Returns the active deployments to monitor. Called on every tick so
   * the monitor automatically picks up newly-deployed records and drops
   * rolled-back ones.
   */
  activeDeployments: () => Promise<DeploymentRecord[]>;
  /** Look up the backend instance for a deploy. */
  getBackend: (record: DeploymentRecord) => DeploymentBackend;
  /** Resolve SLA per deploy. Returns DEFAULT_SLA when caller has no override. */
  resolveSla?: (record: DeploymentRecord) => SlaConfig | undefined;
  /** Write the auto-rollback DeploymentRecord on success. */
  writeRollbackRecord: WriteRollbackRecord;
  /** Escalate to the operator (PLAN-009-X router). */
  escalate?: (msg: EscalationMessage) => Promise<void> | void;
  /** Optional logger for SPEC-023-3-02 wiring. */
  logger?: MonitorLogger;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  /** Test seams for fake-timer driven tests. */
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

interface PerDeployState {
  record: DeploymentRecord;
  sla: SlaConfig;
  tracker: SlaTracker;
  status: MonitorStatus['state'];
  timer: ReturnType<typeof setInterval> | null;
  inFlight: Set<AbortController>;
  /** Last MonitorStatus snapshot for `getStatus()`. */
  lastStatusSnapshot: MonitorStatus;
  /** Idempotency: rollback may only be initiated once. */
  rollbackInitiated: boolean;
}

export class HealthMonitor {
  private readonly opts: HealthMonitorOptions;
  private readonly states = new Map<string, PerDeployState>();
  private started = false;
  private stopped = false;
  /** Top-level `setInterval` that re-syncs the active-deploy set. */
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  /** Lower bound for the syncTimer cadence so the monitor noticed new deploys quickly. */
  private static readonly SYNC_INTERVAL_MS = 1_000;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly now: () => number;

  constructor(opts: HealthMonitorOptions) {
    this.opts = opts;
    this.setIntervalFn = opts.setIntervalFn ?? setInterval;
    this.clearIntervalFn = opts.clearIntervalFn ?? clearInterval;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Begin polling. Idempotent until `stop()` is called; calling `start()`
   * after `stop()` throws `MonitorAlreadyStoppedError`.
   */
  start(): void {
    if (this.stopped) throw new MonitorAlreadyStoppedError();
    if (this.started) return;
    this.started = true;
    this.opts.logger?.info('monitor_started', {});
    // Sync once immediately so the first tick scheduling sees current deploys.
    void this.sync();
    this.syncTimer = this.setIntervalFn(() => {
      void this.sync();
    }, HealthMonitor.SYNC_INTERVAL_MS);
  }

  /**
   * Cancel every pending health check via AbortController, clear all
   * per-deploy intervals, and resolve within `graceMs + 1s`.
   *
   * Safe to call multiple times. After stop() the monitor cannot be
   * restarted.
   */
  async stop(graceMs = 30_000): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    if (this.syncTimer) {
      this.clearIntervalFn(this.syncTimer);
      this.syncTimer = null;
    }
    for (const state of this.states.values()) {
      if (state.timer) this.clearIntervalFn(state.timer);
      state.timer = null;
      for (const ctrl of state.inFlight) ctrl.abort();
      state.inFlight.clear();
      state.status = 'stopped';
      state.lastStatusSnapshot = { ...state.lastStatusSnapshot, state: 'stopped' };
    }
    // Race the in-flight settlement against `graceMs + 1000`. We do not
    // hold concrete promises (each tick is fire-and-forget), so the grace
    // window is implemented as a bounded yield to the event loop.
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, Math.min(graceMs + 1000, 60_000));
      // Allow the runtime to exit before the timer fires if no other work
      // is queued.
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
    });
  }

  /** Return the latest `MonitorStatus` snapshot for a deploy, if tracked. */
  getStatus(deployId: string): MonitorStatus | undefined {
    const s = this.states.get(deployId);
    if (!s) return undefined;
    return { ...s.lastStatusSnapshot };
  }

  // -------------------------------------------------------------------------
  // Internal: re-sync the tracked deploy set, schedule per-deploy ticks.
  // -------------------------------------------------------------------------

  private async sync(): Promise<void> {
    if (this.stopped) return;
    let active: DeploymentRecord[] = [];
    try {
      active = await this.opts.activeDeployments();
    } catch (err) {
      this.opts.logger?.warn('monitor_sync_failed', {
        error: (err as Error).message,
      });
      return;
    }
    const seen = new Set<string>();
    for (const record of active) {
      seen.add(record.deployId);
      if (this.states.has(record.deployId)) continue;
      const sla = resolveSla(this.opts.resolveSla?.(record));
      const tracker = new SlaTracker(sla.rolling_window_size);
      const state: PerDeployState = {
        record,
        sla,
        tracker,
        status: 'healthy',
        timer: null,
        inFlight: new Set(),
        lastStatusSnapshot: {
          deployId: record.deployId,
          consecutiveFailures: 0,
          uptimePct: 1.0,
          state: 'healthy',
        },
        rollbackInitiated: false,
      };
      this.states.set(record.deployId, state);
      // Schedule per-deploy ticks at the configured interval.
      state.timer = this.setIntervalFn(() => {
        void this.tick(state);
      }, sla.health_check_interval_ms);
    }
    // Stop monitoring deploys that have left the active set (e.g. the
    // active-deployment query no longer returns them, indicating they have
    // been rolled back / archived).
    for (const [id, state] of this.states) {
      if (seen.has(id)) continue;
      if (state.timer) this.clearIntervalFn(state.timer);
      state.timer = null;
      for (const ctrl of state.inFlight) ctrl.abort();
      state.inFlight.clear();
      state.status = 'stopped';
      state.lastStatusSnapshot = { ...state.lastStatusSnapshot, state: 'stopped' };
    }
  }

  /**
   * One health-check tick for one deploy. Self-contained so a single
   * failing tick cannot crash the loop.
   */
  private async tick(state: PerDeployState): Promise<void> {
    if (this.stopped) return;
    if (state.rollbackInitiated) return;
    const start = this.now();
    const controller = new AbortController();
    state.inFlight.add(controller);
    let sample: HealthSample;
    try {
      const backend = this.opts.getBackend(state.record);
      const status = await this.withTimeout(
        Promise.resolve(backend.healthCheck(state.record)),
        controller,
        state.sla.health_check_timeout_ms,
      );
      sample = {
        ts: start,
        healthy: status.healthy,
        latency_ms: this.now() - start,
        ...(status.healthy ? {} : { error: status.unhealthyReason ?? 'unhealthy' }),
      };
    } catch (err) {
      const message = (err as Error).message ?? 'health_check_error';
      sample = {
        ts: start,
        healthy: false,
        latency_ms: this.now() - start,
        error: message === 'health_check_timeout' ? 'health_check_timeout' : message,
      };
    } finally {
      state.inFlight.delete(controller);
    }
    state.tracker.record(sample);
    this.opts.logger?.info('monitor_tick', {
      deployId: state.record.deployId,
      healthy: sample.healthy,
      latency_ms: sample.latency_ms,
    });
    if (sample.healthy) {
      this.opts.logger?.info('health_check_passed', {
        deployId: state.record.deployId,
        latency_ms: sample.latency_ms,
      });
    } else {
      this.opts.logger?.warn('health_check_failed', {
        deployId: state.record.deployId,
        latency_ms: sample.latency_ms,
        error: sample.error,
      });
    }
    this.refreshStatus(state, sample);

    const failures = state.tracker.consecutiveFailures();
    if (failures >= state.sla.consecutive_failures_for_rollback) {
      await this.triggerAutoRollback(state, failures);
    }
  }

  private refreshStatus(state: PerDeployState, sample: HealthSample): void {
    const consecutive = state.tracker.consecutiveFailures();
    const stateName: MonitorStatus['state'] =
      state.status === 'rolling-back' || state.status === 'escalated' || state.status === 'stopped'
        ? state.status
        : consecutive > 0
          ? 'degraded'
          : 'healthy';
    state.status = stateName;
    state.lastStatusSnapshot = {
      deployId: state.record.deployId,
      consecutiveFailures: consecutive,
      uptimePct: state.tracker.uptimePct(),
      lastSample: sample,
      state: stateName,
    };
  }

  private async triggerAutoRollback(
    state: PerDeployState,
    consecutiveFailures: number,
  ): Promise<void> {
    if (state.rollbackInitiated) return;
    state.rollbackInitiated = true;
    state.status = 'rolling-back';
    state.lastStatusSnapshot = { ...state.lastStatusSnapshot, state: 'rolling-back' };

    this.opts.logger?.warn('auto_rollback_triggered', {
      deployId: state.record.deployId,
      consecutive_failures: consecutiveFailures,
    });

    // Stop scheduling further ticks for this deploy; the rollback is
    // terminal regardless of outcome.
    if (state.timer) this.clearIntervalFn(state.timer);
    state.timer = null;

    const backend = this.opts.getBackend(state.record);
    let outcomeKind: 'success' | 'failure';
    let outcomeNewId: string | undefined;
    let outcomeError: string | undefined;
    try {
      const result = await backend.rollback(state.record);
      if (result.success) {
        const followup = await this.opts.writeRollbackRecord({
          parentDeployId: state.record.deployId,
          rolledBackAt: new Date().toISOString(),
          backend: state.record.backend,
          environment: state.record.environment,
          cause: 'auto-rollback',
          details: result.restoredArtifactId
            ? { restored_artifact_id: result.restoredArtifactId }
            : {},
        });
        outcomeKind = 'success';
        outcomeNewId = followup.deployId;
      } else {
        outcomeKind = 'failure';
        outcomeError = result.errors.join('; ') || 'rollback returned success=false';
      }
    } catch (err) {
      outcomeKind = 'failure';
      outcomeError = (err as Error).message;
    }

    if (outcomeKind === 'success') {
      this.opts.logger?.info('auto_rollback_completed', {
        deployId: state.record.deployId,
        outcome: 'success',
        new_deploy_id: outcomeNewId,
      });
      try {
        await this.opts.escalate?.({
          severity: 'info',
          deployId: state.record.deployId,
          message: `auto-rollback completed for ${state.record.deployId}`,
          details: { newDeployId: outcomeNewId, consecutiveFailures },
        });
      } catch {
        // Escalation failures must not poison the monitor.
      }
      state.status = 'stopped';
    } else {
      this.opts.logger?.error('auto_rollback_completed', {
        deployId: state.record.deployId,
        outcome: 'failure',
        error: outcomeError,
      });
      try {
        await this.opts.escalate?.({
          severity: 'critical',
          deployId: state.record.deployId,
          message: `auto-rollback FAILED for ${state.record.deployId}: ${outcomeError ?? 'unknown'}`,
          details: { error: outcomeError, consecutiveFailures },
        });
      } catch {
        // Escalation failures must not poison the monitor.
      }
      state.status = 'escalated';
    }
    state.lastStatusSnapshot = { ...state.lastStatusSnapshot, state: state.status };
  }

  /**
   * Race `p` against a timer that fires after `timeoutMs`. On timeout
   * the controller is aborted and the rejection's message is
   * `'health_check_timeout'`.
   */
  private withTimeout<T>(
    p: Promise<T>,
    controller: AbortController,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new Error('health_check_timeout'));
      }, timeoutMs);
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        (timer as { unref: () => void }).unref();
      }
      p.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err as Error);
        },
      );
    });
  }
}

export { DEFAULT_SLA };
