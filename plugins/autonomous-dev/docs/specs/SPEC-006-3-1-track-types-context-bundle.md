# SPEC-006-3-1: Track Assignment Types and Context Bundle Preparation

## Metadata
- **Parent Plan**: PLAN-006-3
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 11 hours

## Description

Define the `TrackAssignment` data model, `AgentLifecyclePhase` enum, and `InterfaceContract` types. Implement the context bundle preparation that assembles spec content, parent documents, turn budgets, and interface contracts into a structured prompt for each agent. Build the `AgentSpawner` that creates Claude Code subagent sessions in worktree directories and manages their lifecycle.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/types.ts` | **Modify** | Add agent-related types |
| `src/parallel/agent-spawner.ts` | **Create** | Context bundle, agent session management, lifecycle tracking |
| `tests/parallel/agent-spawner.test.ts` | **Create** | Unit tests for context bundle and spawner |

## Implementation Details

### 1. Agent type definitions (`src/parallel/types.ts`)

```typescript
export interface TrackAssignment {
  trackName: string;
  worktreePath: string;
  branchName: string;         // e.g. "auto/req-001/track-a"
  agentSessionId: string | null;
  spec: SpecMetadata;
  parentPlan: string;         // path to parent plan document
  parentTDD: string;          // path to parent TDD document
  parentPRD: string;          // path to parent PRD document
  turnBudget: number;
  turnsUsed: number;
  retryCount: number;
  lifecyclePhase: AgentLifecyclePhase;
  interfaceContracts: InterfaceContract[];
  lastActivityAt: string;     // ISO-8601
  startedAt: string | null;
  completedAt: string | null;
}

export enum AgentLifecyclePhase {
  Spawning = 'spawning',
  Executing = 'executing',
  Testing = 'testing',
  Reviewing = 'reviewing',
  Committing = 'committing',
  Complete = 'complete',
  Failed = 'failed',
}

export interface InterfaceContract {
  producer: string;           // specName of the producing track
  consumer: string;           // specName of the consuming track
  contractType: 'type-definition' | 'function-signature' | 'api-endpoint';
  definition: string;         // the interface definition text (e.g., TypeScript type)
  filePath: string;           // where the definition lives
}
```

### 2. Context bundle preparation

The context bundle is the structured prompt injected into each agent session. It must contain everything the agent needs to execute its spec without cross-track communication.

```typescript
export interface ContextBundle {
  systemPrompt: string;       // instructions about scope, isolation, commit format
  specContent: string;        // full spec document content
  parentExcerpts: {
    plan: string;             // relevant sections of parent plan
    tdd: string;              // relevant sections of parent TDD
    prd: string;              // relevant sections of parent PRD
  };
  turnBudget: number;
  complexity: 'small' | 'medium' | 'large';
  interfaceContracts: InterfaceContract[];
  sharedTypeDefinitions: string[];  // contents of shared type files from integration branch
  commitFormat: string;       // template for commit messages
  workingDirectory: string;   // absolute path to worktree
}

export async function prepareContextBundle(
  assignment: TrackAssignment,
  repoRoot: string
): Promise<ContextBundle> {
  // 1. Read the spec file
  const specContent = await fs.readFile(assignment.spec.path, 'utf-8');

  // 2. Read and truncate parent documents
  const planContent = await readAndTruncate(assignment.parentPlan, 4000); // max ~4k chars
  const tddContent = await readAndTruncate(assignment.parentTDD, 4000);
  const prdContent = await readAndTruncate(assignment.parentPRD, 2000);

  // 3. Read shared type definitions from integration branch
  const sharedTypes = await readSharedTypesFromIntegration(
    repoRoot,
    assignment.branchName
  );

  // 4. Determine turn budget from complexity
  const turnBudget = assignment.turnBudget; // already set from config

  // 5. Build system prompt
  const systemPrompt = buildAgentSystemPrompt(assignment);

  // 6. Build commit format
  const commitFormat = [
    `feat(${assignment.trackName}): <description>`,
    ``,
    `Spec: ${assignment.spec.name}`,
    `Request: ${assignment.trackName.split('/')[0] || 'unknown'}`,
    `Turns: {turnsUsed}/${assignment.turnBudget}`,
  ].join('\n');

  return {
    systemPrompt,
    specContent,
    parentExcerpts: { plan: planContent, tdd: tddContent, prd: prdContent },
    turnBudget,
    complexity: assignment.spec.complexity,
    interfaceContracts: assignment.interfaceContracts,
    sharedTypeDefinitions: sharedTypes,
    commitFormat,
    workingDirectory: assignment.worktreePath,
  };
}
```

**System prompt template**:

```
You are an autonomous development agent executing a single spec within an isolated git worktree.

## Your Scope
- Working directory: {worktreePath}
- Branch: {branchName}
- Spec: {specName}

## Rules
1. ALL file operations must be within your working directory: {worktreePath}
2. Do NOT access files outside your worktree.
3. Do NOT modify files on other branches.
4. Turn budget: {turnBudget} turns. You are currently on turn {turnsUsed}.
5. After implementation, run the project's test suite.
6. After tests pass, perform a self-review of your changes.
7. Commit with the format: feat({trackName}): <description>

## Interface Contracts
{contractList}

## Shared Types (read-only, from integration branch)
{sharedTypeContents}
```

**Truncation logic** (`readAndTruncate`): Read the full file, then extract only relevant sections (headings matching the spec name, objective, scope). If the full file < max chars, include it all. Otherwise, include: title, objective section, scope section, and the specific task section that matches the spec.

### 3. AgentSpawner

```typescript
export class AgentSpawner {
  private activeAgents = new Map<string, AgentSession>();

  constructor(
    private config: ParallelConfig,
    private eventEmitter: EventEmitter
  ) {}

  async spawnAgent(assignment: TrackAssignment, bundle: ContextBundle): Promise<string> {
    assignment.lifecyclePhase = AgentLifecyclePhase.Spawning;

    // Create Claude Code subagent session
    // The exact API depends on the Claude Code SDK; this is the intended interface:
    const session = await createSubagentSession({
      workingDirectory: bundle.workingDirectory,
      initialPrompt: this.formatInitialPrompt(bundle),
      // Environment isolation: CWD is set to the worktree path
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

  async getAgentStatus(sessionId: string): Promise<AgentLifecyclePhase | null> {
    const agent = this.activeAgents.get(sessionId);
    if (!agent) return null;
    return agent.assignment.lifecyclePhase;
  }

  async terminateAgent(sessionId: string): Promise<void> {
    const agent = this.activeAgents.get(sessionId);
    if (!agent) return;

    await agent.process.terminate();
    agent.assignment.lifecyclePhase = AgentLifecyclePhase.Failed;
    this.activeAgents.delete(sessionId);
  }

  getActiveAgentCount(): number {
    return this.activeAgents.size;
  }

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
}
```

### 4. Turn budget defaults

From config, map complexity to default turn budget:

| Complexity | Default Turns |
|-----------|---------------|
| `small`   | 30            |
| `medium`  | 60            |
| `large`   | 120           |

```typescript
export function defaultTurnBudget(complexity: 'small' | 'medium' | 'large'): number {
  switch (complexity) {
    case 'small': return 30;
    case 'medium': return 60;
    case 'large': return 120;
  }
}
```

## Acceptance Criteria

1. `TrackAssignment` interface contains all fields from TDD 3.4.1.
2. `AgentLifecyclePhase` enum covers all phases: spawning, executing, testing, reviewing, committing, complete, failed.
3. `InterfaceContract` captures producer, consumer, contract type, and definition.
4. `prepareContextBundle` includes: spec content, parent plan/TDD/PRD excerpts, turn budget, interface contracts, shared types, commit format.
5. Parent documents are truncated to bounded size (plan/TDD: 4000 chars, PRD: 2000 chars) extracting relevant sections.
6. System prompt instructs agent about working directory, scope, turn budget, commit format, and isolation rules.
7. `spawnAgent` creates a subagent session with CWD set to the worktree path.
8. `spawnAgent` sets `agentSessionId` on the assignment and transitions phase to `executing`.
9. `spawnAgent` emits `agent.spawned` event.
10. `getAgentStatus` returns current lifecycle phase or null for unknown session.
11. `terminateAgent` cleanly stops the agent and sets phase to `failed`.
12. `defaultTurnBudget` returns 30/60/120 for small/medium/large.

## Test Cases

```
// agent-spawner.test.ts

describe('prepareContextBundle', () => {
  it('includes full spec content', async () => {
    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.specContent).toContain('## Implementation');
    expect(bundle.specContent.length).toBeGreaterThan(0);
  });

  it('truncates large parent docs', async () => {
    // Create a 10KB plan file
    await fs.writeFile(assignment.parentPlan, 'x'.repeat(10000));
    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.parentExcerpts.plan.length).toBeLessThanOrEqual(4200); // some margin
  });

  it('includes interface contracts', async () => {
    assignment.interfaceContracts = [{
      producer: 'track-a',
      consumer: 'track-b',
      contractType: 'type-definition',
      definition: 'export interface User { id: string; }',
      filePath: 'src/types.ts',
    }];
    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.interfaceContracts.length).toBe(1);
  });

  it('sets correct working directory', async () => {
    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.workingDirectory).toBe(assignment.worktreePath);
  });

  it('includes commit format with spec name', async () => {
    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.commitFormat).toContain(assignment.trackName);
  });
});

describe('AgentSpawner', () => {
  it('spawns agent with correct CWD', async () => {
    const sessionId = await spawner.spawnAgent(assignment, bundle);
    expect(sessionId).toBeDefined();
    expect(assignment.agentSessionId).toBe(sessionId);
  });

  it('transitions phase to executing on spawn', async () => {
    await spawner.spawnAgent(assignment, bundle);
    expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Executing);
  });

  it('emits agent.spawned event', async () => {
    const events: any[] = [];
    emitter.on('agent.spawned', e => events.push(e));
    await spawner.spawnAgent(assignment, bundle);
    expect(events.length).toBe(1);
    expect(events[0].trackName).toBe(assignment.trackName);
  });

  it('terminates agent and sets phase to failed', async () => {
    const sessionId = await spawner.spawnAgent(assignment, bundle);
    await spawner.terminateAgent(sessionId);
    expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Failed);
    expect(await spawner.getAgentStatus(sessionId)).toBeNull();
  });

  it('returns null status for unknown session', async () => {
    expect(await spawner.getAgentStatus('nonexistent')).toBeNull();
  });

  it('tracks active agent count', async () => {
    expect(spawner.getActiveAgentCount()).toBe(0);
    await spawner.spawnAgent(assignment, bundle);
    expect(spawner.getActiveAgentCount()).toBe(1);
  });
});

describe('defaultTurnBudget', () => {
  it('returns 30 for small', () => expect(defaultTurnBudget('small')).toBe(30));
  it('returns 60 for medium', () => expect(defaultTurnBudget('medium')).toBe(60));
  it('returns 120 for large', () => expect(defaultTurnBudget('large')).toBe(120));
});
```
