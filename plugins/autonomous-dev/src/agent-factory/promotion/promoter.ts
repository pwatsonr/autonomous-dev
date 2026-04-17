/**
 * Human-Approved Promotion Workflow (SPEC-005-4-4, Task 9).
 *
 * Implements the final step of the improvement lifecycle: after A/B
 * validation succeeds and a human operator approves, this module writes
 * the new agent definition to disk, commits to git with conventional
 * commit messages, reloads the registry, and updates all tracking state.
 *
 * Promotion steps:
 *   1. Validate prerequisites (proposal status, agent state, ownership).
 *   2. Present review summary to operator.
 *   3. Write new agent definition to `agents/<name>.md`.
 *   4. Commit to git with semver-convention message.
 *   5. Reload registry and verify new version is loaded.
 *   6. Update proposal status, agent state, observation tracker, and audit log.
 *   7. Handle errors: rollback file on git failure, log critical on reload failure.
 *
 * Exports: `Promoter`, `PromotionResult`
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

import type { IAgentRegistry } from '../types';
import type { AuditLogger } from '../audit';
import type { ObservationTracker } from '../metrics/observation';
import type { ProposalStore } from '../improvement/proposal-store';
import type {
  AgentProposal,
  VersionBump,
  WeaknessReport,
  MetaReviewResult,
  ABEvaluationResult,
  ABInput,
} from '../improvement/types';

// ---------------------------------------------------------------------------
// PromotionResult
// ---------------------------------------------------------------------------

/** Result of a promotion attempt. */
export interface PromotionResult {
  success: boolean;
  agentName: string;
  previousVersion: string;
  newVersion: string;
  commitHash: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Dependencies injected into the Promoter. */
export interface PromoterDependencies {
  registry: IAgentRegistry;
  proposalStore: ProposalStore;
  auditLogger: AuditLogger;
  observationTracker: ObservationTracker;
  /** Root directory of the agents folder (e.g. `agents/`). */
  agentsDir: string;
  /** Root directory of the project (for git operations). */
  projectRoot: string;
  /** Optional: load weakness report by ID. */
  loadWeaknessReport?: (reportId: string) => WeaknessReport | null;
  /** Optional: load meta-review result by ID. */
  loadMetaReview?: (reviewId: string) => MetaReviewResult | null;
  /** Optional: load A/B evaluation result by ID. */
  loadEvaluation?: (evaluationId: string) => ABEvaluationResult | null;
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logPromoterEvent(eventType: string, details: Record<string, unknown>): void {
  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...details,
  };
  process.stderr.write(`[PROMOTER] ${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// Promoter
// ---------------------------------------------------------------------------

/**
 * Orchestrates the human-approved promotion workflow.
 *
 * Usage:
 * ```ts
 * const promoter = new Promoter(deps);
 * const result = await promoter.promote('code-executor', 'proposal-uuid');
 * ```
 */
export class Promoter {
  private readonly registry: IAgentRegistry;
  private readonly proposalStore: ProposalStore;
  private readonly auditLogger: AuditLogger;
  private readonly observationTracker: ObservationTracker;
  private readonly agentsDir: string;
  private readonly projectRoot: string;
  private readonly loadWeaknessReport: (reportId: string) => WeaknessReport | null;
  private readonly loadMetaReview: (reviewId: string) => MetaReviewResult | null;
  private readonly loadEvaluation: (evaluationId: string) => ABEvaluationResult | null;

  constructor(deps: PromoterDependencies) {
    this.registry = deps.registry;
    this.proposalStore = deps.proposalStore;
    this.auditLogger = deps.auditLogger;
    this.observationTracker = deps.observationTracker;
    this.agentsDir = path.resolve(deps.agentsDir);
    this.projectRoot = path.resolve(deps.projectRoot);
    this.loadWeaknessReport = deps.loadWeaknessReport ?? (() => null);
    this.loadMetaReview = deps.loadMetaReview ?? (() => null);
    this.loadEvaluation = deps.loadEvaluation ?? (() => null);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Execute the promotion workflow for a validated agent improvement.
   *
   * @param agentName   The name of the agent to promote.
   * @param proposalId  The ID of the proposal to promote.
   * @returns           PromotionResult indicating success or failure.
   */
  async promote(agentName: string, proposalId: string): Promise<PromotionResult> {
    // Step 1: Validate prerequisites
    const proposal = this.proposalStore.getById(proposalId);
    if (!proposal) {
      return this.failResult(agentName, '', '', `Proposal '${proposalId}' not found`);
    }

    const prerequisiteError = this.validatePrerequisites(proposal, agentName);
    if (prerequisiteError) {
      return this.failResult(
        agentName,
        proposal.current_version,
        proposal.proposed_version,
        prerequisiteError,
      );
    }

    const previousVersion = proposal.current_version;
    const newVersion = proposal.proposed_version;

    // Step 2: Present review summary to operator
    const summary = this.buildReviewSummary(proposal);
    logPromoterEvent('promotion_review_summary', {
      agentName,
      proposalId,
      previousVersion,
      newVersion,
      summary,
    });

    // Step 3: Write new agent definition to disk
    const agentFilePath = path.join(this.agentsDir, `${agentName}.md`);
    let originalContent: string | null = null;

    try {
      // Preserve original content for rollback
      if (fs.existsSync(agentFilePath)) {
        originalContent = fs.readFileSync(agentFilePath, 'utf-8');
      }

      // Ensure the agents directory exists
      if (!fs.existsSync(this.agentsDir)) {
        fs.mkdirSync(this.agentsDir, { recursive: true });
      }

      fs.writeFileSync(agentFilePath, proposal.proposed_definition, { encoding: 'utf-8' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failResult(agentName, previousVersion, newVersion, `Failed to write agent file: ${message}`);
    }

    // Step 4: Commit to git
    let commitHash: string;
    try {
      commitHash = this.commitToGit(agentName, previousVersion, newVersion, proposal);
    } catch (err) {
      // Rollback: restore original file
      this.rollbackFile(agentFilePath, originalContent);
      const message = err instanceof Error ? err.message : String(err);
      logPromoterEvent('promotion_git_failure_rollback', {
        agentName,
        proposalId,
        error: message,
      });
      return this.failResult(agentName, previousVersion, newVersion, `Git commit failed: ${message}`);
    }

    // Step 5: Reload registry and verify
    try {
      await this.registry.reload(this.agentsDir);

      const record = this.registry.get(agentName);
      if (!record || record.agent.version !== newVersion) {
        logPromoterEvent('promotion_registry_version_mismatch', {
          agentName,
          expectedVersion: newVersion,
          actualVersion: record?.agent.version ?? 'not found',
          commitHash,
        });
        // Critical: file is committed but registry is stale.
        // Log but continue -- operator must manually reload.
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          event_type: 'agent_state_changed',
          agent_name: agentName,
          details: {
            event: 'promotion_registry_reload_version_mismatch',
            commitHash,
            expectedVersion: newVersion,
            actualVersion: record?.agent.version ?? 'not found',
            severity: 'critical',
          },
        });
      }
    } catch (err) {
      // Critical: file is committed but registry reload failed.
      const message = err instanceof Error ? err.message : String(err);
      logPromoterEvent('promotion_registry_reload_failed', {
        agentName,
        commitHash,
        error: message,
        severity: 'critical',
      });
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        event_type: 'agent_state_changed',
        agent_name: agentName,
        details: {
          event: 'promotion_registry_reload_failed',
          commitHash,
          error: message,
          severity: 'critical',
        },
      });
      // Do NOT return failure -- the commit succeeded. Continue with state updates.
    }

    // Step 6: Update state and records
    this.updateStateAfterPromotion(proposal, agentName, previousVersion, newVersion, commitHash);

    return {
      success: true,
      agentName,
      previousVersion,
      newVersion,
      commitHash,
    };
  }

  /**
   * Execute the promotion workflow with a custom commit message.
   *
   * Used by the AutoPromoter to override the default conventional
   * commit message with an auto-promote-specific format.
   *
   * @param agentName      The name of the agent to promote.
   * @param proposalId     The ID of the proposal to promote.
   * @param commitMessage  Custom commit message to use instead of the default.
   * @returns              PromotionResult indicating success or failure.
   */
  async promoteWithMessage(
    agentName: string,
    proposalId: string,
    commitMessage: string,
  ): Promise<PromotionResult> {
    // Step 1: Validate prerequisites
    const proposal = this.proposalStore.getById(proposalId);
    if (!proposal) {
      return this.failResult(agentName, '', '', `Proposal '${proposalId}' not found`);
    }

    const prerequisiteError = this.validatePrerequisites(proposal, agentName);
    if (prerequisiteError) {
      return this.failResult(
        agentName,
        proposal.current_version,
        proposal.proposed_version,
        prerequisiteError,
      );
    }

    const previousVersion = proposal.current_version;
    const newVersion = proposal.proposed_version;

    // Step 2: Write new agent definition to disk
    const agentFilePath = path.join(this.agentsDir, `${agentName}.md`);
    let originalContent: string | null = null;

    try {
      if (fs.existsSync(agentFilePath)) {
        originalContent = fs.readFileSync(agentFilePath, 'utf-8');
      }
      if (!fs.existsSync(this.agentsDir)) {
        fs.mkdirSync(this.agentsDir, { recursive: true });
      }
      fs.writeFileSync(agentFilePath, proposal.proposed_definition, { encoding: 'utf-8' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.failResult(agentName, previousVersion, newVersion, `Failed to write agent file: ${message}`);
    }

    // Step 3: Commit to git with custom message
    let commitHash: string;
    try {
      const relativeAgentPath = `agents/${agentName}.md`;
      execSync(`git add ${relativeAgentPath}`, {
        cwd: this.projectRoot,
        stdio: 'pipe',
      });
      execSync(`git commit -m ${escapeShellArg(commitMessage)}`, {
        cwd: this.projectRoot,
        stdio: 'pipe',
      });
      commitHash = execSync('git rev-parse HEAD', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
    } catch (err) {
      this.rollbackFile(agentFilePath, originalContent);
      const message = err instanceof Error ? err.message : String(err);
      return this.failResult(agentName, previousVersion, newVersion, `Git commit failed: ${message}`);
    }

    // Step 4: Reload registry
    try {
      await this.registry.reload(this.agentsDir);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logPromoterEvent('promotion_registry_reload_failed', {
        agentName,
        commitHash,
        error: message,
        severity: 'critical',
      });
    }

    // Step 5: Update state
    this.updateStateAfterPromotion(proposal, agentName, previousVersion, newVersion, commitHash);

    return {
      success: true,
      agentName,
      previousVersion,
      newVersion,
      commitHash,
    };
  }

  /**
   * Build a human-readable review summary for the operator.
   *
   * This is the evidence block displayed before the operator confirms promotion.
   */
  buildReviewSummary(proposal: AgentProposal): string {
    const lines: string[] = [];

    lines.push(`Promotion Review: ${proposal.agent_name} (${proposal.current_version} -> ${proposal.proposed_version})`);
    lines.push('='.repeat(63));
    lines.push('');

    // Weakness Report Summary
    const weaknessReport = this.loadWeaknessReport(proposal.weakness_report_id);
    if (weaknessReport) {
      const dimensions = weaknessReport.weaknesses.map((w) => w.dimension).join(', ');
      lines.push('Weakness Report Summary:');
      lines.push(`  Assessment: ${weaknessReport.overall_assessment}`);
      lines.push(`  Weaknesses: ${weaknessReport.weaknesses.length} (${dimensions || 'none'})`);
      lines.push('');
    }

    // Meta-Review
    if (proposal.meta_review_id) {
      const metaReview = this.loadMetaReview(proposal.meta_review_id);
      if (metaReview) {
        const blockers = metaReview.findings.filter((f) => f.severity === 'blocker').length;
        const warnings = metaReview.findings.filter((f) => f.severity === 'warning').length;
        lines.push('Meta-Review:');
        lines.push(`  Verdict: ${metaReview.verdict}`);
        lines.push(`  Findings: ${metaReview.findings.length} (${blockers} blockers, ${warnings} warnings)`);
        lines.push('');
      }
    }

    // A/B Validation Results
    if (proposal.evaluation_id) {
      const evaluation = this.loadEvaluation(proposal.evaluation_id);
      if (evaluation) {
        const agg = evaluation.aggregate;
        lines.push('A/B Validation Results:');
        lines.push(`  Verdict: ${agg.verdict}`);
        lines.push(`  Proposed wins: ${agg.proposed_wins}/${agg.total_inputs} inputs`);
        lines.push(`  Mean quality delta: ${agg.mean_delta.toFixed(3)}`);
        lines.push('');

        // Per-Input Breakdown
        lines.push('  Per-Input Breakdown:');
        lines.push('  | Input | Domain | Current | Proposed | Delta | Winner |');
        lines.push('  |-------|--------|---------|----------|-------|--------|');
        for (const input of evaluation.inputs) {
          const domain = this.getInputDomain(input);
          const currentScore = input.version_a_scores.overall.toFixed(2);
          const proposedScore = input.version_b_scores.overall.toFixed(2);
          const delta = input.overall_delta.toFixed(2);
          const winner = formatOutcome(input.outcome);
          lines.push(`  | ${input.input_id.substring(0, 5)}... | ${domain} | ${currentScore} | ${proposedScore} | ${delta} | ${winner} |`);
        }
        lines.push('');

        // Per-Dimension Summary
        lines.push('  Per-Dimension Summary:');
        lines.push('  | Dimension | Mean Delta | Improved? |');
        lines.push('  |-----------|-----------|-----------|');
        for (const [dimName, dimSummary] of Object.entries(agg.per_dimension_summary)) {
          const improved = dimSummary.improved ? 'Yes' : 'No';
          lines.push(`  | ${dimName} | ${dimSummary.mean_delta.toFixed(3)} | ${improved} |`);
        }
        lines.push('');
      }
    }

    // Diff
    lines.push('Diff:');
    lines.push(proposal.diff);

    return lines.join('\n');
  }

  // -------------------------------------------------------------------------
  // Private: prerequisite validation
  // -------------------------------------------------------------------------

  /**
   * Validate all prerequisites before promotion.
   *
   * Returns an error string if any check fails, or null if all pass.
   */
  private validatePrerequisites(proposal: AgentProposal, agentName: string): string | null {
    // Proposal must belong to the specified agent
    if (proposal.agent_name !== agentName) {
      return `Proposal does not belong to this agent: proposal is for '${proposal.agent_name}', not '${agentName}'`;
    }

    // Proposal must have status validated_positive (or meta_approved for self-review bypass)
    const validStatuses = ['validated_positive', 'meta_approved'];
    if (!validStatuses.includes(proposal.status)) {
      return `Proposal must be validated_positive or meta_approved, current status: ${proposal.status}`;
    }

    // Agent must be in state VALIDATING (or UNDER_REVIEW for bypassed)
    const agentState = this.registry.getState(agentName);
    const validStates = ['VALIDATING', 'UNDER_REVIEW'];
    if (!agentState || !validStates.includes(agentState)) {
      return `Agent must be in VALIDATING or UNDER_REVIEW state, current state: ${agentState ?? 'not found'}`;
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // Private: git operations
  // -------------------------------------------------------------------------

  /**
   * Commit the agent file to git with a conventional commit message.
   *
   * @returns The commit hash of the new commit.
   * @throws  Error if the git commit fails.
   */
  private commitToGit(
    agentName: string,
    previousVersion: string,
    newVersion: string,
    proposal: AgentProposal,
  ): string {
    const commitMessage = this.buildCommitMessage(
      agentName,
      previousVersion,
      newVersion,
      proposal,
    );

    const relativeAgentPath = `agents/${agentName}.md`;

    // Stage the file
    execSync(`git add ${relativeAgentPath}`, {
      cwd: this.projectRoot,
      stdio: 'pipe',
    });

    // Commit
    execSync(`git commit -m ${escapeShellArg(commitMessage)}`, {
      cwd: this.projectRoot,
      stdio: 'pipe',
    });

    // Get the commit hash
    const commitHash = execSync('git rev-parse HEAD', {
      cwd: this.projectRoot,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();

    return commitHash;
  }

  /**
   * Build a conventional commit message following semver conventions (TDD 3.6.2).
   *
   * - `feat(agents):` for minor and major bumps.
   * - `fix(agents):` for patch bumps.
   * - Rationale is a one-line summary from the weakness report's primary weakness.
   */
  private buildCommitMessage(
    agentName: string,
    previousVersion: string,
    newVersion: string,
    proposal: AgentProposal,
  ): string {
    const prefix = this.getCommitPrefix(proposal.version_bump);
    const rationale = this.extractRationale(proposal);
    return `${prefix} update ${agentName} v${previousVersion} -> v${newVersion} -- ${rationale}`;
  }

  /**
   * Get the commit message prefix based on version bump type.
   */
  private getCommitPrefix(versionBump: VersionBump): string {
    switch (versionBump) {
      case 'major':
      case 'minor':
        return 'feat(agents):';
      case 'patch':
        return 'fix(agents):';
      default:
        return 'feat(agents):';
    }
  }

  /**
   * Extract a one-line rationale from the weakness report's primary weakness.
   */
  private extractRationale(proposal: AgentProposal): string {
    const weaknessReport = this.loadWeaknessReport(proposal.weakness_report_id);
    if (weaknessReport && weaknessReport.weaknesses.length > 0) {
      const primary = weaknessReport.weaknesses[0];
      return `${primary.dimension}: ${primary.suggested_focus}`;
    }
    // Fallback to the proposal's rationale field
    return proposal.rationale;
  }

  // -------------------------------------------------------------------------
  // Private: state updates
  // -------------------------------------------------------------------------

  /**
   * Update all tracking state after a successful promotion.
   */
  private updateStateAfterPromotion(
    proposal: AgentProposal,
    agentName: string,
    previousVersion: string,
    newVersion: string,
    commitHash: string,
  ): void {
    // Update proposal status to promoted
    try {
      this.proposalStore.updateStatus(proposal.proposal_id, 'promoted');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logPromoterEvent('promotion_status_update_failed', {
        proposalId: proposal.proposal_id,
        error: message,
      });
    }

    // Transition agent state: VALIDATING -> PROMOTED -> ACTIVE
    // (PROMOTED is a transient state)
    try {
      this.registry.setState(agentName, 'PROMOTED');
      this.registry.setState(agentName, 'ACTIVE');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logPromoterEvent('promotion_state_transition_failed', {
        agentName,
        error: message,
      });
    }

    // Reset observation tracker
    this.observationTracker.resetForPromotion(agentName, newVersion);

    // Audit log: agent_promoted
    this.auditLogger.log({
      timestamp: new Date().toISOString(),
      event_type: 'agent_state_changed',
      agent_name: agentName,
      details: {
        event: 'agent_promoted',
        previousVersion,
        newVersion,
        commitHash,
        proposalId: proposal.proposal_id,
      },
    });

    logPromoterEvent('agent_promoted', {
      agentName,
      previousVersion,
      newVersion,
      commitHash,
      proposalId: proposal.proposal_id,
    });
  }

  // -------------------------------------------------------------------------
  // Private: rollback and error helpers
  // -------------------------------------------------------------------------

  /**
   * Rollback a file to its original content, or delete it if there was no original.
   */
  private rollbackFile(filePath: string, originalContent: string | null): void {
    try {
      if (originalContent !== null) {
        fs.writeFileSync(filePath, originalContent, { encoding: 'utf-8' });
      } else if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logPromoterEvent('promotion_rollback_failed', {
        filePath,
        error: message,
      });
    }
  }

  /**
   * Build a failed PromotionResult.
   */
  private failResult(
    agentName: string,
    previousVersion: string,
    newVersion: string,
    error: string,
  ): PromotionResult {
    logPromoterEvent('promotion_failed', { agentName, error });
    return {
      success: false,
      agentName,
      previousVersion,
      newVersion,
      commitHash: '',
      error,
    };
  }

  // -------------------------------------------------------------------------
  // Private: display helpers
  // -------------------------------------------------------------------------

  /**
   * Get the domain for an ABInput. Uses the input_id to look up from
   * the evaluation inputs if available; falls back to 'unknown'.
   */
  private getInputDomain(input: ABInput): string {
    return input.selection_reason || 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Format an A/B input outcome for display.
 */
function formatOutcome(outcome: 'proposed_wins' | 'current_wins' | 'tie'): string {
  switch (outcome) {
    case 'proposed_wins':
      return 'Proposed';
    case 'current_wins':
      return 'Current';
    case 'tie':
      return 'Tie';
  }
}

/**
 * Escape a string for safe use as a shell argument.
 */
function escapeShellArg(arg: string): string {
  // Use single quotes with internal single quotes escaped
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}
