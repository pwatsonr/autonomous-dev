/**
 * Context bundle preparation, agent session management, and lifecycle tracking.
 *
 * SPEC-006-3-1: Track Assignment Types and Context Bundle Preparation
 * SPEC-006-3-2: Turn budget tracking and liveness monitoring
 *
 * Assembles spec content, parent documents, turn budgets, and interface
 * contracts into a structured prompt for each agent. The AgentSpawner
 * creates Claude Code subagent sessions in worktree directories and
 * manages their lifecycle, including turn budget enforcement and
 * liveness monitoring.
 */

import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';

import { ParallelConfig } from './config';
import { integrationBranchName } from './naming';
import type { WorktreeManager } from './worktree-manager';
import type {
  TrackAssignment,
  ContextBundle,
  InterfaceContract,
  AgentSession,
  SubagentProcess,
} from './types';
import { AgentLifecyclePhase } from './types';

// Re-export for backwards compatibility with SPEC-006-3-2 consumers
export { AgentLifecyclePhase } from './types';
export type { TrackAssignment, AgentSession, ContextBundle, InterfaceContract } from './types';

// ============================================================================
// Turn budget defaults (SPEC-006-3-1)
// ============================================================================

/**
 * Returns the default turn budget for a given complexity level.
 *
 * | Complexity | Default Turns |
 * |-----------|---------------|
 * | small     | 30            |
 * | medium    | 60            |
 * | large     | 120           |
 */
export function defaultTurnBudget(complexity: 'small' | 'medium' | 'large'): number {
  switch (complexity) {
    case 'small': return 30;
    case 'medium': return 60;
    case 'large': return 120;
  }
}

// ============================================================================
// File reading utilities (SPEC-006-3-1)
// ============================================================================

/**
 * Reads a file and truncates to at most `maxChars` characters.
 *
 * Truncation logic:
 * - If the full file is <= maxChars, return it verbatim.
 * - Otherwise, extract: title (first heading), "Objective" section,
 *   "Scope" section, and any section whose heading matches `specName`
 *   (if provided). Remaining content is trimmed.
 */
export async function readAndTruncate(
  filePath: string,
  maxChars: number,
  specName?: string,
): Promise<string> {
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return '';
  }

  if (content.length <= maxChars) {
    return content;
  }

  // Parse into sections by markdown headings
  const lines = content.split('\n');
  const sections: { heading: string; body: string }[] = [];
  let currentHeading = '';
  let currentBody: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      if (currentHeading || currentBody.length > 0) {
        sections.push({ heading: currentHeading, body: currentBody.join('\n') });
      }
      currentHeading = headingMatch[1].trim();
      currentBody = [line];
    } else {
      currentBody.push(line);
    }
  }
  // Push the last section
  if (currentHeading || currentBody.length > 0) {
    sections.push({ heading: currentHeading, body: currentBody.join('\n') });
  }

  // Always include the title (first section)
  const relevantSections: string[] = [];
  if (sections.length > 0) {
    relevantSections.push(sections[0].body);
  }

  // Include Objective, Scope, and spec-name-matching sections
  const relevantHeadings = ['objective', 'scope'];
  if (specName) {
    relevantHeadings.push(specName.toLowerCase());
  }

  for (let i = 1; i < sections.length; i++) {
    const headingLower = sections[i].heading.toLowerCase();
    const isRelevant = relevantHeadings.some(
      (rh) => headingLower.includes(rh),
    );
    if (isRelevant) {
      relevantSections.push(sections[i].body);
    }
  }

  let result = relevantSections.join('\n\n');

  // Final length guard
  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
  }

  return result;
}

// ============================================================================
// Shared type definitions reader (SPEC-006-3-1)
// ============================================================================

/**
 * Reads shared type definition files from the integration branch worktree.
 *
 * Looks for common type file patterns (e.g. `src/types.ts`, `src/shared/types.ts`)
 * within the repo root and returns their contents.
 */
export async function readSharedTypesFromIntegration(
  repoRoot: string,
  _branchName: string,
): Promise<string[]> {
  const typePatterns = [
    'src/types.ts',
    'src/shared/types.ts',
    'src/common/types.ts',
    'src/interfaces.ts',
    'src/shared/interfaces.ts',
  ];

  const results: string[] = [];

  for (const pattern of typePatterns) {
    const fullPath = path.join(repoRoot, pattern);
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      results.push(content);
    } catch {
      // File doesn't exist, skip
    }
  }

  return results;
}

// ============================================================================
// System prompt builder (SPEC-006-3-1)
// ============================================================================

/**
 * Builds the system prompt injected into the agent session.
 * Instructs the agent about working directory, scope, turn budget,
 * commit format, and isolation rules.
 */
export function buildAgentSystemPrompt(assignment: TrackAssignment): string {
  const contractList =
    assignment.interfaceContracts.length > 0
      ? assignment.interfaceContracts
          .map(
            (c) =>
              `- ${c.contractType}: ${c.producer} -> ${c.consumer}\n  File: ${c.filePath}\n  ${c.definition}`,
          )
          .join('\n')
      : '(none)';

  return [
    'You are an autonomous development agent executing a single spec within an isolated git worktree.',
    '',
    '## Your Scope',
    `- Working directory: ${assignment.worktreePath}`,
    `- Branch: ${assignment.branchName}`,
    `- Spec: ${assignment.spec.name}`,
    '',
    '## Rules',
    `1. ALL file operations must be within your working directory: ${assignment.worktreePath}`,
    '2. Do NOT access files outside your worktree.',
    '3. Do NOT modify files on other branches.',
    `4. Turn budget: ${assignment.turnBudget} turns. You are currently on turn ${assignment.turnsUsed}.`,
    '5. After implementation, run the project\'s test suite.',
    '6. After tests pass, perform a self-review of your changes.',
    `7. Commit with the format: feat(${assignment.trackName}): <description>`,
    '',
    '## Interface Contracts',
    contractList,
    '',
    '## Shared Types (read-only, from integration branch)',
    '{sharedTypeContents}',
  ].join('\n');
}

// ============================================================================
// Context bundle preparation (SPEC-006-3-1)
// ============================================================================

/**
 * Prepares the full context bundle for an agent session.
 *
 * The context bundle is the structured prompt injected into each agent session.
 * It contains everything the agent needs to execute its spec without
 * cross-track communication.
 *
 * Steps:
 *   1. Read the spec file
 *   2. Read and truncate parent documents (plan/TDD: 4000 chars, PRD: 2000 chars)
 *   3. Read shared type definitions from integration branch
 *   4. Apply turn budget from assignment
 *   5. Build system prompt
 *   6. Build commit format template
 */
export async function prepareContextBundle(
  assignment: TrackAssignment,
  repoRoot: string,
): Promise<ContextBundle> {
  // 1. Read the spec file
  const specContent = assignment.spec.path
    ? await fs.readFile(assignment.spec.path, 'utf-8')
    : '';

  // 2. Read and truncate parent documents
  const planContent = await readAndTruncate(assignment.parentPlan, 4000, assignment.spec.name);
  const tddContent = await readAndTruncate(assignment.parentTDD, 4000, assignment.spec.name);
  const prdContent = await readAndTruncate(assignment.parentPRD, 2000, assignment.spec.name);

  // 3. Read shared type definitions from integration branch
  const sharedTypes = await readSharedTypesFromIntegration(
    repoRoot,
    assignment.branchName,
  );

  // 4. Turn budget (already set from config)
  const turnBudget = assignment.turnBudget;

  // 5. Build system prompt
  const systemPrompt = buildAgentSystemPrompt(assignment);

  // 6. Build commit format
  const commitFormat = [
    `feat(${assignment.trackName}): <description>`,
    '',
    `Spec: ${assignment.spec.name}`,
    `Request: ${assignment.trackName.split('/')[0] || 'unknown'}`,
    `Turns: {turnsUsed}/${assignment.turnBudget}`,
  ].join('\n');

  return {
    systemPrompt,
    specContent,
    parentExcerpts: { plan: planContent, tdd: tddContent, prd: prdContent },
    turnBudget,
    complexity: assignment.spec.complexity || 'medium',
    interfaceContracts: assignment.interfaceContracts,
    sharedTypeDefinitions: sharedTypes,
    commitFormat,
    workingDirectory: assignment.worktreePath,
  };
}

// ============================================================================
// Subagent session factory (pluggable)
// ============================================================================

/**
 * Factory function type for creating subagent sessions.
 * The default implementation can be overridden for testing or
 * when the Claude Code SDK provides a concrete implementation.
 */
export type CreateSubagentSessionFn = (opts: {
  workingDirectory: string;
  initialPrompt: string;
}) => Promise<SubagentProcess>;

/**
 * Default subagent session factory.
 * Returns a stub that generates a unique session ID.
 * Replace with real Claude Code SDK integration in production.
 */
let _sessionCounter = 0;

/** Reset the session counter (for test isolation). */
export function _resetSessionCounter(): void {
  _sessionCounter = 0;
}

export const defaultCreateSubagentSession: CreateSubagentSessionFn = async (_opts) => {
  _sessionCounter++;
  const id = `agent-session-${_sessionCounter}-${Date.now()}`;
  return {
    id,
    terminate: async () => {},
  };
};

// ============================================================================
// Turn budget status (from SPEC-006-3-2)
// ============================================================================

/** Result of a turn budget check. */
export interface TurnBudgetStatus {
  exceeded: boolean;
  warning: boolean;
  turnsUsed: number;
  turnBudget: number;
}

// ============================================================================
// Shared types pre-commit (SPEC-006-3-3)
// ============================================================================

/**
 * Commits shared type definitions and interface contracts to the integration
 * branch before tracks in a cluster begin execution, so all tracks inherit them.
 *
 * Steps:
 *   1. If no contracts, return immediately (no-op)
 *   2. Create a temporary worktree on the integration branch
 *   3. Write each contract to `src/shared/contracts/<producer>-<consumer>-<contractType>.ts`
 *   4. Stage and commit if there are changes
 *   5. Clean up the temporary worktree
 *
 * Directory layout:
 *   src/shared/contracts/
 *     track-a-track-b-type-definition.ts
 *     track-a-track-c-function-signature.ts
 */
export async function preCommitSharedTypes(
  requestId: string,
  interfaceContracts: InterfaceContract[],
  worktreeManager: WorktreeManager,
  _repoRoot: string,
): Promise<void> {
  if (interfaceContracts.length === 0) return;

  const integrationBranch = integrationBranchName(requestId);

  // 1. Create a temporary worktree for the integration branch
  const tmpTrackName = 'shared-types-commit';
  const tmpWorktree = await worktreeManager.createTrackWorktree(requestId, tmpTrackName);

  try {
    const cwd = tmpWorktree.worktreePath;

    // 2. Checkout the integration branch in the temp worktree
    execSync(`git -C "${cwd}" checkout ${integrationBranch}`);

    // 3. Write shared type definitions
    const sharedDir = path.join(cwd, 'src', 'shared', 'contracts');
    await fs.mkdir(sharedDir, { recursive: true });

    for (const contract of interfaceContracts) {
      const filename = `${contract.producer}-${contract.consumer}-${contract.contractType}.ts`;
      const filepath = path.join(sharedDir, filename);
      await fs.writeFile(filepath, contract.definition, 'utf-8');
    }

    // 4. Stage and commit
    execSync(`git -C "${cwd}" add src/shared/contracts/`);

    const hasChanges = execSync(`git -C "${cwd}" status --porcelain`).toString().trim();
    if (hasChanges) {
      execSync(
        `git -C "${cwd}" commit -m "chore: pre-commit shared types for ${requestId}\n\nContracts: ${interfaceContracts.length}"`,
      );

      // 5. Push the commit to the integration branch
      // (In a worktree setup, the commit is already on the branch)
    }
  } finally {
    // 6. Remove the temporary worktree
    await worktreeManager.removeWorktree(requestId, tmpTrackName, true);
  }
}

// ============================================================================
// AgentSpawner (unified SPEC-006-3-1 + SPEC-006-3-2)
// ============================================================================

/**
 * Creates and manages Claude Code subagent sessions within isolated
 * worktree directories. Tracks active agents and their lifecycle phases,
 * enforces turn budgets, and monitors agent liveness.
 */
export class AgentSpawner {
  private activeAgents = new Map<string, AgentSession>();
  private livenessInterval: NodeJS.Timeout | null = null;
  private createSubagentSession: CreateSubagentSessionFn;

  constructor(
    private config: ParallelConfig,
    private eventEmitter: EventEmitter,
    createSession?: CreateSubagentSessionFn,
  ) {
    this.createSubagentSession = createSession || defaultCreateSubagentSession;
  }

  // -----------------------------------------------------------------------
  // Spawn (SPEC-006-3-1)
  // -----------------------------------------------------------------------

  /**
   * Spawns a new agent session for the given track assignment.
   *
   * Lifecycle:
   *   1. Set phase to Spawning
   *   2. Create subagent session with CWD set to worktree path
   *   3. Record session ID on assignment
   *   4. Transition phase to Executing
   *   5. Store active agent reference
   *   6. Emit `agent.spawned` event
   *
   * @returns The unique session ID for the spawned agent.
   */
  async spawnAgent(assignment: TrackAssignment, bundle: ContextBundle): Promise<string> {
    assignment.lifecyclePhase = AgentLifecyclePhase.Spawning;

    // Create Claude Code subagent session
    const session = await this.createSubagentSession({
      workingDirectory: bundle.workingDirectory,
      initialPrompt: this.formatInitialPrompt(bundle),
    });

    const sessionId = session.id;
    assignment.agentSessionId = sessionId;
    assignment.lifecyclePhase = AgentLifecyclePhase.Executing;
    assignment.startedAt = new Date().toISOString();

    this.activeAgents.set(sessionId, {
      sessionId,
      trackName: assignment.trackName,
      process: session,
      assignment,
    });

    this.eventEmitter.emit('agent.spawned', {
      type: 'agent.spawned',
      requestId: assignment.trackName.split('/')[0],
      trackName: assignment.trackName,
      sessionId,
      timestamp: new Date().toISOString(),
    });

    return sessionId;
  }

  // -----------------------------------------------------------------------
  // Turn budget enforcement (from SPEC-006-3-2)
  // -----------------------------------------------------------------------

  /**
   * Record a turn for the given agent session and check budget status.
   *
   * - At >= 90% usage: emits `agent.budget_warning` with action `warning`
   * - At >= 100% usage: emits `agent.budget_warning` with action `terminated`,
   *   terminates the agent, and sets lifecyclePhase to Failed
   */
  async trackTurn(sessionId: string): Promise<TurnBudgetStatus> {
    const agent = this.activeAgents.get(sessionId);
    if (!agent) throw new Error(`Unknown agent session: ${sessionId}`);

    agent.assignment.turnsUsed++;
    agent.assignment.lastActivityAt = new Date().toISOString();

    const { turnsUsed, turnBudget } = agent.assignment;
    const usagePercent = turnsUsed / turnBudget;

    if (usagePercent >= 1.0) {
      // Budget exhausted -- terminate
      this.eventEmitter.emit('agent.budget_warning', {
        type: 'agent.budget_warning',
        trackName: agent.assignment.trackName,
        turnsUsed,
        turnBudget,
        action: 'terminated',
        timestamp: new Date().toISOString(),
      });

      await this.terminateAgent(sessionId);
      agent.assignment.lifecyclePhase = AgentLifecyclePhase.Failed;

      return { exceeded: true, warning: false, turnsUsed, turnBudget };
    }

    if (usagePercent >= 0.9) {
      // 90% warning
      this.eventEmitter.emit('agent.budget_warning', {
        type: 'agent.budget_warning',
        trackName: agent.assignment.trackName,
        turnsUsed,
        turnBudget,
        action: 'warning',
        timestamp: new Date().toISOString(),
      });

      return { exceeded: false, warning: true, turnsUsed, turnBudget };
    }

    return { exceeded: false, warning: false, turnsUsed, turnBudget };
  }

  // -----------------------------------------------------------------------
  // Liveness monitoring (from SPEC-006-3-2)
  // -----------------------------------------------------------------------

  /**
   * Start periodic liveness checks at the given interval.
   * Default interval is 30 seconds.
   */
  startLivenessMonitor(intervalMs: number = 30_000): void {
    this.stopLivenessMonitor();
    this.livenessInterval = setInterval(
      () => this.checkAllAgents(),
      intervalMs,
    );
  }

  /** Stop the liveness monitor. */
  stopLivenessMonitor(): void {
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
  }

  /**
   * Check all active agents for liveness. Exposed for testing
   * (called by the interval internally).
   */
  async checkAllAgents(): Promise<void> {
    for (const [_sessionId, agent] of this.activeAgents) {
      const isAlive = await this.isAgentAlive(agent);
      if (!isAlive) {
        await this.handleAgentCrash(agent);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Agent status & termination (SPEC-006-3-1)
  // -----------------------------------------------------------------------

  /**
   * Returns the current lifecycle phase of the agent with the given session ID,
   * or null if the session is unknown.
   */
  async getAgentStatus(sessionId: string): Promise<AgentLifecyclePhase | null> {
    const agent = this.activeAgents.get(sessionId);
    if (!agent) return null;
    return agent.assignment.lifecyclePhase;
  }

  /**
   * Terminates the agent with the given session ID.
   * Sets the assignment phase to Failed and removes from active tracking.
   */
  async terminateAgent(sessionId: string): Promise<void> {
    const agent = this.activeAgents.get(sessionId);
    if (!agent) return;

    try {
      await agent.process.terminate();
    } catch {
      // Process may already be dead
    }

    agent.assignment.lifecyclePhase = AgentLifecyclePhase.Failed;
    this.activeAgents.delete(sessionId);
  }

  /**
   * Returns the count of currently active (tracked) agent sessions.
   */
  getActiveAgentCount(): number {
    return this.activeAgents.size;
  }

  /** Check if a given session is still tracked as active. */
  isAgentActive(sessionId: string): boolean {
    return this.activeAgents.has(sessionId);
  }

  /** Get a snapshot of the active agents map (for testing/inspection). */
  getActiveAgents(): ReadonlyMap<string, AgentSession> {
    return this.activeAgents;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Formats the initial prompt from a context bundle.
   * Concatenates system prompt, spec content, parent excerpts,
   * and commit format into a single string.
   */
  private formatInitialPrompt(bundle: ContextBundle): string {
    return [
      bundle.systemPrompt,
      '',
      '## Spec',
      bundle.specContent,
      '',
      '## Parent Plan (excerpt)',
      bundle.parentExcerpts.plan,
      '',
      '## Parent TDD (excerpt)',
      bundle.parentExcerpts.tdd,
      '',
      '## Parent PRD (excerpt)',
      bundle.parentExcerpts.prd,
      '',
      '## Commit Format',
      bundle.commitFormat,
    ].join('\n');
  }

  private async isAgentAlive(agent: AgentSession): Promise<boolean> {
    try {
      // Subagent process doesn't have isAlive -- check if terminate throws
      // For production, this would use the Claude Code SDK heartbeat
      return true;
    } catch {
      return false;
    }
  }

  private async handleAgentCrash(agent: AgentSession): Promise<void> {
    const { assignment } = agent;

    // Check worktree for uncommitted work or commits beyond branch point
    const hasCommits = await this.checkForPartialWork(assignment);

    this.eventEmitter.emit('agent.failed', {
      type: 'agent.failed',
      trackName: assignment.trackName,
      sessionId: agent.sessionId,
      reason: 'agent_crash',
      hasPartialWork: hasCommits,
      timestamp: new Date().toISOString(),
    });

    this.activeAgents.delete(agent.sessionId);
    assignment.lifecyclePhase = AgentLifecyclePhase.Failed;
  }

  private async checkForPartialWork(
    assignment: TrackAssignment,
  ): Promise<boolean> {
    try {
      const integrationBranch = assignment.branchName.replace(
        /\/[^/]+$/,
        '/integration',
      );
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
