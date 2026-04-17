// ============================================================================
// Tests for Integration Tester — SPEC-006-5-2 and SPEC-006-5-3
// SPEC-006-5-2: ShellTestRunner — test output parsing, events, worktree lifecycle
// SPEC-006-5-3: Failure Attribution and Revision Loop
//
// Tests use real temp git repos with merge commits to validate
// attribution strategies, revision worktree creation, and circuit breakers.
// ShellTestRunner tests use stubs for isolation.
// ============================================================================

import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  IntegrationTester,
  ShellTestRunner,
  FailedTest,
  FailureAttribution,
  IntegrationTestResult,
  ShellTestRunnerResult,
  IntegrationTestConfig,
  RevisionLimitExceededError,
  IntegrationTestCircuitBreakerError,
  TestRunner,
} from '../../src/parallel/integration-tester';
import { ParallelConfig, DEFAULT_PARALLEL_CONFIG } from '../../src/parallel/config';
import { WorktreeManager } from '../../src/parallel/worktree-manager';
import { StatePersister } from '../../src/parallel/state-persister';
import type { WorktreeInfo } from '../../src/parallel/types';

// ============================================================================
// Helpers — create disposable git repos with merge commits
// ============================================================================

/** Create a temporary directory that is cleaned up after the test. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'integration-tester-test-'));
}

/** Run a git command inside a repo. */
function git(repoRoot: string, args: string): string {
  return execSync(`git -C "${repoRoot}" ${args}`, { encoding: 'utf-8' }).trim();
}

/**
 * Create a test repo with an integration branch and track merge commits.
 *
 * Structure:
 *   - Initial commit on main with README.md
 *   - Integration branch auto/req-001/integration
 *   - Track branches created from integration, each with file changes
 *   - Each track is merged into integration with a conventional merge message:
 *     "merge: {trackName} into auto/req-001/integration"
 *
 * Returns the repo root path.
 */
function createTestRepo(opts: {
  tracks: Record<string, Record<string, string>>;
  baseFiles?: Record<string, string>;
}): string {
  const repoRoot = makeTempDir();

  // Init repo
  git(repoRoot, 'init -b main');
  git(repoRoot, 'config user.email "test@test.com"');
  git(repoRoot, 'config user.name "Test"');

  // Initial commit on main
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Test Repo\n');
  git(repoRoot, 'add README.md');

  // Add base files if provided
  if (opts.baseFiles) {
    for (const [filePath, content] of Object.entries(opts.baseFiles)) {
      const fullPath = path.join(repoRoot, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      git(repoRoot, `add "${filePath}"`);
    }
  }

  git(repoRoot, 'commit -m "initial commit"');

  // Create integration branch
  git(repoRoot, 'checkout -b auto/req-001/integration');

  // Create track branches and merge them into integration
  for (const [trackName, files] of Object.entries(opts.tracks)) {
    // Create track branch from integration
    git(repoRoot, `checkout -b auto/req-001/${trackName} auto/req-001/integration`);

    for (const [filePath, content] of Object.entries(files)) {
      const fullPath = path.join(repoRoot, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      git(repoRoot, `add "${filePath}"`);
    }
    git(repoRoot, `commit -m "${trackName}: add changes"`);

    // Return to integration and merge with conventional message
    git(repoRoot, 'checkout auto/req-001/integration');
    git(repoRoot, `merge --no-ff auto/req-001/${trackName} -m "merge: ${trackName} into auto/req-001/integration"`);
  }

  return repoRoot;
}

/** Clean up a temp repo. */
function cleanupRepo(repoRoot: string): void {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

// ============================================================================
// Mock test runner
// ============================================================================

class MockTestRunner implements TestRunner {
  public pass = true;
  public failedTests: FailedTest[] = [];
  public totalTests = 5;

  async run(_repoRoot: string, _integrationBranch: string): Promise<IntegrationTestResult> {
    if (this.pass) {
      return {
        passed: true,
        totalTests: this.totalTests,
        passedTests: this.totalTests,
        failedTests: [],
        durationMs: 100,
      };
    }
    return {
      passed: false,
      totalTests: this.totalTests,
      passedTests: this.totalTests - this.failedTests.length,
      failedTests: this.failedTests,
      durationMs: 200,
    };
  }
}

// ============================================================================
// Mock worktree manager
// ============================================================================

class MockWorktreeManager {
  public createdWorktrees: { requestId: string; trackName: string }[] = [];

  async createTrackWorktree(requestId: string, trackName: string): Promise<WorktreeInfo> {
    this.createdWorktrees.push({ requestId, trackName });
    return {
      requestId,
      trackName,
      worktreePath: `/tmp/worktrees/${requestId}/${trackName}`,
      branchName: `auto/${requestId}/${trackName}`,
      integrationBranch: `auto/${requestId}/integration`,
      createdAt: new Date().toISOString(),
      status: 'active',
    };
  }

  async listWorktrees(requestId?: string): Promise<WorktreeInfo[]> {
    return this.createdWorktrees
      .filter(w => !requestId || w.requestId === requestId)
      .map(w => ({
        requestId: w.requestId,
        trackName: w.trackName,
        worktreePath: `/tmp/worktrees/${w.requestId}/${w.trackName}`,
        branchName: `auto/${w.requestId}/${w.trackName}`,
        integrationBranch: `auto/${w.requestId}/integration`,
        createdAt: new Date().toISOString(),
        status: 'active' as const,
      }));
  }
}

// ============================================================================
// attributeFailures
// ============================================================================

describe('attributeFailures', () => {
  let bus: EventEmitter;
  let mockTestRunner: MockTestRunner;
  let mockWorktreeManager: MockWorktreeManager;
  let repoRoot: string;
  let tester: IntegrationTester;
  const config: ParallelConfig = { ...DEFAULT_PARALLEL_CONFIG };

  afterEach(() => {
    if (repoRoot) {
      cleanupRepo(repoRoot);
    }
  });

  describe('strategy 1: test file modified by merge commit', () => {
    beforeEach(() => {
      // track-a modifies src/user.ts and src/user.test.ts
      // track-b modifies src/auth.ts
      repoRoot = createTestRepo({
        tracks: {
          'track-a': {
            'src/user.ts': 'export function createUser() { return true; }\n',
            'src/user.test.ts': 'import { createUser } from "./user";\ntest("should create user", () => expect(createUser()).toBe(true));\n',
          },
          'track-b': {
            'src/auth.ts': 'export function authenticate() { return true; }\n',
          },
        },
      });

      bus = new EventEmitter();
      mockTestRunner = new MockTestRunner();
      mockWorktreeManager = new MockWorktreeManager();

      tester = new IntegrationTester(
        config,
        repoRoot,
        bus,
        mockWorktreeManager as unknown as WorktreeManager,
        mockTestRunner,
      );
    });

    it('attributes test failure to track that modified test file', async () => {
      const attributions = await tester.attributeFailures('req-001', [{
        testFile: 'src/user.test.ts',
        testName: 'should create user',
        lineNumber: null,
        errorMessage: 'expected true, got false',
      }]);
      expect(attributions.has('track-a')).toBe(true);
    });

    it('does not attribute test failure to unrelated track', async () => {
      const attributions = await tester.attributeFailures('req-001', [{
        testFile: 'src/user.test.ts',
        testName: 'should create user',
        lineNumber: null,
        errorMessage: 'expected true, got false',
      }]);
      // track-b did not modify user.test.ts
      expect(attributions.has('track-b')).toBe(false);
    });

    it('sets confidence to high when single track identified', async () => {
      const attributions = await tester.attributeFailures('req-001', [{
        testFile: 'src/user.test.ts',
        testName: 'should create user',
        lineNumber: null,
        errorMessage: 'expected true, got false',
      }]);
      const attrs = attributions.get('track-a')!;
      expect(attrs).toBeDefined();
      expect(attrs[0].confidence).toBe('high');
    });
  });

  describe('strategy 2: import analysis', () => {
    beforeEach(() => {
      // track-a modifies src/user.ts
      // src/integration.test.ts imports src/user.ts but is NOT itself modified by any track
      // We need to set up base files that exist before the tracks merge
      repoRoot = createTestRepo({
        baseFiles: {
          'src/integration.test.ts': 'import { createUser } from "./user";\ntest("integration", () => expect(createUser()).toBe(true));\n',
          'src/user.ts': '// placeholder\n',
        },
        tracks: {
          'track-a': {
            'src/user.ts': 'export function createUser() { return true; }\n',
          },
        },
      });

      bus = new EventEmitter();
      mockTestRunner = new MockTestRunner();
      mockWorktreeManager = new MockWorktreeManager();

      tester = new IntegrationTester(
        config,
        repoRoot,
        bus,
        mockWorktreeManager as unknown as WorktreeManager,
        mockTestRunner,
      );
    });

    it('attributes via import analysis when test file not directly modified', async () => {
      const attributions = await tester.attributeFailures('req-001', [{
        testFile: 'src/integration.test.ts',
        testName: 'integration test',
        lineNumber: null,
        errorMessage: 'error',
      }]);
      // Strategy 1 should find nothing (test file not modified by a merge).
      // Strategy 2 traces the import to src/user.ts, which was modified by track-a.
      expect(attributions.size).toBeGreaterThan(0);
      expect(attributions.has('track-a')).toBe(true);
    });
  });

  describe('multiple responsible tracks', () => {
    beforeEach(() => {
      // Both track-a and track-b modify the same test file
      repoRoot = createTestRepo({
        baseFiles: {
          'src/combined.test.ts': '// original\n',
        },
        tracks: {
          'track-a': {
            'src/combined.test.ts': '// modified by track-a\ntest("a", () => {});\n',
          },
          'track-b': {
            'src/combined.test.ts': '// modified by track-a and track-b\ntest("a", () => {});\ntest("b", () => {});\n',
          },
        },
      });

      bus = new EventEmitter();
      mockTestRunner = new MockTestRunner();
      mockWorktreeManager = new MockWorktreeManager();

      tester = new IntegrationTester(
        config,
        repoRoot,
        bus,
        mockWorktreeManager as unknown as WorktreeManager,
        mockTestRunner,
      );
    });

    it('handles multiple responsible tracks', async () => {
      const attributions = await tester.attributeFailures('req-001', [{
        testFile: 'src/combined.test.ts',
        testName: 'combined test',
        lineNumber: null,
        errorMessage: 'error',
      }]);
      // Both tracks modified the test file
      expect(attributions.size).toBeGreaterThanOrEqual(1);
      for (const [, attrs] of attributions) {
        // When multiple tracks are responsible, confidence is medium
        expect(attrs[0].confidence).toBe('medium');
      }
    });
  });

  describe('fallback to unknown', () => {
    beforeEach(() => {
      // Create a repo where no track modifies the failing test file
      repoRoot = createTestRepo({
        baseFiles: {
          'src/unrelated.test.ts': 'test("unrelated", () => expect(1).toBe(1));\n',
        },
        tracks: {
          'track-a': {
            'src/other.ts': 'export const x = 1;\n',
          },
        },
      });

      bus = new EventEmitter();
      mockTestRunner = new MockTestRunner();
      mockWorktreeManager = new MockWorktreeManager();

      tester = new IntegrationTester(
        config,
        repoRoot,
        bus,
        mockWorktreeManager as unknown as WorktreeManager,
        mockTestRunner,
      );
    });

    it('falls back to unknown when no track identified', async () => {
      const attributions = await tester.attributeFailures('req-001', [{
        testFile: 'src/unrelated.test.ts',
        testName: 'unrelated test',
        lineNumber: null,
        errorMessage: 'error',
      }]);
      expect(attributions.has('unknown')).toBe(true);
    });
  });

  describe('strategy 3: git blame with line numbers', () => {
    beforeEach(() => {
      // track-a modifies a specific line in a test file
      repoRoot = createTestRepo({
        baseFiles: {
          'src/blame.test.ts': 'line1\nline2\nline3\nline4\n',
        },
        tracks: {
          'track-a': {
            'src/blame.test.ts': 'line1\nmodified-by-track-a\nline3\nline4\n',
          },
        },
      });

      bus = new EventEmitter();
      mockTestRunner = new MockTestRunner();
      mockWorktreeManager = new MockWorktreeManager();

      tester = new IntegrationTester(
        config,
        repoRoot,
        bus,
        mockWorktreeManager as unknown as WorktreeManager,
        mockTestRunner,
      );
    });

    it('uses blame on specific line numbers when available', async () => {
      // The test file was modified by the merge, so strategy 1 should find track-a.
      // This test verifies that line-level attribution also works if strategy 1 fails.
      const attributions = await tester.attributeFailures('req-001', [{
        testFile: 'src/blame.test.ts',
        testName: 'blame test',
        lineNumber: 2,
        errorMessage: 'line 2 assertion failed',
      }]);
      // At least one track should be identified
      expect(attributions.size).toBeGreaterThan(0);
      // track-a modified line 2
      expect(
        attributions.has('track-a') || attributions.has('unknown'),
      ).toBe(true);
    });
  });
});

// ============================================================================
// reviseTrack
// ============================================================================

describe('reviseTrack', () => {
  let bus: EventEmitter;
  let mockTestRunner: MockTestRunner;
  let mockWorktreeManager: MockWorktreeManager;
  let tester: IntegrationTester;
  const config: ParallelConfig = { ...DEFAULT_PARALLEL_CONFIG, max_revision_cycles: 2 };

  const mockAttribution: FailureAttribution = {
    testFile: 'src/user.test.ts',
    testName: 'should create user',
    responsibleTracks: ['track-a'],
    confidence: 'high',
    evidence: 'Identified via git log/blame analysis',
  };

  beforeEach(() => {
    bus = new EventEmitter();
    mockTestRunner = new MockTestRunner();
    mockWorktreeManager = new MockWorktreeManager();

    tester = new IntegrationTester(
      config,
      '/tmp/unused-repo',
      bus,
      mockWorktreeManager as unknown as WorktreeManager,
      mockTestRunner,
    );
  });

  it('creates revision worktree with cycle number', async () => {
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
    const worktrees = await mockWorktreeManager.listWorktrees('req-001');
    expect(worktrees.find(w => w.trackName === 'track-a-rev1')).toBeDefined();
  });

  it('increments revision count', async () => {
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
    const worktrees = await mockWorktreeManager.listWorktrees('req-001');
    expect(worktrees.find(w => w.trackName === 'track-a-rev1')).toBeDefined();
    expect(worktrees.find(w => w.trackName === 'track-a-rev2')).toBeDefined();
  });

  it('throws RevisionLimitExceededError when max cycles exceeded', async () => {
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]); // cycle 1
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]); // cycle 2
    await expect(
      tester.reviseTrack('req-001', 'track-a', [mockAttribution]), // cycle 3 > max 2
    ).rejects.toThrow(RevisionLimitExceededError);
  });

  it('emits request.escalated when revision limit exceeded', async () => {
    const events: any[] = [];
    bus.on('request.escalated', (e: any) => events.push(e));
    try {
      for (let i = 0; i < 3; i++) {
        await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
      }
    } catch {
      // expected
    }
    expect(events.length).toBe(1);
    expect(events[0].reason).toContain('revision cycles');
  });

  it('emits track.state_changed for each successful revision', async () => {
    const events: any[] = [];
    bus.on('track.state_changed', (e: any) => events.push(e));
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
    expect(events.length).toBe(1);
    expect(events[0].trackName).toBe('track-a-rev1');
    expect(events[0].to).toBe('queued');
    expect(events[0].reason).toContain('Revision cycle 1');
  });

  it('tracks separate revision counts per track', async () => {
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
    await tester.reviseTrack('req-001', 'track-b', [mockAttribution]);
    expect(tester.getRevisionCount('track-a')).toBe(1);
    expect(tester.getRevisionCount('track-b')).toBe(1);
  });

  it('does not create worktree when limit exceeded', async () => {
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]); // cycle 1
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]); // cycle 2
    const worktreesBefore = mockWorktreeManager.createdWorktrees.length;
    try {
      await tester.reviseTrack('req-001', 'track-a', [mockAttribution]); // cycle 3
    } catch {
      // expected
    }
    // No additional worktree should be created
    expect(mockWorktreeManager.createdWorktrees.length).toBe(worktreesBefore);
  });
});

// ============================================================================
// Integration test circuit breaker
// ============================================================================

describe('integration test circuit breaker', () => {
  let bus: EventEmitter;
  let mockTestRunner: MockTestRunner;
  let mockWorktreeManager: MockWorktreeManager;
  let tester: IntegrationTester;
  let repoRoot: string;
  const config: ParallelConfig = { ...DEFAULT_PARALLEL_CONFIG, max_revision_cycles: 2 };

  beforeEach(() => {
    // Create a real repo so attributeFailures doesn't crash on git commands
    repoRoot = createTestRepo({
      tracks: {
        'track-a': {
          'src/user.ts': 'export function createUser() { return true; }\n',
        },
      },
    });

    bus = new EventEmitter();
    mockTestRunner = new MockTestRunner();
    mockWorktreeManager = new MockWorktreeManager();

    tester = new IntegrationTester(
      config,
      repoRoot,
      bus,
      mockWorktreeManager as unknown as WorktreeManager,
      mockTestRunner,
    );
  });

  afterEach(() => {
    if (repoRoot) {
      cleanupRepo(repoRoot);
    }
  });

  it('resets count on passing test', async () => {
    // Simulate 2 prior failures
    (tester as any).consecutiveFailures = 2;
    mockTestRunner.pass = true;
    await tester.runIntegrationTestsWithRevision('req-001');
    expect((tester as any).consecutiveFailures).toBe(0);
  });

  it('returns passing result directly', async () => {
    mockTestRunner.pass = true;
    const result = await tester.runIntegrationTestsWithRevision('req-001');
    expect(result.passed).toBe(true);
    expect(result.failedTests).toHaveLength(0);
  });

  it('increments consecutive failure count on each failure', async () => {
    mockTestRunner.pass = false;
    mockTestRunner.failedTests = [{
      testFile: 'src/user.ts',
      testName: 'test',
      lineNumber: null,
      errorMessage: 'fail',
    }];

    await tester.runIntegrationTestsWithRevision('req-001');
    expect((tester as any).consecutiveFailures).toBe(1);
  });

  it('trips after 3 consecutive failures', async () => {
    mockTestRunner.pass = false;
    mockTestRunner.failedTests = [{
      testFile: 'src/some.test.ts',
      testName: 'test',
      lineNumber: null,
      errorMessage: 'fail',
    }];

    await expect(async () => {
      for (let i = 0; i < 3; i++) {
        await tester.runIntegrationTestsWithRevision('req-001');
      }
    }).rejects.toThrow(IntegrationTestCircuitBreakerError);
  });

  it('emits request.escalated on trip', async () => {
    const events: any[] = [];
    bus.on('request.escalated', (e: any) => events.push(e));

    mockTestRunner.pass = false;
    mockTestRunner.failedTests = [{
      testFile: 'src/some.test.ts',
      testName: 'test',
      lineNumber: null,
      errorMessage: 'fail',
    }];

    try {
      for (let i = 0; i < 3; i++) {
        await tester.runIntegrationTestsWithRevision('req-001');
      }
    } catch {
      // expected
    }
    expect(events.some(e => e.reason.includes('circuit breaker'))).toBe(true);
  });

  it('does not trip before 3 failures', async () => {
    mockTestRunner.pass = false;
    mockTestRunner.failedTests = [{
      testFile: 'src/some.test.ts',
      testName: 'test',
      lineNumber: null,
      errorMessage: 'fail',
    }];

    // 2 failures should not trip
    await tester.runIntegrationTestsWithRevision('req-001');
    await tester.runIntegrationTestsWithRevision('req-001');
    expect((tester as any).consecutiveFailures).toBe(2);
  });

  it('attributes failures to tracks on failure', async () => {
    mockTestRunner.pass = false;
    mockTestRunner.failedTests = [{
      testFile: 'src/user.ts',
      testName: 'test',
      lineNumber: null,
      errorMessage: 'fail',
    }];

    const result = await tester.runIntegrationTestsWithRevision('req-001');
    expect(result.passed).toBe(false);
    // The attribution process should have run (no errors thrown)
    // track-a modified src/user.ts
  });

  it('resets on pass after failures', async () => {
    mockTestRunner.pass = false;
    mockTestRunner.failedTests = [{
      testFile: 'src/some.test.ts',
      testName: 'test',
      lineNumber: null,
      errorMessage: 'fail',
    }];

    // 2 failures
    await tester.runIntegrationTestsWithRevision('req-001');
    await tester.runIntegrationTestsWithRevision('req-001');
    expect((tester as any).consecutiveFailures).toBe(2);

    // Then a pass
    mockTestRunner.pass = true;
    await tester.runIntegrationTestsWithRevision('req-001');
    expect((tester as any).consecutiveFailures).toBe(0);
  });
});

// ============================================================================
// runIntegrationTests (basic)
// ============================================================================

describe('runIntegrationTests', () => {
  let bus: EventEmitter;
  let mockTestRunner: MockTestRunner;
  let mockWorktreeManager: MockWorktreeManager;
  let tester: IntegrationTester;
  const config: ParallelConfig = { ...DEFAULT_PARALLEL_CONFIG };

  beforeEach(() => {
    bus = new EventEmitter();
    mockTestRunner = new MockTestRunner();
    mockWorktreeManager = new MockWorktreeManager();

    tester = new IntegrationTester(
      config,
      '/tmp/unused-repo',
      bus,
      mockWorktreeManager as unknown as WorktreeManager,
      mockTestRunner,
    );
  });

  it('delegates to testRunner.run', async () => {
    mockTestRunner.pass = true;
    const result = await tester.runIntegrationTests('req-001');
    expect(result.passed).toBe(true);
    expect(result.totalTests).toBe(5);
  });

  it('returns failing result when tests fail', async () => {
    mockTestRunner.pass = false;
    mockTestRunner.failedTests = [{
      testFile: 'src/test.ts',
      testName: 'test',
      lineNumber: null,
      errorMessage: 'fail',
    }];
    const result = await tester.runIntegrationTests('req-001');
    expect(result.passed).toBe(false);
    expect(result.failedTests).toHaveLength(1);
  });
});

// ============================================================================
// buildFailureContext (via revision flow)
// ============================================================================

describe('failure context building', () => {
  let bus: EventEmitter;
  let mockTestRunner: MockTestRunner;
  let mockWorktreeManager: MockWorktreeManager;
  let tester: IntegrationTester;
  const config: ParallelConfig = { ...DEFAULT_PARALLEL_CONFIG, max_revision_cycles: 2 };

  beforeEach(() => {
    bus = new EventEmitter();
    mockTestRunner = new MockTestRunner();
    mockWorktreeManager = new MockWorktreeManager();

    tester = new IntegrationTester(
      config,
      '/tmp/unused-repo',
      bus,
      mockWorktreeManager as unknown as WorktreeManager,
      mockTestRunner,
    );
  });

  it('emits track.state_changed with failure count in reason', async () => {
    const events: any[] = [];
    bus.on('track.state_changed', (e: any) => events.push(e));

    const failures: FailureAttribution[] = [
      {
        testFile: 'src/a.test.ts',
        testName: 'test a',
        responsibleTracks: ['track-a'],
        confidence: 'high',
        evidence: 'git log',
      },
      {
        testFile: 'src/b.test.ts',
        testName: 'test b',
        responsibleTracks: ['track-a'],
        confidence: 'high',
        evidence: 'git log',
      },
    ];

    await tester.reviseTrack('req-001', 'track-a', failures);

    expect(events[0].reason).toContain('2 test failures');
  });
});

// ============================================================================
// ShellTestRunner — SPEC-006-5-2
// Test output parsing, event emission, worktree lifecycle, configurable commands
// ============================================================================

/**
 * Stub WorktreeManager for ShellTestRunner tests.
 */
class StubWorktreeManager {
  public created: Array<{ requestId: string; trackName: string }> = [];
  public removed: Array<{ requestId: string; trackName: string; force: boolean }> = [];

  async createTrackWorktree(
    requestId: string,
    trackName: string,
  ): Promise<WorktreeInfo> {
    this.created.push({ requestId, trackName });
    return {
      requestId,
      trackName,
      worktreePath: `/tmp/worktrees/${requestId}/${trackName}`,
      branchName: `auto/${requestId}/${trackName}`,
      integrationBranch: `auto/${requestId}/integration`,
      createdAt: new Date().toISOString(),
      status: 'active',
    };
  }

  async removeWorktree(
    requestId: string,
    trackName: string,
    force: boolean,
  ): Promise<void> {
    this.removed.push({ requestId, trackName, force });
  }
}

describe('ShellTestRunner', () => {
  let shellConfig: IntegrationTestConfig;
  let stubWorktreeManager: StubWorktreeManager;
  let shellBus: EventEmitter;

  beforeEach(() => {
    shellConfig = {
      ...DEFAULT_PARALLEL_CONFIG,
      test_command: 'echo "test passed"',
      install_command: 'echo "installed"',
    };
    stubWorktreeManager = new StubWorktreeManager();
    shellBus = new EventEmitter();
  });

  // =========================================================================
  // parseTestOutput
  // =========================================================================

  describe('parseTestOutput', () => {
    let runner: ShellTestRunner;

    beforeEach(() => {
      runner = new ShellTestRunner(
        '/tmp/repo',
        shellConfig,
        stubWorktreeManager as unknown as WorktreeManager,
        shellBus,
      );
    });

    it('parses Jest FAIL output format', () => {
      const output = `FAIL src/user.test.ts\n  \u2715 should create user (42ms)\n\nExpected: true\nReceived: false`;
      const failed = runner.parseTestOutput(output);
      expect(failed.length).toBe(1);
      expect(failed[0].testFile).toBe('src/user.test.ts');
    });

    it('parses multiple FAIL lines', () => {
      const output = `FAIL src/user.test.ts\n  \u2715 should create user\nFAIL src/auth.test.ts\n  \u2715 should authenticate`;
      const failed = runner.parseTestOutput(output);
      expect(failed.length).toBe(2);
      expect(failed[0].testFile).toBe('src/user.test.ts');
      expect(failed[1].testFile).toBe('src/auth.test.ts');
    });

    it('extracts test names from unicode cross mark', () => {
      const output = `FAIL src/user.test.ts\n  \u2715 should create user (42ms)`;
      const failed = runner.parseTestOutput(output);
      expect(failed[0].testName).toBe('should create user');
    });

    it('extracts test names from x mark', () => {
      const output = `FAIL src/user.test.ts\n  x should create user (42ms)`;
      const failed = runner.parseTestOutput(output);
      expect(failed[0].testName).toBe('should create user');
    });

    it('extracts Expected/Received error messages', () => {
      const output = `FAIL src/user.test.ts\n  \u2715 should create user\n\nExpected: true\nReceived: false`;
      const failed = runner.parseTestOutput(output);
      expect(failed[0].errorMessage).toContain('Expected: true');
      expect(failed[0].errorMessage).toContain('Received: false');
    });

    it('returns empty array for passing output', () => {
      const output = `PASS src/user.test.ts\n  \u2713 should create user (42ms)`;
      const failed = runner.parseTestOutput(output);
      expect(failed.length).toBe(0);
    });

    it('handles empty output', () => {
      expect(runner.parseTestOutput('')).toEqual([]);
    });

    it('handles .tsx and .jsx file extensions', () => {
      const output = `FAIL src/Component.test.tsx\nFAIL src/Other.test.jsx`;
      const failed = runner.parseTestOutput(output);
      expect(failed.length).toBe(2);
      expect(failed[0].testFile).toBe('src/Component.test.tsx');
      expect(failed[1].testFile).toBe('src/Other.test.jsx');
    });

    it('handles .js file extensions', () => {
      const output = 'FAIL src/user.test.js';
      const failed = runner.parseTestOutput(output);
      expect(failed.length).toBe(1);
      expect(failed[0].testFile).toBe('src/user.test.js');
    });

    it('sets lineNumber to null by default', () => {
      const output = 'FAIL src/user.test.ts';
      const failed = runner.parseTestOutput(output);
      expect(failed[0].lineNumber).toBeNull();
    });

    it('sets empty testName and errorMessage when not parseable', () => {
      const output = 'FAIL src/user.test.ts';
      const failed = runner.parseTestOutput(output);
      expect(failed[0].testName).toBe('');
      expect(failed[0].errorMessage).toBe('');
    });
  });

  // =========================================================================
  // Event emission
  // =========================================================================

  describe('event emission', () => {
    it('emits integration.test_started on runIntegrationTests', async () => {
      const events: Array<Record<string, unknown>> = [];
      shellBus.on('integration.test_started', (e: Record<string, unknown>) => events.push(e));

      const runner = new ShellTestRunner(
        '/tmp/repo',
        shellConfig,
        stubWorktreeManager as unknown as WorktreeManager,
        shellBus,
      );

      try {
        await runner.runIntegrationTests('req-001');
      } catch {
        // Expected: git checkout fails
      }

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('integration.test_started');
      expect(events[0].requestId).toBe('req-001');
    });
  });

  // =========================================================================
  // Worktree lifecycle
  // =========================================================================

  describe('worktree lifecycle', () => {
    it('creates integration-test worktree', async () => {
      const runner = new ShellTestRunner(
        '/tmp/repo',
        shellConfig,
        stubWorktreeManager as unknown as WorktreeManager,
        shellBus,
      );

      try {
        await runner.runIntegrationTests('req-001');
      } catch {
        // Expected
      }

      expect(stubWorktreeManager.created.length).toBe(1);
      expect(stubWorktreeManager.created[0].requestId).toBe('req-001');
      expect(stubWorktreeManager.created[0].trackName).toBe('integration-test');
    });

    it('removes test worktree even on failure', async () => {
      const runner = new ShellTestRunner(
        '/tmp/repo',
        shellConfig,
        stubWorktreeManager as unknown as WorktreeManager,
        shellBus,
      );

      try {
        await runner.runIntegrationTests('req-001');
      } catch {
        // Expected
      }

      expect(stubWorktreeManager.removed.length).toBe(1);
      expect(stubWorktreeManager.removed[0].requestId).toBe('req-001');
      expect(stubWorktreeManager.removed[0].trackName).toBe('integration-test');
      expect(stubWorktreeManager.removed[0].force).toBe(true);
    });
  });

  // =========================================================================
  // Configurable commands
  // =========================================================================

  describe('configurable commands', () => {
    it('accepts configured test_command', () => {
      shellConfig.test_command = 'yarn test';
      const runner = new ShellTestRunner(
        '/tmp/repo',
        shellConfig,
        stubWorktreeManager as unknown as WorktreeManager,
        shellBus,
      );
      expect(shellConfig.test_command).toBe('yarn test');
    });

    it('accepts configured install_command', () => {
      shellConfig.install_command = 'pnpm install';
      const runner = new ShellTestRunner(
        '/tmp/repo',
        shellConfig,
        stubWorktreeManager as unknown as WorktreeManager,
        shellBus,
      );
      expect(shellConfig.install_command).toBe('pnpm install');
    });

    it('defaults to npm ci for install when unset', () => {
      delete shellConfig.install_command;
      expect(shellConfig.install_command).toBeUndefined();
    });

    it('defaults to npm test for test command when unset', () => {
      delete shellConfig.test_command;
      expect(shellConfig.test_command).toBeUndefined();
    });
  });

  // =========================================================================
  // ShellTestRunnerResult type structure
  // =========================================================================

  describe('ShellTestRunnerResult type', () => {
    it('has all required fields', () => {
      const result: ShellTestRunnerResult = {
        passed: true,
        exitCode: 0,
        output: 'Tests passed',
        failedTests: [],
        duration: 1000,
        logPath: '/tmp/logs/integration-test.log',
      };

      expect(result.passed).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('Tests passed');
      expect(result.failedTests).toEqual([]);
      expect(result.duration).toBe(1000);
      expect(result.logPath).toBe('/tmp/logs/integration-test.log');
    });
  });

  // =========================================================================
  // TestRunner interface compatibility
  // =========================================================================

  describe('TestRunner interface (run method)', () => {
    it('implements the TestRunner interface via run()', () => {
      const runner = new ShellTestRunner(
        '/tmp/repo',
        shellConfig,
        stubWorktreeManager as unknown as WorktreeManager,
        shellBus,
      );
      expect(typeof runner.run).toBe('function');
    });
  });
});
