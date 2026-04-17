/**
 * Post-Promotion Auto-Rollback Monitor (SPEC-005-5-3, Task 7).
 *
 * Monitors agent quality metrics for a configurable window (default 48 hours)
 * after an autonomous promotion. If a quality decline is detected, the monitor
 * automatically rolls back to the previous version, applies a cooldown period
 * (default 30 days) during which autonomous promotion is disabled for the
 * affected agent, and sends a critical notification.
 *
 * Decline detection criteria:
 *   - Approval rate drops by more than 0.1 (10%) from baseline.
 *   - Average quality score drops by more than 0.5 from baseline.
 *   - Minimum 3 post-promotion invocations required before evaluating.
 *
 * Persistence: `data/auto-rollback-state.json`
 *
 * Exports: `AutoRollbackMonitor`, `MonitoringState`, `QualityBaseline`,
 *          `DeclineResult`, `DeclineEvidence`
 */

import * as fs from 'fs';
import * as path from 'path';

import type { AgentFactoryConfig } from '../config';
import type { AuditLogger } from '../audit';
import type { IMetricsEngine } from '../metrics/types';
import type { RollbackManager } from '../rollback';
import type { AgentProposal } from '../improvement/types';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/** Quality baseline captured before promotion for comparison. */
export interface QualityBaseline {
  approval_rate: number;
  avg_quality_score: number;
  sample_size: number;
}

/** Per-agent monitoring state tracked during the post-promotion window. */
export interface MonitoringState {
  agent_name: string;
  promoted_version: string;
  previous_version: string;
  proposal_id: string;
  monitoring_started_at: string;     // ISO 8601
  monitoring_ends_at: string;        // ISO 8601 (started_at + autoRollbackHours)
  pre_promotion_baseline: QualityBaseline;
  rollback_triggered: boolean;
  cooldown_until?: string;           // ISO 8601, set if rollback occurs
}

/** Evidence collected when quality decline is detected. */
export interface DeclineEvidence {
  pre_approval_rate: number;
  post_approval_rate: number;
  pre_avg_quality: number;
  post_avg_quality: number;
  quality_delta: number;
  approval_delta: number;
  post_sample_size: number;
}

/** Result of checking for quality decline. */
export interface DeclineResult {
  declined: boolean;
  reason?: string;
  evidence?: DeclineEvidence;
}

/** Notification service interface for sending alerts. */
export interface NotificationService {
  send(notification: {
    severity: 'info' | 'warning' | 'critical';
    message: string;
    details: Record<string, unknown>;
  }): void;
}

// ---------------------------------------------------------------------------
// Persistence schema
// ---------------------------------------------------------------------------

interface PersistedRollbackState {
  monitors: Record<string, MonitoringState>;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logRollbackMonitorEvent(eventType: string, details: Record<string, unknown>): void {
  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...details,
  };
  process.stderr.write(`[AUTO_ROLLBACK] ${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// AutoRollbackMonitor
// ---------------------------------------------------------------------------

/**
 * Monitors quality metrics after autonomous promotion and triggers
 * auto-rollback if quality decline is detected.
 *
 * Usage:
 * ```ts
 * const monitor = new AutoRollbackMonitor(deps);
 * monitor.startMonitoring('code-author', proposal);
 *
 * // Called after each invocation metric for the agent:
 * const result = monitor.checkForDecline('code-author');
 * if (result.declined) {
 *   // auto-rollback was already triggered
 * }
 *
 * // Check cooldown before auto-promoting again:
 * if (monitor.isInCooldown('code-author')) {
 *   // skip autonomous promotion
 * }
 * ```
 */
export class AutoRollbackMonitor {
  private readonly metricsEngine: IMetricsEngine;
  private readonly rollbackManager: RollbackManager;
  private readonly auditLogger: AuditLogger;
  private readonly notificationService: NotificationService;
  private readonly statePath: string;

  // Config values
  private readonly autoRollbackHours: number;
  private readonly cooldownDays: number;
  private readonly minInvocationsForDecline: number;
  private readonly approvalRateDropThreshold: number;
  private readonly qualityScoreDropThreshold: number;

  /** In-memory monitoring state keyed by agent name. */
  private readonly monitors: Map<string, MonitoringState> = new Map();

  constructor(deps: {
    metricsEngine: IMetricsEngine;
    rollbackManager: RollbackManager;
    config: AgentFactoryConfig;
    auditLogger: AuditLogger;
    notificationService: NotificationService;
    statePath?: string;
  }) {
    this.metricsEngine = deps.metricsEngine;
    this.rollbackManager = deps.rollbackManager;
    this.auditLogger = deps.auditLogger;
    this.notificationService = deps.notificationService;
    this.statePath = deps.statePath
      ? path.resolve(deps.statePath)
      : path.resolve('data/auto-rollback-state.json');

    const ap = deps.config.autonomousPromotion;
    this.autoRollbackHours = ap?.autoRollbackHours ?? 48;
    this.cooldownDays = ap?.cooldownDays ?? 30;
    this.minInvocationsForDecline = ap?.minInvocationsForDecline ?? 3;
    this.approvalRateDropThreshold = ap?.approvalRateDropThreshold ?? 0.1;
    this.qualityScoreDropThreshold = ap?.qualityScoreDropThreshold ?? 0.5;

    this.loadState();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Start monitoring quality metrics for an agent after autonomous promotion.
   *
   * Captures the pre-promotion quality baseline from the metrics engine
   * and begins the monitoring window.
   *
   * @param agentName  The name of the promoted agent.
   * @param proposal   The proposal that was promoted (for version info).
   */
  startMonitoring(agentName: string, proposal: AgentProposal): void {
    const now = new Date();
    const monitoringEndsAt = new Date(
      now.getTime() + this.autoRollbackHours * 60 * 60 * 1000,
    );

    // Capture pre-promotion baseline from aggregate metrics
    const baseline = this.captureBaseline(agentName);

    const state: MonitoringState = {
      agent_name: agentName,
      promoted_version: proposal.proposed_version,
      previous_version: proposal.current_version,
      proposal_id: proposal.proposal_id,
      monitoring_started_at: now.toISOString(),
      monitoring_ends_at: monitoringEndsAt.toISOString(),
      pre_promotion_baseline: baseline,
      rollback_triggered: false,
    };

    this.monitors.set(agentName, state);
    this.persistState();

    this.auditLogger.log({
      timestamp: now.toISOString(),
      event_type: 'auto_rollback_monitoring_started',
      agent_name: agentName,
      details: {
        promotedVersion: proposal.proposed_version,
        previousVersion: proposal.current_version,
        monitoringEndsAt: monitoringEndsAt.toISOString(),
        baseline,
      },
    });

    logRollbackMonitorEvent('monitoring_started', {
      agentName,
      promotedVersion: proposal.proposed_version,
      previousVersion: proposal.current_version,
      monitoringEndsAt: monitoringEndsAt.toISOString(),
      baseline,
    });
  }

  /**
   * Check for quality decline for a monitored agent.
   *
   * Should be called after each invocation metric is recorded for the agent.
   *
   * Behaviour:
   *   1. If agent is not being monitored, returns { declined: false }.
   *   2. If monitoring window has expired, ends monitoring and returns { declined: false }.
   *   3. If fewer than minInvocationsForDecline post-promotion invocations, defers.
   *   4. Compares post-promotion metrics against baseline.
   *   5. If decline detected: triggers auto-rollback, sets cooldown, notifies.
   *
   * @param agentName  The name of the agent to check.
   * @returns          DeclineResult indicating whether decline was detected.
   */
  checkForDecline(agentName: string): DeclineResult {
    const state = this.monitors.get(agentName);
    if (!state) {
      return { declined: false };
    }

    // Already rolled back
    if (state.rollback_triggered) {
      return { declined: false };
    }

    // Check if monitoring period has ended
    if (new Date(state.monitoring_ends_at) <= new Date()) {
      this.endMonitoring(agentName);
      return { declined: false };
    }

    // Get post-promotion invocations
    const postPromotionInvocations = this.metricsEngine.getInvocations(agentName, {
      since: state.monitoring_started_at,
    });

    // Require minimum sample size
    if (postPromotionInvocations.length < this.minInvocationsForDecline) {
      return { declined: false };
    }

    // Compute post-promotion metrics
    const approvedCount = postPromotionInvocations.filter(
      (inv) => inv.review_outcome === 'approved',
    ).length;
    const postApprovalRate = approvedCount / postPromotionInvocations.length;

    const totalQuality = postPromotionInvocations.reduce(
      (sum, inv) => sum + inv.output_quality_score,
      0,
    );
    const postAvgQuality = totalQuality / postPromotionInvocations.length;

    // Compare against baseline
    const baseline = state.pre_promotion_baseline;
    const approvalDelta = baseline.approval_rate - postApprovalRate;
    const qualityDelta = baseline.avg_quality_score - postAvgQuality;

    const evidence: DeclineEvidence = {
      pre_approval_rate: baseline.approval_rate,
      post_approval_rate: postApprovalRate,
      pre_avg_quality: baseline.avg_quality_score,
      post_avg_quality: postAvgQuality,
      quality_delta: qualityDelta,
      approval_delta: approvalDelta,
      post_sample_size: postPromotionInvocations.length,
    };

    // Check for decline
    const approvalDeclined = approvalDelta > this.approvalRateDropThreshold;
    const qualityDeclined = qualityDelta > this.qualityScoreDropThreshold;

    if (!approvalDeclined && !qualityDeclined) {
      return { declined: false };
    }

    // Decline detected -- trigger auto-rollback
    const reasons: string[] = [];
    if (approvalDeclined) {
      reasons.push(
        `Approval rate dropped from ${baseline.approval_rate.toFixed(2)} to ${postApprovalRate.toFixed(2)} ` +
        `(delta: ${approvalDelta.toFixed(2)}, threshold: ${this.approvalRateDropThreshold})`,
      );
    }
    if (qualityDeclined) {
      reasons.push(
        `Quality score dropped from ${baseline.avg_quality_score.toFixed(2)} to ${postAvgQuality.toFixed(2)} ` +
        `(delta: ${qualityDelta.toFixed(2)}, threshold: ${this.qualityScoreDropThreshold})`,
      );
    }

    const reason = reasons.join('; ');

    this.triggerAutoRollback(agentName, state, reason, evidence);

    return {
      declined: true,
      reason,
      evidence,
    };
  }

  /**
   * Check whether an agent is in cooldown (autonomous promotion disabled).
   *
   * After an auto-rollback, the agent enters a cooldown period (default 30 days)
   * during which autonomous promotion is not allowed.
   *
   * @param agentName  The name of the agent to check.
   * @returns          True if the agent is in cooldown, false otherwise.
   */
  isInCooldown(agentName: string): boolean {
    const state = this.monitors.get(agentName);
    if (!state?.cooldown_until) return false;
    return new Date(state.cooldown_until) > new Date();
  }

  /**
   * Get the cooldown expiry date for an agent, or null if not in cooldown.
   */
  getCooldownUntil(agentName: string): string | null {
    const state = this.monitors.get(agentName);
    if (!state?.cooldown_until) return null;
    if (new Date(state.cooldown_until) <= new Date()) return null;
    return state.cooldown_until;
  }

  /**
   * Get the monitoring state for an agent (for diagnostics).
   */
  getState(agentName: string): MonitoringState | null {
    return this.monitors.get(agentName) ?? null;
  }

  /**
   * Check whether an agent is currently being monitored.
   */
  isMonitoring(agentName: string): boolean {
    const state = this.monitors.get(agentName);
    if (!state) return false;
    if (state.rollback_triggered) return false;
    return new Date(state.monitoring_ends_at) > new Date();
  }

  /**
   * Get all monitoring states (for diagnostics/CLI display).
   */
  getAllStates(): MonitoringState[] {
    return Array.from(this.monitors.values());
  }

  // -------------------------------------------------------------------------
  // Private: baseline capture
  // -------------------------------------------------------------------------

  /**
   * Capture the pre-promotion quality baseline from aggregate metrics.
   *
   * Falls back to sensible defaults if no aggregate data is available.
   */
  private captureBaseline(agentName: string): QualityBaseline {
    const aggregate = this.metricsEngine.getAggregate(agentName);

    if (aggregate) {
      return {
        approval_rate: aggregate.approval_rate,
        avg_quality_score: aggregate.avg_quality_score,
        sample_size: aggregate.invocation_count,
      };
    }

    // No aggregate available: use neutral defaults
    return {
      approval_rate: 0,
      avg_quality_score: 0,
      sample_size: 0,
    };
  }

  // -------------------------------------------------------------------------
  // Private: auto-rollback trigger
  // -------------------------------------------------------------------------

  /**
   * Execute the auto-rollback procedure.
   *
   * 1. Roll back to previous version via RollbackManager.
   * 2. Set cooldown period.
   * 3. Send critical notification.
   * 4. Log audit event.
   */
  private triggerAutoRollback(
    agentName: string,
    state: MonitoringState,
    reason: string,
    evidence: DeclineEvidence,
  ): void {
    logRollbackMonitorEvent('auto_rollback_triggered', {
      agentName,
      promotedVersion: state.promoted_version,
      previousVersion: state.previous_version,
      reason,
      evidence,
    });

    // Mark rollback triggered
    state.rollback_triggered = true;

    // Set cooldown
    const cooldownUntil = new Date(
      Date.now() + this.cooldownDays * 24 * 60 * 60 * 1000,
    );
    state.cooldown_until = cooldownUntil.toISOString();
    this.persistState();

    // Execute rollback
    this.rollbackManager
      .rollback(agentName, {
        force: true,
        targetVersion: state.previous_version,
      })
      .then((result) => {
        if (result.success) {
          logRollbackMonitorEvent('auto_rollback_completed', {
            agentName,
            restoredVersion: result.restoredVersion,
            commitHash: result.commitHash,
          });
        } else {
          logRollbackMonitorEvent('auto_rollback_failed', {
            agentName,
            error: result.error,
          });
        }
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        logRollbackMonitorEvent('auto_rollback_error', {
          agentName,
          error: message,
        });
      });

    // Audit log
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'auto_rollback_quality_decline',
      agent_name: agentName,
      details: {
        promotedVersion: state.promoted_version,
        previousVersion: state.previous_version,
        reason,
        evidence,
        cooldownUntil: cooldownUntil.toISOString(),
        cooldownDays: this.cooldownDays,
      },
    });

    // Critical notification
    this.notificationService.send({
      severity: 'critical',
      message:
        `Auto-rollback triggered for ${agentName}: ` +
        `v${state.promoted_version} -> v${state.previous_version}. ` +
        `Cooldown until ${cooldownUntil.toISOString()}.`,
      details: {
        agentName,
        promotedVersion: state.promoted_version,
        previousVersion: state.previous_version,
        reason,
        evidence,
        cooldownUntil: cooldownUntil.toISOString(),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Private: monitoring lifecycle
  // -------------------------------------------------------------------------

  /**
   * End monitoring for an agent (monitoring window expired without decline).
   */
  private endMonitoring(agentName: string): void {
    const state = this.monitors.get(agentName);
    if (!state) return;

    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'auto_rollback_monitoring_ended',
      agent_name: agentName,
      details: {
        promotedVersion: state.promoted_version,
        monitoringStartedAt: state.monitoring_started_at,
        monitoringEndedAt: state.monitoring_ends_at,
        rollbackTriggered: false,
      },
    });

    logRollbackMonitorEvent('monitoring_ended', {
      agentName,
      promotedVersion: state.promoted_version,
      outcome: 'no_decline',
    });

    // Do NOT remove the state -- keep it for cooldown tracking.
    // Just let it stay with rollback_triggered=false.
  }

  // -------------------------------------------------------------------------
  // Private: persistence
  // -------------------------------------------------------------------------

  private loadState(): void {
    if (!fs.existsSync(this.statePath)) {
      return;
    }

    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const persisted = JSON.parse(raw) as PersistedRollbackState;

      if (persisted.monitors && typeof persisted.monitors === 'object') {
        for (const [name, state] of Object.entries(persisted.monitors)) {
          this.monitors.set(name, state);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logRollbackMonitorEvent('state_load_failed', { error: message });
    }
  }

  private persistState(): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const persisted: PersistedRollbackState = { monitors: {} };
    for (const [name, state] of this.monitors) {
      persisted.monitors[name] = state;
    }

    try {
      fs.writeFileSync(
        this.statePath,
        JSON.stringify(persisted, null, 2) + '\n',
        { encoding: 'utf-8' },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logRollbackMonitorEvent('state_persist_failed', { error: message });
    }
  }
}
