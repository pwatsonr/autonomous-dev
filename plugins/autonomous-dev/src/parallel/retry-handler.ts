/**
 * Retry handler for agent failure recovery.
 *
 * SPEC-006-3-3: Retry Policy, Escalation, and Shared Types Pre-Commit
 *
 * Implements a retry state machine with the following policy:
 *   - First failure with no partial work: reset worktree, retry from scratch
 *   - First failure with partial commits: preserve work, spawn continuation agent
 *   - Second failure: permanently escalate to human
 *
 * Worktree reset follows TDD 3.4.5:
 *   git reset --hard HEAD
 *   git clean -fd
 *   git reset --hard <integration-branch>
 */

import { execSync } from 'child_process';
import { EventEmitter } from 'events';

import { AgentSpawner } from './agent-spawner';
import { StatePersister } from './state-persister';
import { WorktreeManager } from './worktree-manager';
import type { TrackAssignment } from './types';
import { AgentLifecyclePhase } from './types';

// ============================================================================
// Failure modes
// ============================================================================

export enum FailureMode {
  AgentCrash = 'agent_crash',
  BudgetExhausted = 'budget_exhausted',
  PersistentTestFailures = 'persistent_test_failures',
}

// ============================================================================
// Retry decision
// ============================================================================

export interface RetryDecision {
  action: 'retry' | 'escalate' | 'continue';
  reason: string;
  preservePartialWork: boolean;
}

// ============================================================================
// RetryHandler
// ============================================================================

export class RetryHandler {
  constructor(
    private worktreeManager: WorktreeManager,
    private agentSpawner: AgentSpawner,
    private statePersister: StatePersister,
    private eventEmitter: EventEmitter,
  ) {}

  /**
   * Decide what to do after a track failure.
   *
   * Policy:
   *   1. Increment retryCount
   *   2. If retryCount > 1 (second failure), escalate
   *   3. Otherwise (first failure), check for partial work:
   *      - No partial work: reset worktree, retry from scratch
   *      - Partial work: preserve commits, spawn continuation agent
   */
  async handleFailure(
    requestId: string,
    assignment: TrackAssignment,
    failureMode: FailureMode,
  ): Promise<RetryDecision> {
    assignment.retryCount++;

    if (assignment.retryCount > 1) {
      // Second failure -> escalate
      return this.escalate(requestId, assignment, failureMode);
    }

    // First failure -> check for partial work, then retry
    const hasPartialWork = await this.checkPartialWork(assignment);

    if (hasPartialWork) {
      return this.retryWithPartialWork(requestId, assignment, failureMode);
    } else {
      return this.retryFromScratch(requestId, assignment, failureMode);
    }
  }

  private async retryFromScratch(
    _requestId: string,
    assignment: TrackAssignment,
    failureMode: FailureMode,
  ): Promise<RetryDecision> {
    // Reset the worktree to clean state
    await this.resetWorktree(assignment);

    // Update state
    assignment.lifecyclePhase = AgentLifecyclePhase.Spawning;
    assignment.turnsUsed = 0;
    assignment.agentSessionId = null;
    assignment.startedAt = null;

    this.eventEmitter.emit('agent.failed', {
      type: 'agent.failed',
      trackName: assignment.trackName,
      retryCount: assignment.retryCount,
      reason: failureMode,
      action: 'retry_from_scratch',
      timestamp: new Date().toISOString(),
    });

    return {
      action: 'retry',
      reason: `First failure (${failureMode}): retrying from scratch`,
      preservePartialWork: false,
    };
  }

  private async retryWithPartialWork(
    _requestId: string,
    assignment: TrackAssignment,
    failureMode: FailureMode,
  ): Promise<RetryDecision> {
    // Keep existing commits; spawn a continuation agent
    assignment.lifecyclePhase = AgentLifecyclePhase.Spawning;
    assignment.agentSessionId = null;
    // Do NOT reset turnsUsed -- continuation agent picks up where we left off

    this.eventEmitter.emit('agent.failed', {
      type: 'agent.failed',
      trackName: assignment.trackName,
      retryCount: assignment.retryCount,
      reason: failureMode,
      action: 'retry_continue',
      timestamp: new Date().toISOString(),
    });

    return {
      action: 'continue',
      reason: `First failure (${failureMode}): partial work found, spawning continuation agent`,
      preservePartialWork: true,
    };
  }

  private async escalate(
    _requestId: string,
    assignment: TrackAssignment,
    failureMode: FailureMode,
  ): Promise<RetryDecision> {
    assignment.lifecyclePhase = AgentLifecyclePhase.Failed;

    this.eventEmitter.emit('agent.failed', {
      type: 'agent.failed',
      trackName: assignment.trackName,
      retryCount: assignment.retryCount,
      reason: failureMode,
      action: 'escalated',
      timestamp: new Date().toISOString(),
    });

    return {
      action: 'escalate',
      reason: `Second failure (${failureMode}): escalating to human`,
      preservePartialWork: false,
    };
  }

  /**
   * Reset worktree to clean state for retry.
   * Exact git commands per TDD 3.4.5:
   *   1. git reset --hard HEAD (discard uncommitted changes)
   *   2. git clean -fd (remove untracked files/directories)
   *   3. git reset --hard <integration-branch> (discard failed agent's commits)
   */
  private async resetWorktree(assignment: TrackAssignment): Promise<void> {
    const cwd = assignment.worktreePath;

    // Hard reset to HEAD (discard all uncommitted changes)
    execSync(`git -C "${cwd}" reset --hard HEAD`);

    // Clean untracked files and directories
    execSync(`git -C "${cwd}" clean -fd`);

    // Reset to integration branch point (discard failed agent's commits)
    const integrationBranch = assignment.branchName.replace(/\/[^/]+$/, '/integration');
    execSync(`git -C "${cwd}" reset --hard ${integrationBranch}`);
  }

  /**
   * Check if the crashed agent left commits beyond the branch point.
   */
  private async checkPartialWork(assignment: TrackAssignment): Promise<boolean> {
    try {
      const integrationBranch = assignment.branchName.replace(/\/[^/]+$/, '/integration');
      const result = execSync(
        `git -C "${assignment.worktreePath}" log --oneline ${integrationBranch}..HEAD`,
        { encoding: 'utf-8' },
      ).trim();
      return result.length > 0;
    } catch {
      return false;
    }
  }
}
