/**
 * Tests for RetryHandler.
 *
 * SPEC-006-3-3: Retry Policy, Escalation, and Shared Types Pre-Commit
 *
 * Covers:
 *   - First failure with no partial work: resets worktree, retries from scratch
 *   - First failure with partial commits: preserves work, spawns continuation
 *   - Second failure: permanently escalates
 *   - All three failure modes (crash, budget, test failure)
 *   - Event emission with retryCount and reason
 *   - Worktree reset produces a clean working tree
 *
 * Uses real temp git repos for worktree reset and partial work detection.
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import {
  RetryHandler,
  FailureMode,
  RetryDecision,
} from '../../src/parallel/retry-handler';
import {
  AgentLifecyclePhase,
  TrackAssignment,
} from '../../src/parallel/types';
import { AgentSpawner } from '../../src/parallel/agent-spawner';
import { StatePersister } from '../../src/parallel/state-persister';
import { WorktreeManager } from '../../src/parallel/worktree-manager';
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
    lifecyclePhase: AgentLifecyclePhase.Executing,
    interfaceContracts: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('RetryHandler', () => {
  let tmpDir: string;
  let repoRoot: string;
  let worktreeDir: string;
  let emitter: EventEmitter;
  let config: ParallelConfig;
  let worktreeManager: WorktreeManager;
  let agentSpawner: AgentSpawner;
  let statePersister: StatePersister;
  let retryHandler: RetryHandler;
  let assignment: TrackAssignment;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retry-test-'));
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

    emitter = new EventEmitter();
    config = loadConfig({
      worktree_root: worktreeDir,
      max_worktrees: 5,
      disk_warning_threshold_gb: 5,
      disk_hard_limit_gb: 2,
    });

    worktreeManager = new WorktreeManager(config, repoRoot, emitter);
    agentSpawner = new AgentSpawner(config, emitter);
    statePersister = new StatePersister(
      path.join(tmpDir, 'state'),
      path.join(tmpDir, 'archive'),
    );

    retryHandler = new RetryHandler(
      worktreeManager,
      agentSpawner,
      statePersister,
      emitter,
    );

    assignment = createAssignment({
      worktreePath: wtPath,
      branchName: 'auto/req-001/track-a',
    });
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

  // -----------------------------------------------------------------------
  // First failure
  // -----------------------------------------------------------------------

  describe('first failure', () => {
    it('retries from scratch when no partial work', async () => {
      assignment.retryCount = 0;
      // No commits beyond branch point
      const decision = await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );
      expect(decision.action).toBe('retry');
      expect(decision.preservePartialWork).toBe(false);
      expect(assignment.retryCount).toBe(1);
    });

    it('resets worktree on scratch retry', async () => {
      assignment.retryCount = 0;
      // Write a dirty file
      fs.writeFileSync(
        path.join(assignment.worktreePath, 'dirty.txt'),
        'untracked',
      );
      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );
      // Verify worktree is clean
      const status = execSync(
        `git -C "${assignment.worktreePath}" status --porcelain`,
      )
        .toString()
        .trim();
      expect(status).toBe('');
    });

    it('preserves partial work when commits exist', async () => {
      assignment.retryCount = 0;
      // Create a commit in the worktree
      execSync(
        `git -C "${assignment.worktreePath}" commit --allow-empty -m "partial work"`,
      );
      const decision = await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );
      expect(decision.action).toBe('continue');
      expect(decision.preservePartialWork).toBe(true);
    });

    it('resets turnsUsed on scratch retry', async () => {
      assignment.retryCount = 0;
      assignment.turnsUsed = 25;
      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.BudgetExhausted,
      );
      expect(assignment.turnsUsed).toBe(0);
    });

    it('keeps turnsUsed on continuation', async () => {
      assignment.retryCount = 0;
      assignment.turnsUsed = 25;
      // Add partial work
      execSync(
        `git -C "${assignment.worktreePath}" commit --allow-empty -m "partial"`,
      );
      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );
      expect(assignment.turnsUsed).toBe(25);
    });
  });

  // -----------------------------------------------------------------------
  // Second failure
  // -----------------------------------------------------------------------

  describe('second failure', () => {
    it('escalates on second failure', async () => {
      assignment.retryCount = 1; // already retried once
      const decision = await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );
      expect(decision.action).toBe('escalate');
      expect(assignment.retryCount).toBe(2);
    });

    it('emits agent.failed with escalated action', async () => {
      assignment.retryCount = 1;
      const events: any[] = [];
      emitter.on('agent.failed', (e) => events.push(e));
      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.PersistentTestFailures,
      );
      expect(events[0].action).toBe('escalated');
    });

    it('sets lifecycle phase to Failed on escalation', async () => {
      assignment.retryCount = 1;
      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );
      expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Failed);
    });
  });

  // -----------------------------------------------------------------------
  // Failure modes
  // -----------------------------------------------------------------------

  describe('failure modes', () => {
    it('handles agent crash', async () => {
      const decision = await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );
      expect(decision.reason).toContain('agent_crash');
    });

    it('handles budget exhaustion', async () => {
      const decision = await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.BudgetExhausted,
      );
      expect(decision.reason).toContain('budget_exhausted');
    });

    it('handles persistent test failures', async () => {
      const decision = await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.PersistentTestFailures,
      );
      expect(decision.reason).toContain('persistent_test_failures');
    });
  });

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  describe('event emission', () => {
    it('emits agent.failed with retryCount on scratch retry', async () => {
      assignment.retryCount = 0;
      const events: any[] = [];
      emitter.on('agent.failed', (e) => events.push(e));

      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('agent.failed');
      expect(events[0].trackName).toBe('track-a');
      expect(events[0].retryCount).toBe(1);
      expect(events[0].reason).toBe(FailureMode.AgentCrash);
      expect(events[0].action).toBe('retry_from_scratch');
      expect(typeof events[0].timestamp).toBe('string');
    });

    it('emits agent.failed with retry_continue action on partial work retry', async () => {
      assignment.retryCount = 0;
      execSync(
        `git -C "${assignment.worktreePath}" commit --allow-empty -m "partial"`,
      );
      const events: any[] = [];
      emitter.on('agent.failed', (e) => events.push(e));

      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );

      expect(events.length).toBe(1);
      expect(events[0].action).toBe('retry_continue');
      expect(events[0].retryCount).toBe(1);
    });

    it('emits agent.failed with escalated action on second failure', async () => {
      assignment.retryCount = 1;
      const events: any[] = [];
      emitter.on('agent.failed', (e) => events.push(e));

      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.PersistentTestFailures,
      );

      expect(events.length).toBe(1);
      expect(events[0].action).toBe('escalated');
      expect(events[0].retryCount).toBe(2);
      expect(events[0].reason).toBe(FailureMode.PersistentTestFailures);
    });
  });

  // -----------------------------------------------------------------------
  // Worktree reset verification
  // -----------------------------------------------------------------------

  describe('worktree reset', () => {
    it('produces a clean working tree after reset', async () => {
      assignment.retryCount = 0;

      // Make the worktree dirty: add tracked and untracked files
      fs.writeFileSync(
        path.join(assignment.worktreePath, 'untracked.txt'),
        'untracked content',
      );
      fs.mkdirSync(path.join(assignment.worktreePath, 'src'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(assignment.worktreePath, 'src', 'code.ts'),
        'export const x = 1;',
      );
      execSync(
        `git -C "${assignment.worktreePath}" add . && ` +
          `git -C "${assignment.worktreePath}" commit -m "agent work"`,
      );
      fs.writeFileSync(
        path.join(assignment.worktreePath, 'more-untracked.txt'),
        'more stuff',
      );

      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );

      // Verify: no untracked files, no staged changes
      const status = execSync(
        `git -C "${assignment.worktreePath}" status --porcelain`,
      )
        .toString()
        .trim();
      expect(status).toBe('');

      // Verify: HEAD matches integration branch
      const headSHA = execSync(
        `git -C "${assignment.worktreePath}" rev-parse HEAD`,
        { encoding: 'utf-8' },
      ).trim();
      const integrationSHA = execSync(
        `git -C "${repoRoot}" rev-parse auto/req-001/integration`,
        { encoding: 'utf-8' },
      ).trim();
      expect(headSHA).toBe(integrationSHA);
    });

    it('sets assignment fields correctly after scratch retry', async () => {
      assignment.retryCount = 0;
      assignment.turnsUsed = 15;
      assignment.agentSessionId = 'old-session-123';
      assignment.startedAt = '2024-01-01T00:00:00Z';
      assignment.lifecyclePhase = AgentLifecyclePhase.Executing;

      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );

      expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Spawning);
      expect(assignment.turnsUsed).toBe(0);
      expect(assignment.agentSessionId).toBeNull();
      expect(assignment.startedAt).toBeNull();
    });

    it('sets assignment fields correctly after continuation retry', async () => {
      assignment.retryCount = 0;
      assignment.turnsUsed = 15;
      assignment.agentSessionId = 'old-session-123';
      assignment.lifecyclePhase = AgentLifecyclePhase.Executing;

      // Add partial work
      execSync(
        `git -C "${assignment.worktreePath}" commit --allow-empty -m "partial"`,
      );

      await retryHandler.handleFailure(
        'req-001',
        assignment,
        FailureMode.AgentCrash,
      );

      expect(assignment.lifecyclePhase).toBe(AgentLifecyclePhase.Spawning);
      expect(assignment.turnsUsed).toBe(15); // preserved
      expect(assignment.agentSessionId).toBeNull();
    });
  });
});
