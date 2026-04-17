# SPEC-006-3-2: Filesystem Isolation Hook and Turn Budget Enforcement

## Metadata
- **Parent Plan**: PLAN-006-3
- **Tasks Covered**: Task 4, Task 5, Task 6
- **Estimated effort**: 10 hours

## Description

Implement the PostToolUse hook that enforces filesystem isolation per agent (all file access must resolve within the assigned worktree), the turn budget tracking system that warns at 90% and terminates at 100%, and the liveness monitor that detects crashed agents every 30 seconds.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/isolation-hook.ts` | **Create** | PostToolUse path validation, symlink resolution, violation logging |
| `src/parallel/agent-spawner.ts` | **Modify** | Add turn budget tracking and liveness monitoring |
| `tests/parallel/isolation-hook.test.ts` | **Create** | Security tests including adversarial path fuzzing |
| `tests/parallel/agent-spawner.test.ts` | **Modify** | Add budget and liveness tests |

## Implementation Details

### 1. Filesystem isolation hook (`src/parallel/isolation-hook.ts`)

```typescript
export interface IsolationHookContext {
  trackName: string;
  worktreePath: string;  // absolute, normalized, resolved (no symlinks)
  eventEmitter: EventEmitter;
}

export class FilesystemIsolationHook {
  private resolvedWorktreePath: string;

  constructor(private context: IsolationHookContext) {
    // Pre-resolve the worktree path to its real path (follow symlinks)
    this.resolvedWorktreePath = fs.realpathSync(context.worktreePath);
  }

  /**
   * PostToolUse hook handler. Returns true to allow, false to block.
   * Called after every tool invocation by the agent.
   */
  async validate(toolName: string, toolInput: Record<string, any>): Promise<boolean> {
    // Extract file paths from tool input based on tool type
    const paths = this.extractPaths(toolName, toolInput);

    for (const targetPath of paths) {
      if (!this.isPathAllowed(targetPath)) {
        this.context.eventEmitter.emit('security.isolation_violation', {
          type: 'security.isolation_violation',
          trackName: this.context.trackName,
          toolName,
          attemptedPath: targetPath,
          worktreePath: this.context.worktreePath,
          timestamp: new Date().toISOString(),
        });

        return false; // block the tool call
      }
    }

    return true; // allow
  }

  /**
   * Core path validation logic.
   * 1. Resolve the path relative to the worktree CWD
   * 2. Follow all symlinks via realpath
   * 3. Verify the resolved path starts with the resolved worktree path
   */
  isPathAllowed(targetPath: string): boolean {
    try {
      // Step 1: Resolve relative paths against the worktree directory
      const absolutePath = path.isAbsolute(targetPath)
        ? targetPath
        : path.resolve(this.context.worktreePath, targetPath);

      // Step 2: Normalize to remove . and .. components
      const normalizedPath = path.normalize(absolutePath);

      // Step 3: Resolve symlinks (if the path exists)
      let resolvedPath: string;
      try {
        resolvedPath = fs.realpathSync(normalizedPath);
      } catch {
        // Path doesn't exist yet (e.g., file being created).
        // Validate the deepest existing ancestor.
        resolvedPath = this.resolveDeepestExistingAncestor(normalizedPath);
      }

      // Step 4: Prefix check -- resolved path must start with resolved worktree path
      return resolvedPath.startsWith(this.resolvedWorktreePath + path.sep) ||
             resolvedPath === this.resolvedWorktreePath;
    } catch {
      // Any resolution error -> deny
      return false;
    }
  }

  private resolveDeepestExistingAncestor(targetPath: string): string {
    let current = targetPath;
    while (current !== path.dirname(current)) {
      try {
        const real = fs.realpathSync(current);
        // Append the remaining unresolved portion
        const remainder = targetPath.slice(current.length);
        return path.join(real, remainder);
      } catch {
        current = path.dirname(current);
      }
    }
    return targetPath; // fallback
  }

  /**
   * Extract file paths from tool inputs based on tool type.
   */
  private extractPaths(toolName: string, toolInput: Record<string, any>): string[] {
    switch (toolName) {
      case 'Read':
      case 'Write':
        return toolInput.file_path ? [toolInput.file_path] : [];

      case 'Edit':
        return toolInput.file_path ? [toolInput.file_path] : [];

      case 'Glob':
        return toolInput.path ? [toolInput.path] : [];

      case 'Grep':
        return toolInput.path ? [toolInput.path] : [];

      case 'Bash': {
        // Best-effort extraction from bash commands
        // Look for common file-path patterns in the command
        const cmd = toolInput.command ?? '';
        return this.extractPathsFromBashCommand(cmd);
      }

      default:
        return [];
    }
  }

  /**
   * Best-effort extraction of file paths from a bash command string.
   * Catches obvious cases like: cd /path, cat /path, > /path
   * Not exhaustive -- the isolation is defense-in-depth, not solely reliant on this.
   */
  private extractPathsFromBashCommand(cmd: string): string[] {
    const paths: string[] = [];

    // Match absolute paths (starting with /)
    const absPathRegex = /(?:^|\s)(\/[^\s;|&>]+)/g;
    let match;
    while ((match = absPathRegex.exec(cmd)) !== null) {
      paths.push(match[1]);
    }

    // Match cd commands
    const cdMatch = cmd.match(/cd\s+([^\s;|&]+)/);
    if (cdMatch) paths.push(cdMatch[1]);

    return paths;
  }
}
```

### 2. Turn budget enforcement (add to `agent-spawner.ts`)

```typescript
// In AgentSpawner class:

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

export interface TurnBudgetStatus {
  exceeded: boolean;
  warning: boolean;
  turnsUsed: number;
  turnBudget: number;
}
```

### 3. Liveness monitoring (add to `agent-spawner.ts`)

```typescript
private livenessInterval: NodeJS.Timeout | null = null;

startLivenessMonitor(intervalMs: number = 30_000): void {
  this.livenessInterval = setInterval(() => this.checkAllAgents(), intervalMs);
}

stopLivenessMonitor(): void {
  if (this.livenessInterval) {
    clearInterval(this.livenessInterval);
    this.livenessInterval = null;
  }
}

private async checkAllAgents(): Promise<void> {
  for (const [sessionId, agent] of this.activeAgents) {
    const isAlive = await this.isAgentAlive(agent);
    if (!isAlive) {
      await this.handleAgentCrash(agent);
    }
  }
}

private async isAgentAlive(agent: AgentSession): Promise<boolean> {
  try {
    // Check if the process/session is still running
    return agent.process.isAlive();
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

  // Delegate to retry handler (PLAN-006-3, Task 7)
}

private async checkForPartialWork(assignment: TrackAssignment): Promise<boolean> {
  try {
    // Check if there are commits beyond the branch point
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
```

## Acceptance Criteria

1. Isolation hook blocks absolute paths outside the worktree (e.g., `/etc/passwd`).
2. Isolation hook blocks relative traversal (`../../../etc/passwd`).
3. Isolation hook blocks symlinks that resolve outside the worktree.
4. Isolation hook allows all paths that resolve within the worktree.
5. Isolation hook handles non-existent paths by validating the deepest existing ancestor.
6. Isolation hook emits `security.isolation_violation` on every blocked access.
7. Isolation hook extracts paths from Read, Write, Edit, Glob, Grep, and Bash tool inputs.
8. Turn counter increments on each `trackTurn` call.
9. Warning emitted at 90% budget (`agent.budget_warning` with action `warning`).
10. Agent terminated at 100% budget (`agent.budget_warning` with action `terminated`).
11. Liveness monitor checks every 30 seconds (configurable).
12. Crashed agent detected and `agent.failed` event emitted with `hasPartialWork` flag.
13. Partial work detection checks for commits beyond the integration branch point.

## Test Cases

```
// isolation-hook.test.ts

describe('FilesystemIsolationHook', () => {
  // worktreePath = /tmp/test-repo/.worktrees/req-001/track-a
  
  describe('path validation', () => {
    it('allows files within worktree', () => {
      expect(hook.isPathAllowed('/tmp/test-repo/.worktrees/req-001/track-a/src/index.ts')).toBe(true);
    });

    it('allows relative paths within worktree', () => {
      expect(hook.isPathAllowed('src/index.ts')).toBe(true);
    });

    it('allows the worktree root itself', () => {
      expect(hook.isPathAllowed('/tmp/test-repo/.worktrees/req-001/track-a')).toBe(true);
    });

    it('blocks absolute paths outside worktree', () => {
      expect(hook.isPathAllowed('/etc/passwd')).toBe(false);
    });

    it('blocks parent traversal', () => {
      expect(hook.isPathAllowed('../../../etc/passwd')).toBe(false);
    });

    it('blocks deeply nested traversal', () => {
      expect(hook.isPathAllowed('src/../../../../etc/passwd')).toBe(false);
    });

    it('blocks paths to other worktrees', () => {
      expect(hook.isPathAllowed('/tmp/test-repo/.worktrees/req-001/track-b/src/index.ts')).toBe(false);
    });

    it('blocks paths to repo root', () => {
      expect(hook.isPathAllowed('/tmp/test-repo/src/index.ts')).toBe(false);
    });

    it('blocks symlinks pointing outside worktree', () => {
      // Create a symlink inside the worktree that points outside
      fs.symlinkSync('/etc', path.join(worktreePath, 'escape-link'));
      expect(hook.isPathAllowed('escape-link/passwd')).toBe(false);
    });

    it('handles non-existent paths by checking ancestor', () => {
      // New file that doesn't exist yet, but its parent does
      expect(hook.isPathAllowed('src/new-file.ts')).toBe(true);
    });

    it('handles null bytes in path', () => {
      expect(hook.isPathAllowed('src/\x00evil.ts')).toBe(false);
    });

    it('handles Unicode path tricks', () => {
      // Unicode right-to-left override character
      expect(hook.isPathAllowed('src/\u202Eevil.ts')).toBe(true); // resolves within worktree
    });
  });

  describe('tool input extraction', () => {
    it('extracts path from Read tool', async () => {
      const result = await hook.validate('Read', { file_path: '/etc/passwd' });
      expect(result).toBe(false);
    });

    it('extracts path from Write tool', async () => {
      const result = await hook.validate('Write', {
        file_path: path.join(worktreePath, 'src/new.ts'),
        content: 'hello',
      });
      expect(result).toBe(true);
    });

    it('extracts path from Edit tool', async () => {
      const result = await hook.validate('Edit', {
        file_path: '/etc/shadow',
        old_string: 'x',
        new_string: 'y',
      });
      expect(result).toBe(false);
    });

    it('extracts absolute paths from Bash command', async () => {
      const result = await hook.validate('Bash', { command: 'cat /etc/passwd' });
      expect(result).toBe(false);
    });

    it('allows Bash commands with worktree-relative paths', async () => {
      const result = await hook.validate('Bash', {
        command: `ls ${path.join(worktreePath, 'src')}`,
      });
      expect(result).toBe(true);
    });
  });

  describe('violation logging', () => {
    it('emits security.isolation_violation event', async () => {
      const events: any[] = [];
      emitter.on('security.isolation_violation', e => events.push(e));
      await hook.validate('Read', { file_path: '/etc/passwd' });
      expect(events.length).toBe(1);
      expect(events[0].attemptedPath).toBe('/etc/passwd');
      expect(events[0].trackName).toBe('track-a');
    });
  });

  describe('property: fuzz paths', () => {
    it('no random path produces access outside worktree', () => {
      fc.assert(fc.property(fc.string(), (randomPath) => {
        const allowed = hook.isPathAllowed(randomPath);
        if (allowed) {
          // If allowed, verify it actually resolves inside worktree
          const resolved = path.resolve(worktreePath, randomPath);
          const normalized = path.normalize(resolved);
          expect(normalized.startsWith(worktreePath)).toBe(true);
        }
        // If blocked, that's always safe -- no assertion needed
      }));
    });
  });
});

// agent-spawner.test.ts (budget and liveness sections)

describe('turn budget enforcement', () => {
  it('increments turn count', async () => {
    await spawner.spawnAgent(assignment, bundle);
    const status = await spawner.trackTurn(assignment.agentSessionId!);
    expect(status.turnsUsed).toBe(1);
    expect(status.exceeded).toBe(false);
  });

  it('warns at 90% budget', async () => {
    assignment.turnBudget = 10;
    await spawner.spawnAgent(assignment, bundle);
    for (let i = 0; i < 9; i++) {
      await spawner.trackTurn(assignment.agentSessionId!);
    }
    const events: any[] = [];
    emitter.on('agent.budget_warning', e => events.push(e));
    const status = await spawner.trackTurn(assignment.agentSessionId!); // turn 9 of 10 = 90%
    expect(status.warning).toBe(true);
    // Note: the 9th call makes turnsUsed=9, which is 90% of 10
  });

  it('terminates at 100% budget', async () => {
    assignment.turnBudget = 10;
    await spawner.spawnAgent(assignment, bundle);
    for (let i = 0; i < 10; i++) {
      await spawner.trackTurn(assignment.agentSessionId!);
    }
    expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Failed);
  });
});

describe('liveness monitoring', () => {
  it('detects crashed agent', async () => {
    await spawner.spawnAgent(assignment, bundle);
    // Simulate crash: make isAlive return false
    mockSession.isAlive = () => false;
    const events: any[] = [];
    emitter.on('agent.failed', e => events.push(e));
    await spawner['checkAllAgents']();
    expect(events.length).toBe(1);
    expect(events[0].reason).toBe('agent_crash');
  });

  it('checks for partial work after crash', async () => {
    // Agent made commits before crashing
    await spawner.spawnAgent(assignment, bundle);
    execSync(`git -C "${assignment.worktreePath}" commit --allow-empty -m "partial"`);
    mockSession.isAlive = () => false;
    const events: any[] = [];
    emitter.on('agent.failed', e => events.push(e));
    await spawner['checkAllAgents']();
    expect(events[0].hasPartialWork).toBe(true);
  });
});
```
