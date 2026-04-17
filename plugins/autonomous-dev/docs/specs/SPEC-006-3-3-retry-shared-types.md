# SPEC-006-3-3: Retry Policy, Escalation, and Shared Types Pre-Commit

## Metadata
- **Parent Plan**: PLAN-006-3
- **Tasks Covered**: Task 7, Task 8, Task 9
- **Estimated effort**: 13 hours

## Description

Implement the retry handler that manages agent failure recovery (one retry with worktree reset, then escalation), the shared types pre-commit that seeds the integration branch with shared type definitions before tracks execute, and comprehensive tests for all agent assignment components.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/retry-handler.ts` | **Create** | Retry state machine, worktree reset, escalation |
| `src/parallel/agent-spawner.ts` | **Modify** | Add shared types pre-commit logic |
| `tests/parallel/retry-handler.test.ts` | **Create** | Retry/escalation tests |
| `tests/parallel/agent-spawner.test.ts` | **Modify** | Add shared types tests |
| `tests/parallel/isolation-hook.test.ts` | **Modify** | Add comprehensive security tests |

## Implementation Details

### 1. Retry handler (`src/parallel/retry-handler.ts`)

```typescript
export enum FailureMode {
  AgentCrash = 'agent_crash',
  BudgetExhausted = 'budget_exhausted',
  PersistentTestFailures = 'persistent_test_failures',
}

export interface RetryDecision {
  action: 'retry' | 'escalate' | 'continue';
  reason: string;
  preservePartialWork: boolean;
}

export class RetryHandler {
  constructor(
    private worktreeManager: WorktreeManager,
    private agentSpawner: AgentSpawner,
    private statePersister: StatePersister,
    private eventEmitter: EventEmitter
  ) {}

  /**
   * Decide what to do after a track failure.
   */
  async handleFailure(
    requestId: string,
    assignment: TrackAssignment,
    failureMode: FailureMode
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
    requestId: string,
    assignment: TrackAssignment,
    failureMode: FailureMode
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
    requestId: string,
    assignment: TrackAssignment,
    failureMode: FailureMode
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
    requestId: string,
    assignment: TrackAssignment,
    failureMode: FailureMode
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
        { encoding: 'utf-8' }
      ).trim();
      return result.length > 0;
    } catch {
      return false;
    }
  }
}
```

### 2. Shared types pre-commit (`agent-spawner.ts`)

Before tracks in a cluster begin execution, shared type definitions and interface contracts are committed to the integration branch so all tracks inherit them.

```typescript
// In AgentSpawner or as standalone function:

export async function preCommitSharedTypes(
  requestId: string,
  interfaceContracts: InterfaceContract[],
  worktreeManager: WorktreeManager,
  repoRoot: string
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
```

**Directory layout for shared types**:
```
src/
  shared/
    contracts/
      track-a-track-b-type-definition.ts
      track-a-track-c-function-signature.ts
```

### 3. Comprehensive tests

```typescript
// retry-handler.test.ts

describe('RetryHandler', () => {
  describe('first failure', () => {
    it('retries from scratch when no partial work', async () => {
      assignment.retryCount = 0;
      // No commits beyond branch point
      const decision = await retryHandler.handleFailure('req-001', assignment, FailureMode.AgentCrash);
      expect(decision.action).toBe('retry');
      expect(decision.preservePartialWork).toBe(false);
      expect(assignment.retryCount).toBe(1);
    });

    it('resets worktree on scratch retry', async () => {
      assignment.retryCount = 0;
      // Write a dirty file
      fs.writeFileSync(path.join(assignment.worktreePath, 'dirty.txt'), 'untracked');
      await retryHandler.handleFailure('req-001', assignment, FailureMode.AgentCrash);
      // Verify worktree is clean
      const status = execSync(`git -C "${assignment.worktreePath}" status --porcelain`).toString().trim();
      expect(status).toBe('');
    });

    it('preserves partial work when commits exist', async () => {
      assignment.retryCount = 0;
      // Create a commit in the worktree
      execSync(`git -C "${assignment.worktreePath}" commit --allow-empty -m "partial work"`);
      const decision = await retryHandler.handleFailure('req-001', assignment, FailureMode.AgentCrash);
      expect(decision.action).toBe('continue');
      expect(decision.preservePartialWork).toBe(true);
    });

    it('resets turnsUsed on scratch retry', async () => {
      assignment.retryCount = 0;
      assignment.turnsUsed = 25;
      await retryHandler.handleFailure('req-001', assignment, FailureMode.BudgetExhausted);
      expect(assignment.turnsUsed).toBe(0);
    });

    it('keeps turnsUsed on continuation', async () => {
      assignment.retryCount = 0;
      assignment.turnsUsed = 25;
      // Add partial work
      execSync(`git -C "${assignment.worktreePath}" commit --allow-empty -m "partial"`);
      await retryHandler.handleFailure('req-001', assignment, FailureMode.AgentCrash);
      expect(assignment.turnsUsed).toBe(25);
    });
  });

  describe('second failure', () => {
    it('escalates on second failure', async () => {
      assignment.retryCount = 1; // already retried once
      const decision = await retryHandler.handleFailure('req-001', assignment, FailureMode.AgentCrash);
      expect(decision.action).toBe('escalate');
      expect(assignment.retryCount).toBe(2);
    });

    it('emits agent.failed with escalated action', async () => {
      assignment.retryCount = 1;
      const events: any[] = [];
      emitter.on('agent.failed', e => events.push(e));
      await retryHandler.handleFailure('req-001', assignment, FailureMode.PersistentTestFailures);
      expect(events[0].action).toBe('escalated');
    });
  });

  describe('failure modes', () => {
    it('handles agent crash', async () => {
      const decision = await retryHandler.handleFailure('req-001', assignment, FailureMode.AgentCrash);
      expect(decision.reason).toContain('agent_crash');
    });

    it('handles budget exhaustion', async () => {
      const decision = await retryHandler.handleFailure('req-001', assignment, FailureMode.BudgetExhausted);
      expect(decision.reason).toContain('budget_exhausted');
    });

    it('handles persistent test failures', async () => {
      const decision = await retryHandler.handleFailure('req-001', assignment, FailureMode.PersistentTestFailures);
      expect(decision.reason).toContain('persistent_test_failures');
    });
  });
});

// agent-spawner.test.ts (shared types section)

describe('preCommitSharedTypes', () => {
  it('commits shared types to integration branch', async () => {
    const contracts: InterfaceContract[] = [{
      producer: 'track-a',
      consumer: 'track-b',
      contractType: 'type-definition',
      definition: 'export interface User { id: string; name: string; }',
      filePath: 'src/types.ts',
    }];

    await preCommitSharedTypes('req-001', contracts, worktreeManager, repoRoot);

    // Verify the commit exists on the integration branch
    const log = execSync(
      `git -C "${repoRoot}" log --oneline auto/req-001/integration -1`,
      { encoding: 'utf-8' }
    ).trim();
    expect(log).toContain('shared types');
  });

  it('creates correct file structure', async () => {
    const contracts: InterfaceContract[] = [{
      producer: 'track-a',
      consumer: 'track-b',
      contractType: 'type-definition',
      definition: 'export interface User {}',
      filePath: 'src/types.ts',
    }];

    await preCommitSharedTypes('req-001', contracts, worktreeManager, repoRoot);

    // Check that the file exists on the integration branch
    const content = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:src/shared/contracts/track-a-track-b-type-definition.ts`,
      { encoding: 'utf-8' }
    ).trim();
    expect(content).toBe('export interface User {}');
  });

  it('is a no-op when no contracts', async () => {
    await preCommitSharedTypes('req-001', [], worktreeManager, repoRoot);
    // No error, no commit created
  });

  it('cleans up temporary worktree after commit', async () => {
    const contracts: InterfaceContract[] = [{
      producer: 'track-a',
      consumer: 'track-b',
      contractType: 'type-definition',
      definition: 'export interface User {}',
      filePath: 'src/types.ts',
    }];

    await preCommitSharedTypes('req-001', contracts, worktreeManager, repoRoot);

    // Temp worktree should be removed
    const worktrees = await worktreeManager.listWorktrees('req-001');
    expect(worktrees.find(w => w.trackName === 'shared-types-commit')).toBeUndefined();
  });
});
```

## Acceptance Criteria

1. First failure with no partial work: resets worktree via `git reset --hard HEAD && git clean -fd`, resets to integration branch point, re-queues for fresh agent.
2. First failure with partial commits: preserves existing commits, spawns continuation agent.
3. Second failure: permanently escalates track, emits `agent.failed` with action `escalated`.
4. `retryCount` is incremented and persisted on each failure.
5. Worktree reset produces a clean working tree matching the integration branch.
6. All three failure modes (crash, budget, test failure) handled correctly.
7. `preCommitSharedTypes` creates shared type files in `src/shared/contracts/` on the integration branch.
8. `preCommitSharedTypes` cleans up the temporary worktree after committing.
9. `preCommitSharedTypes` is a no-op when there are no interface contracts.
10. Track worktrees created after the shared types commit inherit the shared types.
11. All events (agent.failed with retryCount and reason) emitted correctly.

## Test Cases

See detailed test code in Implementation Details section 3 above.

| Test Category | Count | Focus |
|---------------|-------|-------|
| First failure retry | 5 | Scratch reset, partial work preservation, turn reset |
| Second failure escalation | 2 | Escalation and event emission |
| Failure mode handling | 3 | Crash, budget, test failures |
| Shared types pre-commit | 4 | Commit creation, file structure, no-op, cleanup |
