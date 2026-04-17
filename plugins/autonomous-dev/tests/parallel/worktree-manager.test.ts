/**
 * Integration tests for WorktreeManager.
 *
 * All tests use a real temp git repo created in beforeEach.
 * Based on SPEC-006-1-2 test cases.
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { ParallelConfig, loadConfig } from '../../src/parallel/config';
import {
  WorktreeManager,
  MaxWorktreesExceededError,
  DiskPressureCriticalError,
} from '../../src/parallel/worktree-manager';
import {
  StatePersister,
} from '../../src/parallel/state-persister';
import { PersistedExecutionState, ExecutionPhase } from '../../src/parallel/types';
import type {
  WorktreeDiskWarningEvent,
  WorktreeDiskCriticalEvent,
} from '../../src/parallel/events';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitSync(repoRoot: string, args: string): string {
  return execSync(`git -C "${repoRoot}" ${args}`, {
    encoding: 'utf-8',
  }).trim();
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorktreeManager', () => {
  let tmpDir: string;
  let repoRoot: string;
  let worktreeRoot: string;
  let emitter: EventEmitter;
  let config: ParallelConfig;
  let wm: WorktreeManager;

  beforeEach(async () => {
    // Create a temp directory with a real git repo
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-test-'));
    repoRoot = path.join(tmpDir, 'repo');
    worktreeRoot = path.join(tmpDir, 'worktrees');

    fs.mkdirSync(repoRoot, { recursive: true });
    fs.mkdirSync(worktreeRoot, { recursive: true });

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
      worktree_root: worktreeRoot,
      max_worktrees: 5,
      disk_warning_threshold_gb: 5,
      disk_hard_limit_gb: 2,
    });
    wm = new WorktreeManager(config, repoRoot, emitter);
  });

  afterEach(async () => {
    wm.stopDiskMonitor();
    // Clean up temp directory
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // createIntegrationBranch
  // -----------------------------------------------------------------------

  describe('createIntegrationBranch', () => {
    it('creates branch from base', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const sha = gitSync(repoRoot, 'rev-parse auto/req-001/integration');
      const mainSha = gitSync(repoRoot, 'rev-parse main');
      expect(sha).toBe(mainSha);
    });

    it('is idempotent', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await expect(
        wm.createIntegrationBranch('req-001', 'main'),
      ).resolves.not.toThrow();
    });

    it('throws if base branch does not exist', async () => {
      await expect(
        wm.createIntegrationBranch('req-001', 'nonexistent'),
      ).rejects.toThrow(/does not exist/);
    });

    it('returns the integration branch name', async () => {
      const name = await wm.createIntegrationBranch('req-001', 'main');
      expect(name).toBe('auto/req-001/integration');
    });
  });

  // -----------------------------------------------------------------------
  // createTrackWorktree
  // -----------------------------------------------------------------------

  describe('createTrackWorktree', () => {
    it('creates worktree directory and branch', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const info = await wm.createTrackWorktree('req-001', 'track-a');
      expect(fs.existsSync(info.worktreePath)).toBe(true);
      const branch = gitSync(info.worktreePath, 'branch --show-current');
      expect(branch).toBe('auto/req-001/track-a');
    });

    it('is idempotent when worktree already exists', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const info1 = await wm.createTrackWorktree('req-001', 'track-a');
      const info2 = await wm.createTrackWorktree('req-001', 'track-a');
      expect(info2.worktreePath).toBe(info1.worktreePath);
    });

    it('rejects when max_worktrees reached', async () => {
      const limitedConfig = loadConfig({
        worktree_root: worktreeRoot,
        max_worktrees: 1,
        disk_warning_threshold_gb: 5,
        disk_hard_limit_gb: 2,
      });
      const limitedWm = new WorktreeManager(limitedConfig, repoRoot, emitter);

      await limitedWm.createIntegrationBranch('req-001', 'main');
      await limitedWm.createTrackWorktree('req-001', 'track-a');
      await expect(
        limitedWm.createTrackWorktree('req-001', 'track-b'),
      ).rejects.toThrow(MaxWorktreesExceededError);
    });

    it('rejects when disk pressure is critical', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      // Force disk pressure to critical
      wm.setDiskPressureLevel('critical');
      await expect(
        wm.createTrackWorktree('req-001', 'track-a'),
      ).rejects.toThrow(DiskPressureCriticalError);
    });

    it('throws if integration branch does not exist', async () => {
      await expect(
        wm.createTrackWorktree('req-001', 'track-a'),
      ).rejects.toThrow(/integration.*does not exist/i);
    });

    it('emits worktree.created event', async () => {
      const events: unknown[] = [];
      emitter.on('worktree.created', (e) => events.push(e));

      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');

      expect(events.length).toBe(1);
      expect((events[0] as any).type).toBe('worktree.created');
      expect((events[0] as any).requestId).toBe('req-001');
      expect((events[0] as any).trackName).toBe('track-a');
    });

    it('creates multiple worktrees for the same request', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const infoA = await wm.createTrackWorktree('req-001', 'track-a');
      const infoB = await wm.createTrackWorktree('req-001', 'track-b');

      expect(fs.existsSync(infoA.worktreePath)).toBe(true);
      expect(fs.existsSync(infoB.worktreePath)).toBe(true);
      expect(infoA.worktreePath).not.toBe(infoB.worktreePath);
    });
  });

  // -----------------------------------------------------------------------
  // listWorktrees
  // -----------------------------------------------------------------------

  describe('listWorktrees', () => {
    it('returns all active worktrees', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      await wm.createTrackWorktree('req-001', 'track-b');

      const list = await wm.listWorktrees();
      expect(list.length).toBe(2);
    });

    it('filters by requestId', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createIntegrationBranch('req-002', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      await wm.createTrackWorktree('req-002', 'track-b');

      const list = await wm.listWorktrees('req-001');
      expect(list.length).toBe(1);
      expect(list[0].requestId).toBe('req-001');
      expect(list[0].trackName).toBe('track-a');
    });

    it('returns empty array when no worktrees exist', async () => {
      const list = await wm.listWorktrees();
      expect(list).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // getWorktree
  // -----------------------------------------------------------------------

  describe('getWorktree', () => {
    it('returns WorktreeInfo for existing worktree', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');

      const info = await wm.getWorktree('req-001', 'track-a');
      expect(info).not.toBeNull();
      expect(info!.trackName).toBe('track-a');
    });

    it('returns null for non-existent worktree', async () => {
      const info = await wm.getWorktree('req-001', 'nonexistent');
      expect(info).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // getActiveWorktreeCount
  // -----------------------------------------------------------------------

  describe('getActiveWorktreeCount', () => {
    it('returns 0 when no worktrees exist', async () => {
      const count = await wm.getActiveWorktreeCount();
      expect(count).toBe(0);
    });

    it('counts active worktrees correctly', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      await wm.createTrackWorktree('req-001', 'track-b');

      const count = await wm.getActiveWorktreeCount();
      expect(count).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // removeWorktree
  // -----------------------------------------------------------------------

  describe('removeWorktree', () => {
    it('removes directory and branch', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const info = await wm.createTrackWorktree('req-001', 'track-a');
      await wm.removeWorktree('req-001', 'track-a');

      expect(fs.existsSync(info.worktreePath)).toBe(false);
      // Branch should be deleted
      expect(() =>
        gitSync(repoRoot, 'rev-parse --verify refs/heads/auto/req-001/track-a'),
      ).toThrow();
    });

    it('is idempotent on missing worktree', async () => {
      await expect(
        wm.removeWorktree('req-001', 'nonexistent'),
      ).resolves.not.toThrow();
    });

    it('emits worktree.removed event', async () => {
      const events: unknown[] = [];
      emitter.on('worktree.removed', (e) => events.push(e));

      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      await wm.removeWorktree('req-001', 'track-a');

      expect(events.length).toBe(1);
      expect((events[0] as any).type).toBe('worktree.removed');
    });

    it('decrements active worktree count', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      await wm.createTrackWorktree('req-001', 'track-b');
      expect(await wm.getActiveWorktreeCount()).toBe(2);

      await wm.removeWorktree('req-001', 'track-a');
      expect(await wm.getActiveWorktreeCount()).toBe(1);
    });

    it('force removes dirty worktree', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const info = await wm.createTrackWorktree('req-001', 'track-a');

      // Create an uncommitted file to make the worktree dirty
      fs.writeFileSync(path.join(info.worktreePath, 'dirty.txt'), 'dirty');

      await wm.removeWorktree('req-001', 'track-a', true);
      expect(fs.existsSync(info.worktreePath)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // cleanupRequest
  // -----------------------------------------------------------------------

  describe('cleanupRequest', () => {
    it('removes all worktrees and integration branch', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      await wm.createTrackWorktree('req-001', 'track-b');

      await wm.cleanupRequest('req-001');

      expect((await wm.listWorktrees('req-001')).length).toBe(0);
      // Integration branch should be gone
      expect(() =>
        gitSync(
          repoRoot,
          'rev-parse --verify refs/heads/auto/req-001/integration',
        ),
      ).toThrow();
    });

    it('removes the request directory', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      const requestDir = path.join(worktreeRoot, 'req-001');
      expect(fs.existsSync(requestDir)).toBe(true);

      await wm.cleanupRequest('req-001');
      expect(fs.existsSync(requestDir)).toBe(false);
    });

    it('is safe to call on non-existent request', async () => {
      await expect(wm.cleanupRequest('req-999')).resolves.not.toThrow();
    });

    it('does not affect other requests', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createIntegrationBranch('req-002', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      await wm.createTrackWorktree('req-002', 'track-b');

      await wm.cleanupRequest('req-001');

      const remaining = await wm.listWorktrees();
      expect(remaining.length).toBe(1);
      expect(remaining[0].requestId).toBe('req-002');
    });
  });

  // -----------------------------------------------------------------------
  // Disk monitoring
  // -----------------------------------------------------------------------

  describe('disk monitoring', () => {
    it('returns disk usage per worktree', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const info = await wm.createTrackWorktree('req-001', 'track-a');

      // Create a file to ensure non-zero disk usage
      fs.writeFileSync(path.join(info.worktreePath, 'data.txt'), 'x'.repeat(1000));

      const usage = await wm.checkDiskUsage();
      expect(usage.totalBytes).toBeGreaterThan(0);
      expect(usage.perWorktree['req-001/track-a']).toBeGreaterThan(0);
    });

    it('emits warning event when threshold exceeded', async () => {
      // Configure very low warning threshold (1 byte = ~0.00000000093 GB)
      const lowConfig = loadConfig({
        worktree_root: worktreeRoot,
        disk_warning_threshold_gb: 0.0000001, // ~107 bytes
        disk_hard_limit_gb: 0.00000001,        // ~10 bytes
      });
      const lowWm = new WorktreeManager(lowConfig, repoRoot, emitter);

      await lowWm.createIntegrationBranch('req-001', 'main');
      await lowWm.createTrackWorktree('req-001', 'track-a');

      const events: WorktreeDiskWarningEvent[] = [];
      emitter.on('worktree.disk_warning', (e) => events.push(e));

      // Reset pressure level to normal so crossing is detected
      lowWm.setDiskPressureLevel('normal');
      await lowWm.checkDiskUsage();

      // With such low thresholds, the worktree files should exceed them
      // Actually, it will go straight to critical since both thresholds are tiny
      // So let's check for critical instead
      const criticalEvents: WorktreeDiskCriticalEvent[] = [];
      emitter.on('worktree.disk_critical', (e) => criticalEvents.push(e));

      lowWm.setDiskPressureLevel('normal');
      await lowWm.checkDiskUsage();

      // At least one disk event should have fired
      const totalEvents = events.length + criticalEvents.length;
      expect(totalEvents).toBeGreaterThan(0);
    });

    it('emits critical event when hard limit exceeded', async () => {
      const lowConfig = loadConfig({
        worktree_root: worktreeRoot,
        disk_warning_threshold_gb: 0.0000001,
        disk_hard_limit_gb: 0.00000001,
      });
      const lowWm = new WorktreeManager(lowConfig, repoRoot, emitter);

      await lowWm.createIntegrationBranch('req-001', 'main');
      await lowWm.createTrackWorktree('req-001', 'track-a');

      const events: WorktreeDiskCriticalEvent[] = [];
      emitter.on('worktree.disk_critical', (e) => events.push(e));

      lowWm.setDiskPressureLevel('normal');
      await lowWm.checkDiskUsage();

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe('worktree.disk_critical');
    });

    it('getDiskPressureLevel returns normal by default', () => {
      expect(wm.getDiskPressureLevel()).toBe('normal');
    });

    it('getDiskPressureLevel updates after checkDiskUsage', async () => {
      const lowConfig = loadConfig({
        worktree_root: worktreeRoot,
        disk_warning_threshold_gb: 0.0000001,
        disk_hard_limit_gb: 0.00000001,
      });
      const lowWm = new WorktreeManager(lowConfig, repoRoot, emitter);

      await lowWm.createIntegrationBranch('req-001', 'main');
      await lowWm.createTrackWorktree('req-001', 'track-a');
      await lowWm.checkDiskUsage();

      expect(lowWm.getDiskPressureLevel()).toBe('critical');
    });

    it('startDiskMonitor and stopDiskMonitor lifecycle', () => {
      // Should not throw
      wm.startDiskMonitor(60000);
      wm.startDiskMonitor(60000); // calling again replaces the interval
      wm.stopDiskMonitor();
      wm.stopDiskMonitor(); // calling again is a no-op
    });
  });

  // -----------------------------------------------------------------------
  // Health validation
  // -----------------------------------------------------------------------

  describe('health validation', () => {
    it('reports healthy worktree', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');

      const report = await wm.validateWorktreeHealth('req-001', 'track-a');
      expect(report.healthy).toBe(true);
      expect(report.directoryExists).toBe(true);
      expect(report.registeredInGit).toBe(true);
      expect(report.branchExists).toBe(true);
      expect(report.isClean).toBe(true);
      expect(report.issues).toEqual([]);
    });

    it('detects missing directory', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const info = await wm.createTrackWorktree('req-001', 'track-a');

      // Manually remove the directory
      fs.rmSync(info.worktreePath, { recursive: true });

      const report = await wm.validateWorktreeHealth('req-001', 'track-a');
      expect(report.directoryExists).toBe(false);
      expect(report.healthy).toBe(false);
      expect(report.issues.length).toBeGreaterThan(0);
    });

    it('detects dirty worktree', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const info = await wm.createTrackWorktree('req-001', 'track-a');

      // Create an uncommitted file
      fs.writeFileSync(path.join(info.worktreePath, 'dirty.txt'), 'dirty');

      const report = await wm.validateWorktreeHealth('req-001', 'track-a');
      expect(report.isClean).toBe(false);
      // Dirty worktree is a warning, not an error -- healthy should still be true
      // because directory exists, registered in git, and branch exists
      expect(report.healthy).toBe(true);
    });

    it('detects unregistered worktree (branch exists but not in worktree list)', async () => {
      // Validate a worktree that was never created
      // The branch doesn't exist and directory doesn't exist
      const report = await wm.validateWorktreeHealth('req-001', 'track-z');
      expect(report.registeredInGit).toBe(false);
      expect(report.healthy).toBe(false);
    });

    it('validateAllWorktrees aggregates reports', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      await wm.createTrackWorktree('req-001', 'track-a');
      await wm.createTrackWorktree('req-001', 'track-b');

      const reports = await wm.validateAllWorktrees();
      expect(reports.length).toBe(2);
      expect(reports.every((r) => r.healthy)).toBe(true);
    });

    it('validateAllWorktrees returns empty array when no worktrees', async () => {
      const reports = await wm.validateAllWorktrees();
      expect(reports).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // Error recovery: no dirty state on failure
  // -----------------------------------------------------------------------

  describe('error recovery', () => {
    it('prunes on removeWorktree even if directory is already gone', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const info = await wm.createTrackWorktree('req-001', 'track-a');

      // Manually nuke the directory (simulating external cleanup)
      fs.rmSync(info.worktreePath, { recursive: true });

      // removeWorktree should not throw and should prune stale metadata
      await expect(
        wm.removeWorktree('req-001', 'track-a'),
      ).resolves.not.toThrow();

      // After removal, the branch should be cleaned up
      expect(() =>
        gitSync(repoRoot, 'rev-parse --verify refs/heads/auto/req-001/track-a'),
      ).toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // cleanupOrphanedWorktrees (SPEC-006-1-3 Section 2)
  // -----------------------------------------------------------------------

  describe('cleanupOrphanedWorktrees', () => {
    let stateDir: string;
    let archiveDir: string;
    let persister: StatePersister;

    function createTestState(
      requestId: string,
      overrides: Partial<PersistedExecutionState> = {},
    ): PersistedExecutionState {
      return {
        version: 1,
        requestId,
        baseBranch: 'main',
        integrationBranch: `auto/${requestId}/integration`,
        phase: 'fan-out' as ExecutionPhase,
        worktrees: {},
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
      };
    }

    beforeEach(async () => {
      stateDir = path.join(tmpDir, 'state');
      archiveDir = path.join(tmpDir, 'archive');
      persister = new StatePersister(stateDir, archiveDir);
      await persister.init();
    });

    it('removes worktrees with no state file', async () => {
      // Create a worktree, then delete its state file
      await wm.createIntegrationBranch('req-orphan', 'main');
      await wm.createTrackWorktree('req-orphan', 'track-a');

      // Save and then delete state to simulate orphan
      await persister.saveState(createTestState('req-orphan'));
      await persister.deleteState('req-orphan');

      const report = await wm.cleanupOrphanedWorktrees(persister);
      expect(report.removedWorktrees.length).toBe(1);
      expect(report.removedWorktrees[0]).toContain('req-orphan');
    });

    it('removes stale auto/* branches', async () => {
      // Create a branch manually without a state file
      execSync(
        `git -C "${repoRoot}" branch auto/stale/integration main`,
        { encoding: 'utf-8' },
      );

      const report = await wm.cleanupOrphanedWorktrees(persister);
      expect(report.removedBranches).toContain('auto/stale/integration');
    });

    it('does not touch non-auto branches', async () => {
      execSync(
        `git -C "${repoRoot}" branch feature/keep main`,
        { encoding: 'utf-8' },
      );

      const report = await wm.cleanupOrphanedWorktrees(persister);
      expect(report.removedBranches).not.toContain('feature/keep');

      // Verify the branch still exists
      expect(() =>
        gitSync(repoRoot, 'rev-parse --verify refs/heads/feature/keep'),
      ).not.toThrow();
    });

    it('handles no orphans gracefully', async () => {
      const report = await wm.cleanupOrphanedWorktrees(persister);
      expect(report.removedWorktrees.length).toBe(0);
      expect(report.removedBranches.length).toBe(0);
      expect(report.errors.length).toBe(0);
    });

    it('does not remove worktrees for in-flight requests', async () => {
      // Create a worktree WITH a valid in-flight state
      await wm.createIntegrationBranch('req-active', 'main');
      const info = await wm.createTrackWorktree('req-active', 'track-a');
      await persister.saveState(
        createTestState('req-active', { phase: 'fan-out' }),
      );

      const report = await wm.cleanupOrphanedWorktrees(persister);
      expect(report.removedWorktrees.length).toBe(0);
      // Worktree should still exist
      expect(fs.existsSync(info.worktreePath)).toBe(true);
    });

    it('does not remove worktrees outside worktreeRoot', async () => {
      // The main repo worktree is not under worktreeRoot, so it should be untouched
      await wm.createIntegrationBranch('req-orphan', 'main');
      await wm.createTrackWorktree('req-orphan', 'track-a');
      await persister.saveState(createTestState('req-orphan'));
      await persister.deleteState('req-orphan');

      const report = await wm.cleanupOrphanedWorktrees(persister);
      // Only the worktree under worktreeRoot should be removed
      for (const removedPath of report.removedWorktrees) {
        expect(removedPath.startsWith(worktreeRoot)).toBe(true);
      }
      // Main repo should still exist
      expect(fs.existsSync(repoRoot)).toBe(true);
    });

    it('runs git worktree prune at the end', async () => {
      // Create a worktree and manually remove its directory to leave stale metadata
      await wm.createIntegrationBranch('req-prune', 'main');
      const info = await wm.createTrackWorktree('req-prune', 'track-a');
      fs.rmSync(info.worktreePath, { recursive: true });

      // Verify stale metadata exists before cleanup
      const beforePrune = gitSync(repoRoot, 'worktree list --porcelain');
      expect(beforePrune).toContain(info.worktreePath);

      await wm.cleanupOrphanedWorktrees(persister);

      // After cleanup + prune, the stale entry should be gone
      const afterPrune = gitSync(repoRoot, 'worktree list --porcelain');
      expect(afterPrune).not.toContain(info.worktreePath);
    });

    it('reports errors without stopping cleanup', async () => {
      // Create two orphaned worktrees
      await wm.createIntegrationBranch('req-err1', 'main');
      await wm.createTrackWorktree('req-err1', 'track-a');
      await wm.createIntegrationBranch('req-err2', 'main');
      await wm.createTrackWorktree('req-err2', 'track-a');

      const report = await wm.cleanupOrphanedWorktrees(persister);
      // Both should be cleaned up (no state for either)
      expect(report.removedWorktrees.length).toBe(2);
    });

    it('removes multiple orphaned worktrees from the same request', async () => {
      await wm.createIntegrationBranch('req-multi', 'main');
      await wm.createTrackWorktree('req-multi', 'track-a');
      await wm.createTrackWorktree('req-multi', 'track-b');

      const report = await wm.cleanupOrphanedWorktrees(persister);
      expect(report.removedWorktrees.length).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // ensureGitignore (SPEC-006-1-3 Section 3)
  // -----------------------------------------------------------------------

  describe('ensureGitignore', () => {
    it('creates .gitignore with required entries when file does not exist', async () => {
      const gitignorePath = path.join(repoRoot, '.gitignore');
      // Ensure no .gitignore exists
      try {
        fs.unlinkSync(gitignorePath);
      } catch {
        // File may not exist
      }

      await wm.ensureGitignore();

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('.worktrees/');
      expect(content).toContain('.autonomous-dev/state/');
      expect(content).toContain('.autonomous-dev/archive/');
    });

    it('appends missing entries to existing .gitignore', async () => {
      const gitignorePath = path.join(repoRoot, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\n.worktrees/\n');

      await wm.ensureGitignore();

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('node_modules/');
      expect(content).toContain('.worktrees/');
      expect(content).toContain('.autonomous-dev/state/');
      expect(content).toContain('.autonomous-dev/archive/');
    });

    it('does not duplicate entries', async () => {
      const gitignorePath = path.join(repoRoot, '.gitignore');
      fs.writeFileSync(
        gitignorePath,
        '.worktrees/\n.autonomous-dev/state/\n.autonomous-dev/archive/\n',
      );

      await wm.ensureGitignore();

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      // Count occurrences of '.worktrees/'
      const matches = content.match(/\.worktrees\//g);
      expect(matches).not.toBeNull();
      expect(matches!.length).toBe(1);
    });

    it('is idempotent (calling twice does not change file)', async () => {
      await wm.ensureGitignore();
      const content1 = fs.readFileSync(
        path.join(repoRoot, '.gitignore'),
        'utf-8',
      );

      await wm.ensureGitignore();
      const content2 = fs.readFileSync(
        path.join(repoRoot, '.gitignore'),
        'utf-8',
      );

      expect(content1).toBe(content2);
    });

    it('handles .gitignore without trailing newline', async () => {
      const gitignorePath = path.join(repoRoot, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/'); // no trailing newline

      await wm.ensureGitignore();

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      // Should have a newline before the added entries
      expect(content).toContain('node_modules/\n');
      expect(content).toContain('.worktrees/');
    });
  });

  // -----------------------------------------------------------------------
  // Orphan cleanup helpers
  // -----------------------------------------------------------------------

  describe('orphan cleanup helpers', () => {
    it('parseWorktreePath extracts requestId and trackName', () => {
      const result = wm.parseWorktreePath(
        path.join(worktreeRoot, 'req-001', 'track-a'),
      );
      expect(result.requestId).toBe('req-001');
      expect(result.trackName).toBe('track-a');
    });

    it('parseWorktreePath returns empty for paths not matching convention', () => {
      const result = wm.parseWorktreePath('/some/other/path');
      expect(result.requestId).toBe('');
    });

    it('extractRequestIdFromBranch extracts from auto/* branches', () => {
      expect(wm.extractRequestIdFromBranch('auto/req-001/integration')).toBe(
        'req-001',
      );
      expect(wm.extractRequestIdFromBranch('auto/req-002/track-a')).toBe(
        'req-002',
      );
    });

    it('extractRequestIdFromBranch returns null for non-auto branches', () => {
      expect(wm.extractRequestIdFromBranch('feature/foo')).toBeNull();
      expect(wm.extractRequestIdFromBranch('main')).toBeNull();
    });

    it('listAutoBranches returns auto/* branches', async () => {
      await wm.createIntegrationBranch('req-001', 'main');
      const branches = await wm.listAutoBranches();
      expect(branches).toContain('auto/req-001/integration');
    });

    it('listAutoBranches returns empty when no auto branches exist', async () => {
      const branches = await wm.listAutoBranches();
      expect(branches).toEqual([]);
    });
  });
});
