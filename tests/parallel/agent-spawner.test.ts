/**
 * Tests for AgentSpawner.
 *
 * SPEC-006-3-1: Track assignment types, context bundle preparation,
 *   system prompt building, turn budget defaults.
 * SPEC-006-3-2: Turn budget enforcement, liveness monitoring,
 *   partial-work detection.
 *
 * Uses real temp git repos for partial-work detection tests.
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  AgentSpawner,
  TurnBudgetStatus,
  CreateSubagentSessionFn,
  _resetSessionCounter,
  prepareContextBundle,
  defaultTurnBudget,
  readAndTruncate,
  buildAgentSystemPrompt,
  preCommitSharedTypes,
} from '../../src/parallel/agent-spawner';
import { WorktreeManager } from '../../src/parallel/worktree-manager';
import {
  AgentLifecyclePhase,
  TrackAssignment,
  ContextBundle,
  InterfaceContract,
  SubagentProcess,
} from '../../src/parallel/types';
import { loadConfig, ParallelConfig } from '../../src/parallel/config';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAssignment(
  overrides: Partial<TrackAssignment> = {},
): TrackAssignment {
  return {
    trackName: 'track-a',
    worktreePath: '/tmp/fake-worktree',
    branchName: 'auto/req-001/track-a',
    agentSessionId: null,
    spec: { name: 'test-spec', path: '/tmp/fake-spec.md' },
    parentPlan: '/tmp/fake-plan.md',
    parentTDD: '/tmp/fake-tdd.md',
    parentPRD: '/tmp/fake-prd.md',
    turnsUsed: 0,
    turnBudget: 100,
    retryCount: 0,
    lastActivityAt: new Date().toISOString(),
    startedAt: null,
    completedAt: null,
    lifecyclePhase: AgentLifecyclePhase.Spawning,
    interfaceContracts: [],
    ...overrides,
  };
}

function createBundle(
  overrides: Partial<ContextBundle> = {},
): ContextBundle {
  return {
    systemPrompt: 'You are a test agent.',
    specContent: '# Test Spec',
    parentExcerpts: { plan: '', tdd: '', prd: '' },
    turnBudget: 100,
    complexity: 'medium',
    interfaceContracts: [],
    sharedTypeDefinitions: [],
    commitFormat: 'feat(test): <description>',
    workingDirectory: '/tmp/fake-worktree',
    ...overrides,
  };
}

/** Track whether terminate was called on mock processes. */
let terminateCalls: string[];

function createMockSessionFactory(opts?: {
  isAliveOverride?: () => boolean;
}): CreateSubagentSessionFn {
  let counter = 0;
  return async (_opts) => {
    counter++;
    const id = `mock-session-${counter}`;
    return {
      id,
      terminate: async () => {
        terminateCalls.push(id);
      },
    };
  };
}

function createConfig(): ParallelConfig {
  return loadConfig({
    worktree_root: '/tmp/worktrees',
    max_worktrees: 5,
    disk_warning_threshold_gb: 5,
    disk_hard_limit_gb: 2,
  });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('AgentSpawner', () => {
  let emitter: EventEmitter;
  let spawner: AgentSpawner;
  let config: ParallelConfig;

  beforeEach(() => {
    terminateCalls = [];
    _resetSessionCounter();
    emitter = new EventEmitter();
    config = createConfig();
    spawner = new AgentSpawner(config, emitter, createMockSessionFactory());
  });

  afterEach(() => {
    spawner.stopLivenessMonitor();
  });

  // -----------------------------------------------------------------------
  // Spawning
  // -----------------------------------------------------------------------

  describe('spawnAgent', () => {
    it('returns a session ID', async () => {
      const assignment = createAssignment();
      const sessionId = await spawner.spawnAgent(assignment, createBundle());
      expect(typeof sessionId).toBe('string');
      expect(sessionId.length).toBeGreaterThan(0);
    });

    it('sets lifecyclePhase to Executing', async () => {
      const assignment = createAssignment();
      await spawner.spawnAgent(assignment, createBundle());
      expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Executing);
    });

    it('stores session ID on assignment', async () => {
      const assignment = createAssignment();
      const sessionId = await spawner.spawnAgent(assignment, createBundle());
      expect(assignment.agentSessionId).toBe(sessionId);
    });

    it('tracks agent as active', async () => {
      const assignment = createAssignment();
      const sessionId = await spawner.spawnAgent(assignment, createBundle());
      expect(spawner.isAgentActive(sessionId)).toBe(true);
    });

    it('emits agent.spawned event', async () => {
      const events: any[] = [];
      emitter.on('agent.spawned', (e) => events.push(e));

      const assignment = createAssignment();
      await spawner.spawnAgent(assignment, createBundle());

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('agent.spawned');
      expect(events[0].trackName).toBe('track-a');
    });

    it('generates unique session IDs', async () => {
      const a1 = createAssignment({ trackName: 'track-a' });
      const a2 = createAssignment({ trackName: 'track-b' });
      const id1 = await spawner.spawnAgent(a1, createBundle());
      const id2 = await spawner.spawnAgent(a2, createBundle());
      expect(id1).not.toBe(id2);
    });

    it('sets startedAt timestamp', async () => {
      const assignment = createAssignment();
      await spawner.spawnAgent(assignment, createBundle());
      expect(assignment.startedAt).not.toBeNull();
      expect(typeof assignment.startedAt).toBe('string');
    });

    it('increments active agent count', async () => {
      expect(spawner.getActiveAgentCount()).toBe(0);

      const a1 = createAssignment({ trackName: 'track-a' });
      await spawner.spawnAgent(a1, createBundle());
      expect(spawner.getActiveAgentCount()).toBe(1);

      const a2 = createAssignment({ trackName: 'track-b' });
      await spawner.spawnAgent(a2, createBundle());
      expect(spawner.getActiveAgentCount()).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Turn budget enforcement
  // -----------------------------------------------------------------------

  describe('turn budget enforcement', () => {
    it('increments turn count', async () => {
      const assignment = createAssignment({ turnBudget: 100 });
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      const status = await spawner.trackTurn(sessionId);
      expect(status.turnsUsed).toBe(1);
      expect(status.exceeded).toBe(false);
      expect(status.warning).toBe(false);
    });

    it('increments turn count on successive calls', async () => {
      const assignment = createAssignment({ turnBudget: 100 });
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      await spawner.trackTurn(sessionId);
      await spawner.trackTurn(sessionId);
      const status = await spawner.trackTurn(sessionId);
      expect(status.turnsUsed).toBe(3);
    });

    it('warns at 90% budget', async () => {
      const assignment = createAssignment({ turnBudget: 10 });
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      // Use 8 turns (80%) -- no warning
      for (let i = 0; i < 8; i++) {
        const status = await spawner.trackTurn(sessionId);
        expect(status.warning).toBe(false);
        expect(status.exceeded).toBe(false);
      }

      // Track warning events from here
      const events: any[] = [];
      emitter.on('agent.budget_warning', (e) => events.push(e));

      // 9th turn = 90% of 10
      const status = await spawner.trackTurn(sessionId);
      expect(status.warning).toBe(true);
      expect(status.exceeded).toBe(false);
      expect(status.turnsUsed).toBe(9);
      expect(status.turnBudget).toBe(10);

      // Verify event was emitted
      expect(events.length).toBe(1);
      expect(events[0].action).toBe('warning');
      expect(events[0].trackName).toBe('track-a');
      expect(events[0].turnsUsed).toBe(9);
      expect(events[0].turnBudget).toBe(10);
    });

    it('terminates at 100% budget', async () => {
      const assignment = createAssignment({ turnBudget: 10 });
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      // Use 9 turns (90%) -- includes warning on 9th
      for (let i = 0; i < 9; i++) {
        await spawner.trackTurn(sessionId);
      }

      const events: any[] = [];
      emitter.on('agent.budget_warning', (e) => events.push(e));

      // 10th turn = 100% of 10 -> terminate
      const status = await spawner.trackTurn(sessionId);
      expect(status.exceeded).toBe(true);
      expect(status.warning).toBe(false);
      expect(status.turnsUsed).toBe(10);

      // Verify termination event
      expect(events.length).toBe(1);
      expect(events[0].action).toBe('terminated');
      expect(events[0].turnsUsed).toBe(10);
      expect(events[0].turnBudget).toBe(10);

      // Verify lifecycle phase changed to Failed
      expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Failed);

      // Verify agent is no longer active
      expect(spawner.isAgentActive(sessionId)).toBe(false);
    });

    it('throws for unknown session ID', async () => {
      await expect(spawner.trackTurn('nonexistent')).rejects.toThrow(
        /Unknown agent session/,
      );
    });

    it('emits warning on each turn at or above 90%', async () => {
      const assignment = createAssignment({ turnBudget: 10 });
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      // Use 8 turns
      for (let i = 0; i < 8; i++) {
        await spawner.trackTurn(sessionId);
      }

      const events: any[] = [];
      emitter.on('agent.budget_warning', (e) => events.push(e));

      // 9th turn = 90% -> warning
      await spawner.trackTurn(sessionId);
      expect(events.length).toBe(1);
      expect(events[0].action).toBe('warning');

      // 10th turn = 100% -> terminated
      await spawner.trackTurn(sessionId);
      expect(events.length).toBe(2);
      expect(events[1].action).toBe('terminated');
    });

    it('updates lastActivityAt on each turn', async () => {
      const assignment = createAssignment({ turnBudget: 100 });
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      const before = assignment.lastActivityAt;
      // Small delay to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 5));
      await spawner.trackTurn(sessionId);
      const after = assignment.lastActivityAt;

      expect(after).not.toBe(before);
    });

    it('handles budget of 1 turn correctly', async () => {
      const assignment = createAssignment({ turnBudget: 1 });
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      const events: any[] = [];
      emitter.on('agent.budget_warning', (e) => events.push(e));

      // 1st turn = 100% -> immediate termination
      const status = await spawner.trackTurn(sessionId);
      expect(status.exceeded).toBe(true);
      expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Failed);
    });
  });

  // -----------------------------------------------------------------------
  // Agent termination
  // -----------------------------------------------------------------------

  describe('terminateAgent', () => {
    it('terminates the process and removes agent', async () => {
      const assignment = createAssignment();
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      await spawner.terminateAgent(sessionId);

      expect(terminateCalls.length).toBeGreaterThan(0);
      expect(spawner.isAgentActive(sessionId)).toBe(false);
    });

    it('sets lifecycle to Failed on termination', async () => {
      const assignment = createAssignment();
      const sessionId = await spawner.spawnAgent(assignment, createBundle());

      await spawner.terminateAgent(sessionId);

      expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Failed);
    });

    it('is safe to call on nonexistent session', async () => {
      await expect(
        spawner.terminateAgent('nonexistent'),
      ).resolves.not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Liveness monitoring
  // -----------------------------------------------------------------------

  describe('liveness monitoring', () => {
    it('startLivenessMonitor and stopLivenessMonitor lifecycle', () => {
      // Should not throw
      spawner.startLivenessMonitor(60000);
      spawner.startLivenessMonitor(60000); // calling again replaces the interval
      spawner.stopLivenessMonitor();
      spawner.stopLivenessMonitor(); // calling again is a no-op
    });

    it('checkAllAgents handles empty active set', async () => {
      // No agents spawned -- should not throw
      await expect(spawner['checkAllAgents']()).resolves.not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Agent status
  // -----------------------------------------------------------------------

  describe('getAgentStatus', () => {
    it('returns lifecycle phase for active agent', async () => {
      const assignment = createAssignment();
      const sessionId = await spawner.spawnAgent(assignment, createBundle());
      const status = await spawner.getAgentStatus(sessionId);
      expect(status).toBe(AgentLifecyclePhase.Executing);
    });

    it('returns null for unknown session', async () => {
      const status = await spawner.getAgentStatus('nonexistent');
      expect(status).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Partial work detection (requires real git repo)
  // -----------------------------------------------------------------------

  describe('partial work detection', () => {
    let tmpDir: string;
    let repoRoot: string;
    let worktreeDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawner-test-'));
      repoRoot = path.join(tmpDir, 'repo');
      worktreeDir = path.join(tmpDir, 'worktrees');

      fs.mkdirSync(repoRoot, { recursive: true });
      fs.mkdirSync(worktreeDir, { recursive: true });

      // Initialize git repo with an initial commit on 'main'
      execSync(
        `git -C "${repoRoot}" init --initial-branch=main && ` +
          `git -C "${repoRoot}" config user.email "test@test.com" && ` +
          `git -C "${repoRoot}" config user.name "Test" && ` +
          `git -C "${repoRoot}" commit --allow-empty -m "init"`,
        { encoding: 'utf-8' },
      );

      // Create integration branch
      execSync(
        `git -C "${repoRoot}" branch auto/req-001/integration main`,
        { encoding: 'utf-8' },
      );

      // Create a worktree for track-a
      const wtPath = path.join(worktreeDir, 'req-001', 'track-a');
      execSync(
        `git -C "${repoRoot}" worktree add "${wtPath}" -b auto/req-001/track-a auto/req-001/integration`,
        { encoding: 'utf-8' },
      );

      // Configure git in the worktree
      execSync(
        `git -C "${wtPath}" config user.email "test@test.com" && ` +
          `git -C "${wtPath}" config user.name "Test"`,
        { encoding: 'utf-8' },
      );
    });

    afterEach(async () => {
      // Clean up worktrees before removing temp dir
      try {
        execSync(`git -C "${repoRoot}" worktree prune`, {
          encoding: 'utf-8',
        });
      } catch {
        // ignore
      }
      await fsPromises.rm(tmpDir, { recursive: true, force: true });
    });

    it('reports hasPartialWork=false when no commits beyond branch point', async () => {
      const wtPath = path.join(worktreeDir, 'req-001', 'track-a');
      const assignment = createAssignment({
        worktreePath: wtPath,
        branchName: 'auto/req-001/track-a',
      });

      // Use a factory that simulates crash (the default isAlive check in
      // the linter-merged version always returns true, so we test
      // checkForPartialWork through handleAgentCrash directly)
      const result = await spawner['checkForPartialWork'](assignment);
      expect(result).toBe(false);
    });

    it('reports hasPartialWork=true when agent made commits before crashing', async () => {
      const wtPath = path.join(worktreeDir, 'req-001', 'track-a');

      // Agent made a commit in its worktree
      execSync(
        `git -C "${wtPath}" commit --allow-empty -m "partial work"`,
        { encoding: 'utf-8' },
      );

      const assignment = createAssignment({
        worktreePath: wtPath,
        branchName: 'auto/req-001/track-a',
      });

      const result = await spawner['checkForPartialWork'](assignment);
      expect(result).toBe(true);
    });

    it('reports hasPartialWork=false when worktree path is invalid', async () => {
      const assignment = createAssignment({
        worktreePath: '/nonexistent/path',
        branchName: 'auto/req-001/track-a',
      });

      const result = await spawner['checkForPartialWork'](assignment);
      expect(result).toBe(false);
    });
  });
});

// ===========================================================================
// SPEC-006-3-1: Track Assignment Types and Context Bundle Preparation
// ===========================================================================

// ---------------------------------------------------------------------------
// defaultTurnBudget
// ---------------------------------------------------------------------------

describe('defaultTurnBudget', () => {
  it('returns 30 for small', () => expect(defaultTurnBudget('small')).toBe(30));
  it('returns 60 for medium', () => expect(defaultTurnBudget('medium')).toBe(60));
  it('returns 120 for large', () => expect(defaultTurnBudget('large')).toBe(120));
});

// ---------------------------------------------------------------------------
// readAndTruncate
// ---------------------------------------------------------------------------

describe('readAndTruncate', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'truncate-test-'));
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns full content when under maxChars', async () => {
    const filePath = path.join(tmpDir, 'small.md');
    fs.writeFileSync(filePath, '# Title\nShort content.');
    const result = await readAndTruncate(filePath, 4000);
    expect(result).toBe('# Title\nShort content.');
  });

  it('truncates large files to maxChars', async () => {
    const filePath = path.join(tmpDir, 'large.md');
    fs.writeFileSync(filePath, 'x'.repeat(10000));
    const result = await readAndTruncate(filePath, 4000);
    expect(result.length).toBeLessThanOrEqual(4000);
  });

  it('extracts relevant sections from large docs', async () => {
    const filePath = path.join(tmpDir, 'structured.md');
    const content = [
      '# My Plan',
      'Title section content.',
      '',
      '## Objective',
      'This is the objective.',
      '',
      '## Scope',
      'This is the scope.',
      '',
      '## Unrelated Section',
      'x'.repeat(8000),
      '',
      '## Another Section',
      'More content.',
    ].join('\n');
    fs.writeFileSync(filePath, content);

    const result = await readAndTruncate(filePath, 4000);
    expect(result).toContain('My Plan');
    expect(result).toContain('objective');
    expect(result).toContain('scope');
    expect(result.length).toBeLessThanOrEqual(4200);
  });

  it('returns empty string for non-existent files', async () => {
    const result = await readAndTruncate('/nonexistent/file.md', 4000);
    expect(result).toBe('');
  });

  it('extracts spec-name-matching section', async () => {
    const filePath = path.join(tmpDir, 'plan-with-spec.md');
    const content = [
      '# Plan',
      '',
      '## SPEC-001',
      'Specific task details for SPEC-001.',
      '',
      '## SPEC-002',
      'Other spec details.',
      '',
      '## Filler',
      'x'.repeat(8000),
    ].join('\n');
    fs.writeFileSync(filePath, content);

    const result = await readAndTruncate(filePath, 4000, 'SPEC-001');
    expect(result).toContain('SPEC-001');
    expect(result).toContain('Specific task details');
  });
});

// ---------------------------------------------------------------------------
// buildAgentSystemPrompt
// ---------------------------------------------------------------------------

describe('buildAgentSystemPrompt', () => {
  it('includes working directory', () => {
    const assignment = createAssignment();
    const prompt = buildAgentSystemPrompt(assignment);
    expect(prompt).toContain(assignment.worktreePath);
  });

  it('includes branch name', () => {
    const assignment = createAssignment();
    const prompt = buildAgentSystemPrompt(assignment);
    expect(prompt).toContain(assignment.branchName);
  });

  it('includes spec name', () => {
    const assignment = createAssignment();
    const prompt = buildAgentSystemPrompt(assignment);
    expect(prompt).toContain(assignment.spec.name);
  });

  it('includes turn budget and turns used', () => {
    const assignment = createAssignment({ turnBudget: 60, turnsUsed: 5 });
    const prompt = buildAgentSystemPrompt(assignment);
    expect(prompt).toContain('60');
    expect(prompt).toContain('5');
  });

  it('includes interface contracts when present', () => {
    const assignment = createAssignment({
      interfaceContracts: [{
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface User { id: string; }',
        filePath: 'src/types.ts',
      }],
    });
    const prompt = buildAgentSystemPrompt(assignment);
    expect(prompt).toContain('track-a');
    expect(prompt).toContain('track-b');
    expect(prompt).toContain('type-definition');
    expect(prompt).toContain('export interface User');
  });

  it('shows (none) when no interface contracts', () => {
    const assignment = createAssignment({ interfaceContracts: [] });
    const prompt = buildAgentSystemPrompt(assignment);
    expect(prompt).toContain('(none)');
  });

  it('includes isolation rules', () => {
    const assignment = createAssignment();
    const prompt = buildAgentSystemPrompt(assignment);
    expect(prompt).toContain('Do NOT access files outside your worktree');
    expect(prompt).toContain('Do NOT modify files on other branches');
  });

  it('includes commit format instruction', () => {
    const assignment = createAssignment();
    const prompt = buildAgentSystemPrompt(assignment);
    expect(prompt).toContain(`feat(${assignment.trackName})`);
  });
});

// ---------------------------------------------------------------------------
// prepareContextBundle
// ---------------------------------------------------------------------------

describe('prepareContextBundle', () => {
  let tmpDir: string;
  let repoRoot: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-test-'));
    repoRoot = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  function setupFiles(assignment: TrackAssignment): void {
    // Create spec file
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '## Implementation\nBuild the feature.\n\n## Tests\nWrite tests.');
    assignment.spec.path = specPath;

    // Create parent doc files
    const planPath = path.join(tmpDir, 'plan.md');
    fs.writeFileSync(planPath, '# Plan\n## Objective\nBuild stuff.\n## Scope\nAll the things.');
    assignment.parentPlan = planPath;

    const tddPath = path.join(tmpDir, 'tdd.md');
    fs.writeFileSync(tddPath, '# TDD\n## Design\nUse TypeScript.');
    assignment.parentTDD = tddPath;

    const prdPath = path.join(tmpDir, 'prd.md');
    fs.writeFileSync(prdPath, '# PRD\n## Requirements\nMust be fast.');
    assignment.parentPRD = prdPath;
  }

  it('includes full spec content', async () => {
    const assignment = createAssignment();
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.specContent).toContain('## Implementation');
    expect(bundle.specContent.length).toBeGreaterThan(0);
  });

  it('truncates large parent docs', async () => {
    const assignment = createAssignment();
    setupFiles(assignment);

    // Overwrite plan with a 10KB file
    fs.writeFileSync(assignment.parentPlan, 'x'.repeat(10000));

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.parentExcerpts.plan.length).toBeLessThanOrEqual(4200);
  });

  it('includes interface contracts', async () => {
    const assignment = createAssignment({
      interfaceContracts: [{
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface User { id: string; }',
        filePath: 'src/types.ts',
      }],
    });
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.interfaceContracts.length).toBe(1);
  });

  it('sets correct working directory', async () => {
    const assignment = createAssignment();
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.workingDirectory).toBe(assignment.worktreePath);
  });

  it('includes commit format with spec name', async () => {
    const assignment = createAssignment();
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.commitFormat).toContain(assignment.trackName);
  });

  it('sets complexity from spec metadata', async () => {
    const assignment = createAssignment();
    assignment.spec.complexity = 'large';
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.complexity).toBe('large');
  });

  it('defaults complexity to medium when not specified', async () => {
    const assignment = createAssignment();
    assignment.spec.complexity = undefined;
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.complexity).toBe('medium');
  });

  it('sets correct turn budget', async () => {
    const assignment = createAssignment({ turnBudget: 120 });
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.turnBudget).toBe(120);
  });

  it('builds a non-empty system prompt', async () => {
    const assignment = createAssignment();
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.systemPrompt.length).toBeGreaterThan(0);
    expect(bundle.systemPrompt).toContain('autonomous development agent');
  });

  it('handles missing parent docs gracefully', async () => {
    const assignment = createAssignment({
      parentPlan: '/nonexistent/plan.md',
      parentTDD: '/nonexistent/tdd.md',
      parentPRD: '/nonexistent/prd.md',
    });
    const specPath = path.join(tmpDir, 'spec.md');
    fs.writeFileSync(specPath, '## Implementation\nStuff.');
    assignment.spec.path = specPath;

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.parentExcerpts.plan).toBe('');
    expect(bundle.parentExcerpts.tdd).toBe('');
    expect(bundle.parentExcerpts.prd).toBe('');
    expect(bundle.specContent).toContain('## Implementation');
  });

  it('reads shared type definitions when they exist', async () => {
    const typesDir = path.join(repoRoot, 'src');
    fs.mkdirSync(typesDir, { recursive: true });
    fs.writeFileSync(
      path.join(typesDir, 'types.ts'),
      'export interface SharedType { id: string; }',
    );

    const assignment = createAssignment();
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.sharedTypeDefinitions.length).toBe(1);
    expect(bundle.sharedTypeDefinitions[0]).toContain('SharedType');
  });

  it('returns empty shared types when no type files exist', async () => {
    const assignment = createAssignment();
    setupFiles(assignment);

    const bundle = await prepareContextBundle(assignment, repoRoot);
    expect(bundle.sharedTypeDefinitions).toEqual([]);
  });
});

// ===========================================================================
// SPEC-006-3-3: preCommitSharedTypes
// ===========================================================================

describe('preCommitSharedTypes', () => {
  let tmpDir: string;
  let repoRoot: string;
  let worktreeDir: string;
  let emitter: EventEmitter;
  let config: ParallelConfig;
  let worktreeManager: WorktreeManager;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-types-test-'));
    repoRoot = path.join(tmpDir, 'repo');
    worktreeDir = path.join(tmpDir, 'worktrees');

    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(worktreeDir, { recursive: true });

    // Initialize git repo with an initial commit on 'main'
    execSync(
      `git -C "${repoRoot}" init --initial-branch=main && ` +
        `git -C "${repoRoot}" config user.email "test@test.com" && ` +
        `git -C "${repoRoot}" config user.name "Test" && ` +
        `git -C "${repoRoot}" commit --allow-empty -m "init"`,
      { encoding: 'utf-8' },
    );

    emitter = new EventEmitter();
    config = loadConfig({
      worktree_root: worktreeDir,
      max_worktrees: 10,
      disk_warning_threshold_gb: 5,
      disk_hard_limit_gb: 2,
    });

    worktreeManager = new WorktreeManager(config, repoRoot, emitter);

    // Create integration branch
    await worktreeManager.createIntegrationBranch('req-001', 'main');
  });

  afterEach(async () => {
    try {
      execSync(`git -C "${repoRoot}" worktree prune`, {
        encoding: 'utf-8',
      });
    } catch {
      // ignore
    }
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  it('commits shared types to integration branch', async () => {
    const contracts: InterfaceContract[] = [
      {
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface User { id: string; name: string; }',
        filePath: 'src/types.ts',
      },
    ];

    await preCommitSharedTypes('req-001', contracts, worktreeManager, repoRoot);

    // Verify the commit exists on the integration branch
    const log = execSync(
      `git -C "${repoRoot}" log --oneline auto/req-001/integration -1`,
      { encoding: 'utf-8' },
    ).trim();
    expect(log).toContain('shared types');
  });

  it('creates correct file structure', async () => {
    const contracts: InterfaceContract[] = [
      {
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface User {}',
        filePath: 'src/types.ts',
      },
    ];

    await preCommitSharedTypes('req-001', contracts, worktreeManager, repoRoot);

    // Check that the file exists on the integration branch
    const content = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:src/shared/contracts/track-a-track-b-type-definition.ts`,
      { encoding: 'utf-8' },
    ).trim();
    expect(content).toBe('export interface User {}');
  });

  it('is a no-op when no contracts', async () => {
    await preCommitSharedTypes('req-001', [], worktreeManager, repoRoot);
    // No error, no commit created -- integration branch should still point to init
    const log = execSync(
      `git -C "${repoRoot}" log --oneline auto/req-001/integration`,
      { encoding: 'utf-8' },
    ).trim();
    expect(log).not.toContain('shared types');
  });

  it('cleans up temporary worktree after commit', async () => {
    const contracts: InterfaceContract[] = [
      {
        producer: 'track-a',
        consumer: 'track-b',
        contractType: 'type-definition',
        definition: 'export interface User {}',
        filePath: 'src/types.ts',
      },
    ];

    await preCommitSharedTypes('req-001', contracts, worktreeManager, repoRoot);

    // Temp worktree should be removed
    const worktrees = await worktreeManager.listWorktrees('req-001');
    expect(
      worktrees.find((w) => w.trackName === 'shared-types-commit'),
    ).toBeUndefined();
  });
});
