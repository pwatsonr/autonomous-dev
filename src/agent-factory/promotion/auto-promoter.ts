/**
 * Autonomous Patch-Level Promoter with Risk-Tier Gating (SPEC-005-5-3, Tasks 5 & 8).
 *
 * Implements the autonomous promotion system that auto-promotes validated
 * patch-level changes for low-risk agents. Integrates risk-tier gating to
 * restrict which agents are eligible for autonomous promotion.
 *
 * Eligibility gates (all must pass):
 *   1. `config.autonomousPromotion.enabled` must be true.
 *   2. Version bump must be `patch` (minor/major require human approval).
 *   3. Agent risk tier must be `low` (explicit or derived from role).
 *   4. Agent must not be in cooldown (post-auto-rollback lockout).
 *
 * Risk tier derivation from role (when `risk_tier` not explicitly set):
 *   - author   -> low
 *   - reviewer  -> low
 *   - executor -> medium
 *   - meta     -> high
 *
 * After successful auto-promotion:
 *   - Opens a 24-hour operator override window.
 *   - Starts 48-hour post-promotion quality monitoring.
 *   - Sends notification to operator with diff and comparison data.
 *   - Logs audit event.
 *
 * Exports: `AutoPromoter`, `AutoPromoteResult`, `EligibilityResult`,
 *          `NotificationService`, `isEligibleForAutoPromotion`, `deriveRiskTier`
 */

import type { ParsedAgent, IAgentRegistry, RiskTier, AgentRole } from '../types';
import type { AgentFactoryConfig } from '../config';
import type { AuditLogger } from '../audit';
import type { AgentProposal } from '../improvement/types';
import type { Promoter } from './promoter';
import type { OverrideWindowManager } from './override-window';
import type { AutoRollbackMonitor, NotificationService } from './auto-rollback';

// Re-export NotificationService for convenience
export type { NotificationService } from './auto-rollback';

// ---------------------------------------------------------------------------
// AutoPromoteResult
// ---------------------------------------------------------------------------

/** Result of an autonomous promotion attempt. */
export interface AutoPromoteResult {
  promoted: boolean;
  agentName: string;
  previousVersion: string;
  newVersion: string;
  commitHash?: string;
  overrideWindowExpiresAt?: string;
  reason?: string;                   // populated if not promoted
}

// ---------------------------------------------------------------------------
// EligibilityResult
// ---------------------------------------------------------------------------

/** Result of checking whether an agent is eligible for autonomous promotion. */
export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Risk-tier derivation
// ---------------------------------------------------------------------------

/** Default risk tier map from agent role. */
const ROLE_RISK_MAP: Readonly<Record<AgentRole, RiskTier>> = {
  author: 'low',
  reviewer: 'low',
  executor: 'medium',
  meta: 'high',
};

/**
 * Derive the risk tier for an agent when not explicitly set.
 *
 * @param role  The agent's role.
 * @returns     The derived risk tier.
 */
export function deriveRiskTier(role: AgentRole): RiskTier {
  return ROLE_RISK_MAP[role];
}

// ---------------------------------------------------------------------------
// Eligibility check
// ---------------------------------------------------------------------------

/**
 * Determine whether an agent and proposal are eligible for autonomous promotion.
 *
 * Gates checked in order:
 *   1. Config must enable autonomous promotion.
 *   2. Version bump must be `patch`.
 *   3. Risk tier must be `low` (explicit or derived from role).
 *   4. Agent must not be in cooldown from a previous auto-rollback.
 *
 * @param agent    The parsed agent definition.
 * @param proposal The proposal to evaluate.
 * @param config   The agent factory configuration.
 * @param autoRollbackMonitor  The rollback monitor for cooldown checking.
 * @returns        EligibilityResult with eligible=true or eligible=false with reason.
 */
export function isEligibleForAutoPromotion(
  agent: ParsedAgent,
  proposal: AgentProposal,
  config: AgentFactoryConfig,
  autoRollbackMonitor?: AutoRollbackMonitor,
): EligibilityResult {
  // Gate 1: Config must enable autonomous promotion
  if (!config.autonomousPromotion?.enabled) {
    return {
      eligible: false,
      reason: 'Autonomous promotion is disabled in config',
    };
  }

  // Gate 2: Must be patch-level change
  if (proposal.version_bump !== 'patch') {
    return {
      eligible: false,
      reason: `Version bump '${proposal.version_bump}' requires human approval (only patch is auto-eligible)`,
    };
  }

  // Gate 3: Risk tier must be low
  const riskTier = agent.risk_tier ?? deriveRiskTier(agent.role);
  if (riskTier !== 'low') {
    return {
      eligible: false,
      reason: `Risk tier '${riskTier}' requires human approval`,
    };
  }

  // Gate 4: Agent must not be in cooldown
  if (autoRollbackMonitor?.isInCooldown(agent.name)) {
    const cooldownUntil = autoRollbackMonitor.getCooldownUntil(agent.name);
    return {
      eligible: false,
      reason: `Agent in cooldown until ${cooldownUntil} (previous auto-rollback)`,
    };
  }

  return { eligible: true };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logAutoPromoterEvent(eventType: string, details: Record<string, unknown>): void {
  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...details,
  };
  process.stderr.write(`[AUTO_PROMOTER] ${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// AutoPromoter
// ---------------------------------------------------------------------------

/** Dependencies injected into the AutoPromoter. */
export interface AutoPromoterDependencies {
  promoter: Promoter;
  overrideManager: OverrideWindowManager;
  autoRollbackMonitor: AutoRollbackMonitor;
  registry: IAgentRegistry;
  config: AgentFactoryConfig;
  auditLogger: AuditLogger;
  notificationService: NotificationService;
}

/**
 * Orchestrates autonomous patch-level promotion with guardrails.
 *
 * Usage:
 * ```ts
 * const autoPromoter = new AutoPromoter(deps);
 * const result = await autoPromoter.attemptAutoPromote('code-author', proposal);
 *
 * if (result.promoted) {
 *   console.log(`Auto-promoted to v${result.newVersion}, commit: ${result.commitHash}`);
 *   console.log(`Override window expires: ${result.overrideWindowExpiresAt}`);
 * } else {
 *   console.log(`Not auto-promoted: ${result.reason}`);
 * }
 * ```
 */
export class AutoPromoter {
  private readonly promoter: Promoter;
  private readonly overrideManager: OverrideWindowManager;
  private readonly autoRollbackMonitor: AutoRollbackMonitor;
  private readonly registry: IAgentRegistry;
  private readonly config: AgentFactoryConfig;
  private readonly auditLogger: AuditLogger;
  private readonly notificationService: NotificationService;

  constructor(deps: AutoPromoterDependencies) {
    this.promoter = deps.promoter;
    this.overrideManager = deps.overrideManager;
    this.autoRollbackMonitor = deps.autoRollbackMonitor;
    this.registry = deps.registry;
    this.config = deps.config;
    this.auditLogger = deps.auditLogger;
    this.notificationService = deps.notificationService;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Attempt to autonomously promote an agent based on a validated proposal.
   *
   * Steps:
   *   1. Check eligibility (risk tier, version bump, config, cooldown).
   *   2. Auto-promote using existing Promoter infrastructure.
   *   3. Open override window.
   *   4. Start auto-rollback monitoring.
   *   5. Notify operator.
   *   6. Log audit event.
   *
   * @param agentName  The name of the agent to promote.
   * @param proposal   The validated proposal to promote.
   * @returns          AutoPromoteResult indicating success or reason for skipping.
   */
  async attemptAutoPromote(
    agentName: string,
    proposal: AgentProposal,
  ): Promise<AutoPromoteResult> {
    const previousVersion = proposal.current_version;
    const newVersion = proposal.proposed_version;

    // Step 1: Eligibility check
    const agentRecord = this.registry.get(agentName);
    if (!agentRecord) {
      return this.notPromotedResult(
        agentName,
        previousVersion,
        newVersion,
        `Agent '${agentName}' not found in registry`,
      );
    }

    const eligibility = isEligibleForAutoPromotion(
      agentRecord.agent,
      proposal,
      this.config,
      this.autoRollbackMonitor,
    );

    if (!eligibility.eligible) {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'auto_promotion_ineligible',
        agent_name: agentName,
        details: {
          reason: eligibility.reason,
          versionBump: proposal.version_bump,
          riskTier: agentRecord.agent.risk_tier ?? deriveRiskTier(agentRecord.agent.role),
        },
      });

      logAutoPromoterEvent('auto_promotion_ineligible', {
        agentName,
        reason: eligibility.reason,
      });

      return this.notPromotedResult(
        agentName,
        previousVersion,
        newVersion,
        eligibility.reason,
      );
    }

    // Step 2: Auto-promote using existing Promoter with custom commit message
    const commitMessage =
      `fix(agents): auto-promote ${agentName} ` +
      `v${previousVersion} -> v${newVersion} -- ${proposal.rationale}`;

    const promotionResult = await this.promoter.promoteWithMessage(
      agentName,
      proposal.proposal_id,
      commitMessage,
    );

    if (!promotionResult.success) {
      logAutoPromoterEvent('auto_promotion_failed', {
        agentName,
        error: promotionResult.error,
      });

      return this.notPromotedResult(
        agentName,
        previousVersion,
        newVersion,
        promotionResult.error,
      );
    }

    // Step 3: Open override window
    const overrideWindow = this.overrideManager.openWindow(
      agentName,
      newVersion,
      promotionResult.commitHash,
    );

    // Step 4: Start auto-rollback monitoring
    this.autoRollbackMonitor.startMonitoring(agentName, proposal);

    // Step 5: Notify operator
    this.notificationService.send({
      severity: 'info',
      message:
        `Auto-promoted ${agentName} v${previousVersion} -> v${newVersion}. ` +
        `Override window open until ${overrideWindow.expires_at}.`,
      details: {
        agentName,
        previousVersion,
        newVersion,
        commitHash: promotionResult.commitHash,
        overrideWindowExpiresAt: overrideWindow.expires_at,
        diff: proposal.diff,
        rationale: proposal.rationale,
      },
    });

    // Step 6: Audit log
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'agent_auto_promoted',
      agent_name: agentName,
      details: {
        previousVersion,
        newVersion,
        commitHash: promotionResult.commitHash,
        proposalId: proposal.proposal_id,
        overrideWindowExpiresAt: overrideWindow.expires_at,
        riskTier: agentRecord.agent.risk_tier ?? deriveRiskTier(agentRecord.agent.role),
        versionBump: proposal.version_bump,
      },
    });

    logAutoPromoterEvent('agent_auto_promoted', {
      agentName,
      previousVersion,
      newVersion,
      commitHash: promotionResult.commitHash,
      proposalId: proposal.proposal_id,
      overrideWindowExpiresAt: overrideWindow.expires_at,
    });

    return {
      promoted: true,
      agentName,
      previousVersion,
      newVersion,
      commitHash: promotionResult.commitHash,
      overrideWindowExpiresAt: overrideWindow.expires_at,
    };
  }

  /**
   * Check eligibility for an agent without attempting promotion.
   *
   * Useful for CLI status display or pre-flight checks.
   *
   * @param agentName  The name of the agent to check.
   * @param proposal   The proposal to evaluate.
   * @returns          EligibilityResult.
   */
  checkEligibility(agentName: string, proposal: AgentProposal): EligibilityResult {
    const agentRecord = this.registry.get(agentName);
    if (!agentRecord) {
      return { eligible: false, reason: `Agent '${agentName}' not found in registry` };
    }

    return isEligibleForAutoPromotion(
      agentRecord.agent,
      proposal,
      this.config,
      this.autoRollbackMonitor,
    );
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Build a result for a non-promoted attempt.
   */
  private notPromotedResult(
    agentName: string,
    previousVersion: string,
    newVersion: string,
    reason?: string,
  ): AutoPromoteResult {
    return {
      promoted: false,
      agentName,
      previousVersion,
      newVersion,
      reason,
    };
  }
}
