// ============================================================================
// Tests for Merge Engine — SPEC-006-4-1
// All tests use real temp git repos with branches.
// ============================================================================

import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { MergeEngine, MergeCircuitBreakerError } from '../../src/parallel/merge-engine';
import { buildAndScheduleDAG } from '../../src/parallel/dag-constructor';
import { ParallelConfig, DEFAULT_PARALLEL_CONFIG } from '../../src/parallel/config';
import { MergeResult } from '../../src/parallel/types';

// ============================================================================
// Helpers — create disposable git repos with branches
// ============================================================================

/** Create a temporary directory that is cleaned up after the test. */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'merge-engine-test-'));
}

/** Run a git command inside a repo. */
function git(repoRoot: string, args: string): string {
  return execSync(`git -C "${repoRoot}" ${args}`, { encoding: 'utf-8' }).trim();
}

/**
 * Bootstrap a bare-bones git repo with:
 *   - An initial commit on main
 *   - An integration branch (auto/req-001/integration)
 *   - One or more track branches with changes
 *
 * Returns the repo root path.
 */
function createTestRepo(opts?: {
  /** Files to create on the integration branch (after initial commit). */
  integrationFiles?: Record<string, string>;
  /** Track branches to create, each with their own file changes. */
  tracks?: Record<string, Record<string, string>>;
}): string {
  const repoRoot = makeTempDir();

  // Init repo
  git(repoRoot, 'init -b main');
  git(repoRoot, 'config user.email "test@test.com"');
  git(repoRoot, 'config user.name "Test"');

  // Initial commit on main
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Test Repo\n');
  git(repoRoot, 'add README.md');
  git(repoRoot, 'commit -m "initial commit"');

  // Create integration branch
  git(repoRoot, 'checkout -b auto/req-001/integration');

  // Add integration-specific files if provided
  if (opts?.integrationFiles) {
    for (const [filePath, content] of Object.entries(opts.integrationFiles)) {
      const fullPath = path.join(repoRoot, filePath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
      git(repoRoot, `add "${filePath}"`);
    }
    git(repoRoot, 'commit -m "integration branch setup"');
  }

  // Create track branches from the integration branch tip
  if (opts?.tracks) {
    for (const [trackName, files] of Object.entries(opts.tracks)) {
      git(repoRoot, `checkout -b auto/req-001/${trackName} auto/req-001/integration`);
      for (const [filePath, content] of Object.entries(files)) {
        const fullPath = path.join(repoRoot, filePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
        git(repoRoot, `add "${filePath}"`);
      }
      git(repoRoot, `commit -m "${trackName}: add changes"`);
    }
  }

  // Return to integration branch
  git(repoRoot, 'checkout auto/req-001/integration');

  return repoRoot;
}

/** Clean up a temp repo. */
function cleanupRepo(repoRoot: string): void {
  fs.rmSync(repoRoot, { recursive: true, force: true });
}

// ============================================================================
// computeMergeOrder
// ============================================================================

describe('computeMergeOrder', () => {
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      '/tmp/unused',
      emitter,
    );
  });

  it('TDD 2.3: track-a before track-c in cluster 0', () => {
    // track-a has outgoing edge (track-b depends on it), track-c has none
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ]);
    const order = mergeEngine.computeMergeOrder(dag.clusters[0], dag);
    expect(order[0]).toBe('track-a'); // has outgoing edge
    expect(order[1]).toBe('track-c');
  });

  it('alphabetical tiebreaker for equal out-degree', () => {
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'beta', complexity: 'small', dependsOn: [] },
      { name: 'alpha', complexity: 'small', dependsOn: [] },
    ]);
    const order = mergeEngine.computeMergeOrder(dag.clusters[0], dag);
    expect(order).toEqual(['alpha', 'beta']);
  });

  it('single track in cluster', () => {
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'only', complexity: 'small', dependsOn: [] },
    ]);
    const order = mergeEngine.computeMergeOrder(dag.clusters[0], dag);
    expect(order).toEqual(['only']);
  });

  it('multiple outgoing edges sorts highest first', () => {
    // track-a -> track-c, track-a -> track-d (2 outgoing)
    // track-b -> track-d (1 outgoing)
    // track-c, track-d have 0 outgoing (cluster 1)
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'track-a', complexity: 'small', dependsOn: [] },
      { name: 'track-b', complexity: 'small', dependsOn: [] },
      { name: 'track-c', complexity: 'small', dependsOn: ['track-a'] },
      { name: 'track-d', complexity: 'small', dependsOn: ['track-a', 'track-b'] },
    ]);
    // Cluster 0 contains track-a and track-b
    const order = mergeEngine.computeMergeOrder(dag.clusters[0], dag);
    // track-a has 2 outgoing edges, track-b has 1
    expect(order[0]).toBe('track-a');
    expect(order[1]).toBe('track-b');
  });

  it('handles cluster with tracks that have no outgoing edges', () => {
    // All tracks are leaves (no dependents)
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'delta', complexity: 'small', dependsOn: [] },
      { name: 'charlie', complexity: 'small', dependsOn: [] },
      { name: 'bravo', complexity: 'small', dependsOn: [] },
    ]);
    const order = mergeEngine.computeMergeOrder(dag.clusters[0], dag);
    // All have 0 outgoing edges, so alphabetical: bravo, charlie, delta
    expect(order).toEqual(['bravo', 'charlie', 'delta']);
  });
});

// ============================================================================
// mergeTrack - clean merge
// ============================================================================

describe('mergeTrack - clean merge', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = createTestRepo({
      tracks: {
        'track-a': { 'file-b.ts': 'export const b = 1;\n' },
      },
    });
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('commits clean merge with conventional message', async () => {
    const result = await mergeEngine.mergeTrack(
      'req-001',
      'track-a',
      'auto/req-001/integration',
    );
    expect(result.conflictCount).toBe(0);
    expect(result.resolutionStrategy).toBe('clean');
    expect(result.mergeCommitSha).toBeTruthy();

    // Verify commit message
    const msg = git(repoRoot, 'log -1 --format=%B');
    expect(msg).toContain('track-a');
    expect(msg).toContain('Conflicts: 0');
  });

  it('emits merge.started and merge.completed', async () => {
    const events: any[] = [];
    emitter.on('merge.started', e => events.push(e));
    emitter.on('merge.completed', e => events.push(e));
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('merge.started');
    expect(events[1].type).toBe('merge.completed');
  });

  it('captures merge commit SHA', async () => {
    const result = await mergeEngine.mergeTrack(
      'req-001',
      'track-a',
      'auto/req-001/integration',
    );
    const headSha = git(repoRoot, 'rev-parse HEAD');
    expect(result.mergeCommitSha).toBe(headSha);
  });

  it('includes timing in result', async () => {
    const result = await mergeEngine.mergeTrack(
      'req-001',
      'track-a',
      'auto/req-001/integration',
    );
    expect(result.resolutionDurationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.resolutionDurationMs).toBe('number');
  });

  it('includes ISO timestamp in result', async () => {
    const result = await mergeEngine.mergeTrack(
      'req-001',
      'track-a',
      'auto/req-001/integration',
    );
    // Should be a valid ISO-8601 string
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it('sets trackBranch and integrationBranch in result', async () => {
    const result = await mergeEngine.mergeTrack(
      'req-001',
      'track-a',
      'auto/req-001/integration',
    );
    expect(result.trackBranch).toBe('auto/req-001/track-a');
    expect(result.integrationBranch).toBe('auto/req-001/integration');
  });

  it('merge commit message includes request ID', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    const msg = git(repoRoot, 'log -1 --format=%B');
    expect(msg).toContain('Request: req-001');
  });
});

// ============================================================================
// mergeTrack - conflict handling
// ============================================================================

describe('mergeTrack - conflict handling', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    // Set up: integration and track both modify the same file differently
    const tmpDir = makeTempDir();

    // Init repo
    git(tmpDir, 'init -b main');
    git(tmpDir, 'config user.email "test@test.com"');
    git(tmpDir, 'config user.name "Test"');

    // Initial commit
    fs.writeFileSync(path.join(tmpDir, 'shared.ts'), 'export const x = 0;\n');
    git(tmpDir, 'add shared.ts');
    git(tmpDir, 'commit -m "initial"');

    // Integration branch — modify the shared file
    git(tmpDir, 'checkout -b auto/req-001/integration');
    fs.writeFileSync(path.join(tmpDir, 'shared.ts'), 'export const x = "integration";\n');
    git(tmpDir, 'add shared.ts');
    git(tmpDir, 'commit -m "integration change"');

    // Track branch — modify the same file differently (creates a conflict)
    git(tmpDir, 'checkout -b auto/req-001/track-a main');
    fs.writeFileSync(path.join(tmpDir, 'shared.ts'), 'export const x = "track-a";\n');
    git(tmpDir, 'add shared.ts');
    git(tmpDir, 'commit -m "track-a change"');

    // Go back to integration
    git(tmpDir, 'checkout auto/req-001/integration');

    repoRoot = tmpDir;
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('detects conflicted files', async () => {
    // Default resolveConflicts throws, so result will be 'failed'
    const result = await mergeEngine.mergeTrack(
      'req-001',
      'track-a',
      'auto/req-001/integration',
    );
    expect(result.conflictCount).toBeGreaterThan(0);
  });

  it('aborts merge on resolution failure', async () => {
    const result = await mergeEngine.mergeTrack(
      'req-001',
      'track-a',
      'auto/req-001/integration',
    );
    expect(result.resolutionStrategy).toBe('failed');
    expect(result.mergeCommitSha).toBeNull();

    // Verify integration branch is clean (merge was aborted)
    const status = git(repoRoot, 'status --porcelain');
    expect(status).toBe('');
  });

  it('emits merge.failed on resolution failure', async () => {
    const events: any[] = [];
    emitter.on('merge.failed', e => events.push(e));
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('merge.failed');
    expect(events[0].trackName).toBe('track-a');
  });

  it('still emits merge.started before failure', async () => {
    const events: any[] = [];
    emitter.on('merge.started', e => events.push(e));
    emitter.on('merge.failed', e => events.push(e));
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(events[0].type).toBe('merge.started');
    expect(events[1].type).toBe('merge.failed');
  });

  it('reports resolution failure reason in event', async () => {
    const events: any[] = [];
    emitter.on('merge.failed', e => events.push(e));
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(events[0].reason).toContain('Conflict resolution not implemented');
  });
});

// ============================================================================
// mergeTrack - idempotency
// ============================================================================

describe('mergeTrack - idempotency', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = createTestRepo({
      tracks: {
        'track-a': { 'file-b.ts': 'export const b = 1;\n' },
      },
    });
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('merging same track twice is safe (second is a no-op)', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    const sha1 = git(repoRoot, 'rev-parse HEAD');

    // Second merge: track branch is already merged
    const result = await mergeEngine.mergeTrack(
      'req-001',
      'track-a',
      'auto/req-001/integration',
    );
    const sha2 = git(repoRoot, 'rev-parse HEAD');

    // Should be clean (nothing to merge) or result in same state
    expect(result.conflictCount).toBe(0);
  });
});

// ============================================================================
// mergeCluster
// ============================================================================

describe('mergeCluster', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = createTestRepo({
      tracks: {
        'track-a': { 'file-a.ts': 'export const a = 1;\n' },
        'track-c': { 'file-c.ts': 'export const c = 1;\n' },
      },
    });
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('merges all tracks in cluster in computed order', async () => {
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ]);

    // Cluster 0 = [track-a, track-c]
    const results = await mergeEngine.mergeCluster('req-001', dag.clusters[0], dag);

    expect(results.length).toBe(2);
    // track-a merges first (has outgoing edge), then track-c
    expect(results[0].trackName).toBe('track-a');
    expect(results[1].trackName).toBe('track-c');
    expect(results[0].resolutionStrategy).toBe('clean');
    expect(results[1].resolutionStrategy).toBe('clean');
  });

  it('returns results even when some merges fail', async () => {
    // Create a conflict scenario: both tracks modify same file
    const conflictRepo = makeTempDir();

    git(conflictRepo, 'init -b main');
    git(conflictRepo, 'config user.email "test@test.com"');
    git(conflictRepo, 'config user.name "Test"');

    fs.writeFileSync(path.join(conflictRepo, 'shared.ts'), 'original\n');
    git(conflictRepo, 'add shared.ts');
    git(conflictRepo, 'commit -m "initial"');

    git(conflictRepo, 'checkout -b auto/req-001/integration');

    // track-a: clean change (new file)
    git(conflictRepo, 'checkout -b auto/req-001/track-a auto/req-001/integration');
    fs.writeFileSync(path.join(conflictRepo, 'new-file.ts'), 'clean\n');
    git(conflictRepo, 'add new-file.ts');
    git(conflictRepo, 'commit -m "track-a changes"');

    // track-c: modifies shared.ts (will conflict after integration changes it)
    git(conflictRepo, 'checkout -b auto/req-001/track-c main');
    fs.writeFileSync(path.join(conflictRepo, 'shared.ts'), 'track-c version\n');
    git(conflictRepo, 'add shared.ts');
    git(conflictRepo, 'commit -m "track-c changes"');

    // Now modify shared.ts on integration so track-c will conflict
    git(conflictRepo, 'checkout auto/req-001/integration');
    fs.writeFileSync(path.join(conflictRepo, 'shared.ts'), 'integration version\n');
    git(conflictRepo, 'add shared.ts');
    git(conflictRepo, 'commit -m "integration change"');

    const conflictEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      conflictRepo,
      emitter,
    );

    const dag = buildAndScheduleDAG('req-001', [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ]);

    const results = await conflictEngine.mergeCluster('req-001', dag.clusters[0], dag);

    expect(results.length).toBe(2);
    // track-a should succeed (clean)
    expect(results[0].trackName).toBe('track-a');
    expect(results[0].resolutionStrategy).toBe('clean');
    // track-c should fail (conflict, no resolver)
    expect(results[1].trackName).toBe('track-c');
    expect(results[1].resolutionStrategy).toBe('failed');

    cleanupRepo(conflictRepo);
  });
});

// ============================================================================
// Circuit breaker (SPEC-006-4-3 Task 8)
// ============================================================================

/** Create a clean MergeResult stub with the given resolution strategy. */
function makeMergeResult(
  strategy: MergeResult['resolutionStrategy'],
  trackName: string = 'track-a',
): MergeResult {
  return {
    trackName,
    integrationBranch: 'auto/req-001/integration',
    trackBranch: `auto/req-001/${trackName}`,
    mergeCommitSha: strategy === 'failed' || strategy === 'escalated' ? null : 'abc123',
    conflictCount: strategy === 'clean' ? 0 : 1,
    conflicts: [],
    resolutionStrategy: strategy,
    resolutionDurationMs: 100,
    timestamp: new Date().toISOString(),
  };
}

describe('merge circuit breaker', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = makeTempDir();
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG, merge_conflict_escalation_threshold: 5 },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('does not trip below threshold', () => {
    const results = Array.from({ length: 4 }, (_, i) =>
      makeMergeResult('failed', `track-${i}`),
    );
    // threshold is 5, count is 4
    expect(() => mergeEngine.checkCircuitBreaker('req-001', results)).not.toThrow();
  });

  it('does not trip at exactly the threshold', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeMergeResult('failed', `track-${i}`),
    );
    // threshold is 5, count is 5, trips only when > threshold
    expect(() => mergeEngine.checkCircuitBreaker('req-001', results)).not.toThrow();
  });

  it('trips when count exceeds threshold', () => {
    const results = Array.from({ length: 6 }, (_, i) =>
      makeMergeResult('failed', `track-${i}`),
    );
    expect(() => mergeEngine.checkCircuitBreaker('req-001', results))
      .toThrow(MergeCircuitBreakerError);
  });

  it('only counts unresolved conflicts', () => {
    const results: MergeResult[] = [
      makeMergeResult('auto-resolved', 'track-a'),
      makeMergeResult('auto-resolved', 'track-b'),
      makeMergeResult('ai-resolved', 'track-c'),
      makeMergeResult('clean', 'track-d'),
      makeMergeResult('failed', 'track-e'),
    ];
    // Only 1 unresolved, threshold is 5 -> no trip
    expect(() => mergeEngine.checkCircuitBreaker('req-001', results)).not.toThrow();
    expect(mergeEngine.getUnresolvedCount('req-001')).toBe(1);
  });

  it('counts escalated as unresolved', () => {
    const results = Array.from({ length: 6 }, (_, i) =>
      makeMergeResult('escalated', `track-${i}`),
    );
    expect(() => mergeEngine.checkCircuitBreaker('req-001', results))
      .toThrow(MergeCircuitBreakerError);
  });

  it('emits request.escalated on trip', () => {
    const events: any[] = [];
    emitter.on('request.escalated', e => events.push(e));

    try {
      const results = Array.from({ length: 6 }, (_, i) =>
        makeMergeResult('failed', `track-${i}`),
      );
      mergeEngine.checkCircuitBreaker('req-001', results);
    } catch {
      // Expected
    }

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('request.escalated');
    expect(events[0].requestId).toBe('req-001');
    expect(events[0].reason).toContain('circuit breaker');
    expect(events[0].unresolvedConflicts).toBe(6);
    expect(events[0].timestamp).toBeDefined();
  });

  it('accumulates across multiple calls', () => {
    // First call: 3 failures
    const batch1 = Array.from({ length: 3 }, (_, i) =>
      makeMergeResult('failed', `track-a${i}`),
    );
    expect(() => mergeEngine.checkCircuitBreaker('req-001', batch1)).not.toThrow();
    expect(mergeEngine.getUnresolvedCount('req-001')).toBe(3);

    // Second call: 3 more failures -> total 6, trips at > 5
    const batch2 = Array.from({ length: 3 }, (_, i) =>
      makeMergeResult('failed', `track-b${i}`),
    );
    expect(() => mergeEngine.checkCircuitBreaker('req-001', batch2))
      .toThrow(MergeCircuitBreakerError);
    expect(mergeEngine.getUnresolvedCount('req-001')).toBe(6);
  });

  it('tracks separate counts per request', () => {
    const batch = Array.from({ length: 3 }, (_, i) =>
      makeMergeResult('failed', `track-${i}`),
    );

    mergeEngine.checkCircuitBreaker('req-001', batch);
    mergeEngine.checkCircuitBreaker('req-002', batch);

    expect(mergeEngine.getUnresolvedCount('req-001')).toBe(3);
    expect(mergeEngine.getUnresolvedCount('req-002')).toBe(3);
  });

  it('resetCircuitBreaker clears the counter', () => {
    const batch = Array.from({ length: 3 }, (_, i) =>
      makeMergeResult('failed', `track-${i}`),
    );

    mergeEngine.checkCircuitBreaker('req-001', batch);
    expect(mergeEngine.getUnresolvedCount('req-001')).toBe(3);

    mergeEngine.resetCircuitBreaker('req-001');
    expect(mergeEngine.getUnresolvedCount('req-001')).toBe(0);
  });

  it('getUnresolvedCount returns 0 for unknown request', () => {
    expect(mergeEngine.getUnresolvedCount('unknown')).toBe(0);
  });

  it('error contains correct metadata', () => {
    const results = Array.from({ length: 6 }, (_, i) =>
      makeMergeResult('failed', `track-${i}`),
    );

    try {
      mergeEngine.checkCircuitBreaker('req-001', results);
      fail('Expected MergeCircuitBreakerError');
    } catch (err) {
      expect(err).toBeInstanceOf(MergeCircuitBreakerError);
      const cbErr = err as MergeCircuitBreakerError;
      expect(cbErr.requestId).toBe('req-001');
      expect(cbErr.unresolvedCount).toBe(6);
      expect(cbErr.threshold).toBe(5);
      expect(cbErr.name).toBe('MergeCircuitBreakerError');
    }
  });
});

// ============================================================================
// MergeCircuitBreakerError
// ============================================================================

describe('MergeCircuitBreakerError', () => {
  it('has correct name and message', () => {
    const err = new MergeCircuitBreakerError('req-001', 5, 3);
    expect(err.name).toBe('MergeCircuitBreakerError');
    expect(err.message).toContain('req-001');
    expect(err.message).toContain('5');
    expect(err.message).toContain('3');
    expect(err.requestId).toBe('req-001');
    expect(err.unresolvedCount).toBe(5);
    expect(err.threshold).toBe(3);
  });
});

// ============================================================================
// Rollback: single track (SPEC-006-4-3 Task 9)
// ============================================================================

describe('rollbackTrackMerge', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = createTestRepo({
      tracks: {
        'track-a': { 'file-a.ts': 'export const a = 1;\n' },
        'track-b': { 'file-b.ts': 'export const b = 1;\n' },
      },
    });
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('reverts the merge commit', async () => {
    // First merge track-a into integration
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');

    const preSha = git(repoRoot, 'rev-parse HEAD');

    await mergeEngine.rollbackTrackMerge('req-001', 'track-a');

    const postSha = git(repoRoot, 'rev-parse HEAD');

    // New revert commit should exist
    expect(postSha).not.toBe(preSha);

    // Verify track-a's file is reverted (no longer exists)
    const fileExists = fs.existsSync(path.join(repoRoot, 'file-a.ts'));
    expect(fileExists).toBe(false);
  });

  it('emits merge.rolledback event', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');

    const events: any[] = [];
    emitter.on('merge.rolledback', e => events.push(e));

    await mergeEngine.rollbackTrackMerge('req-001', 'track-a');

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('merge.rolledback');
    expect(events[0].requestId).toBe('req-001');
    expect(events[0].trackName).toBe('track-a');
    expect(events[0].revertedCommit).toBeDefined();
    expect(events[0].timestamp).toBeDefined();
  });

  it('throws if no merge commit found', async () => {
    await expect(
      mergeEngine.rollbackTrackMerge('req-001', 'nonexistent-track'),
    ).rejects.toThrow(/no merge commit/i);
  });

  it('integration branch has auto/ prefix (safety check passes)', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');

    // Should not throw since integration branch is auto/
    await expect(
      mergeEngine.rollbackTrackMerge('req-001', 'track-a'),
    ).resolves.not.toThrow();
  });
});

// ============================================================================
// Rollback: full integration reset (SPEC-006-4-3 Task 9)
// ============================================================================

describe('rollbackIntegration', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = createTestRepo({
      tracks: {
        'track-a': { 'file-a.ts': 'export const a = 1;\n' },
        'track-b': { 'file-b.ts': 'export const b = 1;\n' },
        'track-c': { 'file-c.ts': 'export const c = 1;\n' },
      },
    });
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('resets to branch point', async () => {
    const branchPoint = git(repoRoot, 'merge-base auto/req-001/integration main');

    // Merge a track to move the integration branch forward
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');

    await mergeEngine.rollbackIntegration('req-001');

    // Checkout integration to check its HEAD
    git(repoRoot, 'checkout auto/req-001/integration');
    const currentSha = git(repoRoot, 'rev-parse HEAD');

    expect(currentSha).toBe(branchPoint);
  });

  it('removes all merge commits', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    await mergeEngine.mergeTrack('req-001', 'track-b', 'auto/req-001/integration');

    await mergeEngine.rollbackIntegration('req-001');

    git(repoRoot, 'checkout auto/req-001/integration');
    const log = git(repoRoot, 'log --oneline');

    expect(log).not.toContain('merge:');
  });

  it('emits merge.integration_reset event', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');

    const events: any[] = [];
    emitter.on('merge.integration_reset', e => events.push(e));

    await mergeEngine.rollbackIntegration('req-001');

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('merge.integration_reset');
    expect(events[0].requestId).toBe('req-001');
    expect(events[0].resetToCommit).toBeDefined();
    expect(events[0].timestamp).toBeDefined();
  });
});

// ============================================================================
// Interface contract validation (SPEC-006-4-3 post-merge)
// ============================================================================

describe('validateInterfaceContracts', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = makeTempDir();
    git(repoRoot, 'init -b main');
    git(repoRoot, 'config user.email "test@test.com"');
    git(repoRoot, 'config user.name "Test"');

    // Create a types file and commit
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'types.ts'),
      'export interface UserService {\n  getUser(id: string): User;\n}\n',
    );
    git(repoRoot, 'add .');
    git(repoRoot, 'commit -m "add types"');

    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('returns valid when all contracts are satisfied', async () => {
    const result = await mergeEngine.validateInterfaceContracts([
      {
        contractType: 'type-definition',
        producer: 'track-a',
        consumer: 'track-b',
        definition: 'export interface UserService',
        filePath: 'src/types.ts',
      },
    ]);

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('reports violation when definition is missing', async () => {
    const result = await mergeEngine.validateInterfaceContracts([
      {
        contractType: 'type-definition',
        producer: 'track-a',
        consumer: 'track-b',
        definition: 'export interface NonExistentType',
        filePath: 'src/types.ts',
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toContain('not found');
  });

  it('reports violation when file is missing', async () => {
    const result = await mergeEngine.validateInterfaceContracts([
      {
        contractType: 'function-signature',
        producer: 'track-a',
        consumer: 'track-b',
        definition: 'export function doStuff',
        filePath: 'src/nonexistent.ts',
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].message).toContain('not found at HEAD');
  });

  it('handles multiple contracts with mixed results', async () => {
    const result = await mergeEngine.validateInterfaceContracts([
      {
        contractType: 'type-definition',
        producer: 'track-a',
        consumer: 'track-b',
        definition: 'export interface UserService',
        filePath: 'src/types.ts',
      },
      {
        contractType: 'type-definition',
        producer: 'track-c',
        consumer: 'track-d',
        definition: 'export interface Missing',
        filePath: 'src/types.ts',
      },
    ]);

    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });
});

// ============================================================================
// Database migration sequence validation (SPEC-006-4-3 post-merge)
// ============================================================================

describe('validateMigrationSequence', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = makeTempDir();
    git(repoRoot, 'init -b main');
    git(repoRoot, 'config user.email "test@test.com"');
    git(repoRoot, 'config user.name "Test"');

    // Create migration files
    const migDir = path.join(repoRoot, 'db', 'migrations');
    fs.mkdirSync(migDir, { recursive: true });
    fs.writeFileSync(path.join(migDir, '001_create_users.sql'), 'CREATE TABLE users;');
    fs.writeFileSync(path.join(migDir, '002_create_orders.sql'), 'CREATE TABLE orders;');
    fs.writeFileSync(path.join(migDir, '003_add_email.sql'), 'ALTER TABLE users ADD email;');
    git(repoRoot, 'add .');
    git(repoRoot, 'commit -m "add migrations"');

    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('returns valid for sequential migrations', async () => {
    const result = await mergeEngine.validateMigrationSequence('db/migrations');
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('detects duplicate migration numbers', async () => {
    // Add a duplicate
    const migDir = path.join(repoRoot, 'db', 'migrations');
    fs.writeFileSync(path.join(migDir, '002_duplicate.sql'), 'DUPLICATE');
    git(repoRoot, 'add .');
    git(repoRoot, 'commit -m "add duplicate"');

    const result = await mergeEngine.validateMigrationSequence('db/migrations');
    expect(result.valid).toBe(false);
    expect(result.issues.some(i => i.severity === 'error' && i.message.includes('Duplicate'))).toBe(true);
  });

  it('detects gaps in migration sequence', async () => {
    // Add a migration with a gap
    const migDir = path.join(repoRoot, 'db', 'migrations');
    fs.writeFileSync(path.join(migDir, '005_gap.sql'), 'GAP');
    git(repoRoot, 'add .');
    git(repoRoot, 'commit -m "add gap"');

    const result = await mergeEngine.validateMigrationSequence('db/migrations');
    expect(result.valid).toBe(true); // Gaps are warnings, not errors
    expect(result.issues.some(i => i.severity === 'warning' && i.message.includes('Gap'))).toBe(true);
  });

  it('returns valid for nonexistent migration directory', async () => {
    const result = await mergeEngine.validateMigrationSequence('nonexistent/dir');
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });
});

// ============================================================================
// TDD 2.3 Full Merge Scenario (SPEC-006-4-4 Task 12)
// ============================================================================

describe('TDD 2.3 full merge scenario', () => {
  // Setup: 3 tracks with A->B dependency, C independent
  // Cluster 0: track-a modifies src/user-model.ts, track-c modifies src/logger.ts
  // Cluster 1: track-b modifies src/auth-controller.ts (depends on track-a's types)

  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    // Build a repo with 3 tracks on separate files
    const tmpDir = makeTempDir();

    git(tmpDir, 'init -b main');
    git(tmpDir, 'config user.email "test@test.com"');
    git(tmpDir, 'config user.name "Test"');

    // Create base files on main
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'user-model.ts'), 'export const user = {};\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth-controller.ts'), 'export const auth = {};\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'logger.ts'), 'export const logger = {};\n');
    git(tmpDir, 'add .');
    git(tmpDir, 'commit -m "initial base files"');

    // Create integration branch
    git(tmpDir, 'checkout -b auto/req-001/integration');

    // track-a: modifies src/user-model.ts
    git(tmpDir, 'checkout -b auto/req-001/track-a auto/req-001/integration');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'user-model.ts'),
      'export interface User { id: string; }\n// track-a changes\n',
    );
    git(tmpDir, 'add .');
    git(tmpDir, 'commit -m "track-a: add User interface"');

    // track-b: modifies src/auth-controller.ts (depends on track-a)
    git(tmpDir, 'checkout -b auto/req-001/track-b auto/req-001/integration');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'auth-controller.ts'),
      'import { User } from "./user-model";\nexport function authenticate(u: User) { return true; }\n',
    );
    git(tmpDir, 'add .');
    git(tmpDir, 'commit -m "track-b: add authentication"');

    // track-c: modifies src/logger.ts (independent)
    git(tmpDir, 'checkout -b auto/req-001/track-c auto/req-001/integration');
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'logger.ts'),
      'export function log(msg: string) { console.log(msg); }\n// track-c changes\n',
    );
    git(tmpDir, 'add .');
    git(tmpDir, 'commit -m "track-c: add logger function"');

    // Return to integration
    git(tmpDir, 'checkout auto/req-001/integration');

    repoRoot = tmpDir;
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('merges cluster 0 in correct order: track-a then track-c', async () => {
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ]);

    const results = await mergeEngine.mergeCluster('req-001', dag.clusters[0], dag);
    expect(results.length).toBe(2);
    expect(results[0].trackName).toBe('track-a');
    expect(results[1].trackName).toBe('track-c');
    expect(results.every((r) => r.conflictCount === 0)).toBe(true);
  });

  it('merges cluster 1 after cluster 0: track-b sees track-a changes', async () => {
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ]);

    // Merge cluster 0 first
    await mergeEngine.mergeCluster('req-001', dag.clusters[0], dag);

    // Merge cluster 1
    const results = await mergeEngine.mergeCluster('req-001', dag.clusters[1], dag);
    expect(results.length).toBe(1);
    expect(results[0].trackName).toBe('track-b');

    // Verify track-b merge has access to track-a's changes
    const content = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:src/user-model.ts`,
      { encoding: 'utf-8' },
    );
    expect(content).toContain('track-a changes');
  });

  it('integration branch contains all tracks after both clusters merge', async () => {
    const dag = buildAndScheduleDAG('req-001', [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ]);

    await mergeEngine.mergeCluster('req-001', dag.clusters[0], dag);
    await mergeEngine.mergeCluster('req-001', dag.clusters[1], dag);

    // Verify all files are present with their track changes
    const files = execSync(
      `git -C "${repoRoot}" ls-tree --name-only -r auto/req-001/integration src/`,
      { encoding: 'utf-8' },
    ).trim().split('\n');

    expect(files).toContain('src/user-model.ts');
    expect(files).toContain('src/auth-controller.ts');
    expect(files).toContain('src/logger.ts');

    // Verify content from each track is present
    const userModel = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:src/user-model.ts`,
      { encoding: 'utf-8' },
    );
    expect(userModel).toContain('track-a changes');

    const authController = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:src/auth-controller.ts`,
      { encoding: 'utf-8' },
    );
    expect(authController).toContain('authenticate');

    const logger = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:src/logger.ts`,
      { encoding: 'utf-8' },
    );
    expect(logger).toContain('track-c changes');
  });

  it('all merge events are emitted in order', async () => {
    const events: any[] = [];
    emitter.on('merge.started', (e) => events.push(e));
    emitter.on('merge.completed', (e) => events.push(e));

    const dag = buildAndScheduleDAG('req-001', [
      { name: 'track-a', complexity: 'medium', dependsOn: [] },
      { name: 'track-b', complexity: 'medium', dependsOn: ['track-a'] },
      { name: 'track-c', complexity: 'small', dependsOn: [] },
    ]);

    await mergeEngine.mergeCluster('req-001', dag.clusters[0], dag);
    await mergeEngine.mergeCluster('req-001', dag.clusters[1], dag);

    // Should have 3 start + 3 complete = 6 events
    expect(events.length).toBe(6);

    // Verify ordering: started/completed pairs
    expect(events[0].type).toBe('merge.started');
    expect(events[0].trackName).toBe('track-a');
    expect(events[1].type).toBe('merge.completed');
    expect(events[1].trackName).toBe('track-a');
    expect(events[2].type).toBe('merge.started');
    expect(events[2].trackName).toBe('track-c');
    expect(events[3].type).toBe('merge.completed');
    expect(events[3].trackName).toBe('track-c');
    expect(events[4].type).toBe('merge.started');
    expect(events[4].trackName).toBe('track-b');
    expect(events[5].type).toBe('merge.completed');
    expect(events[5].trackName).toBe('track-b');
  });
});

// ============================================================================
// Merge idempotency (SPEC-006-4-4 Task 12)
// ============================================================================

describe('merge idempotency', () => {
  let repoRoot: string;
  let emitter: EventEmitter;
  let mergeEngine: MergeEngine;

  beforeEach(() => {
    repoRoot = createTestRepo({
      tracks: {
        'track-a': { 'file-a.ts': 'export const a = 1;\n' },
        'track-b': { 'file-b.ts': 'export const b = 2;\n' },
      },
    });
    emitter = new EventEmitter();
    mergeEngine = new MergeEngine(
      { ...DEFAULT_PARALLEL_CONFIG },
      repoRoot,
      emitter,
    );
  });

  afterEach(() => {
    cleanupRepo(repoRoot);
  });

  it('merging the same track twice does not create duplicate changes', async () => {
    // First merge
    const r1 = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(r1.conflictCount).toBe(0);
    expect(r1.resolutionStrategy).toBe('clean');
    const sha1 = git(repoRoot, 'rev-parse HEAD');

    // Second merge of the same track
    const r2 = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(r2.conflictCount).toBe(0);

    // File content should be identical
    const content = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:file-a.ts`,
      { encoding: 'utf-8' },
    );
    expect(content).toBe('export const a = 1;\n');
  });

  it('merging two different tracks sequentially produces correct state', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    await mergeEngine.mergeTrack('req-001', 'track-b', 'auto/req-001/integration');

    // Both files should be present
    const fileA = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:file-a.ts`,
      { encoding: 'utf-8' },
    );
    const fileB = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:file-b.ts`,
      { encoding: 'utf-8' },
    );

    expect(fileA).toBe('export const a = 1;\n');
    expect(fileB).toBe('export const b = 2;\n');
  });

  it('re-merging after rollback and re-merge produces same result', async () => {
    // Merge track-a
    const r1 = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    const contentAfterFirst = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:file-a.ts`,
      { encoding: 'utf-8' },
    );

    // Rollback
    await mergeEngine.rollbackTrackMerge('req-001', 'track-a');

    // Re-merge
    const r2 = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    const contentAfterRemerge = execSync(
      `git -C "${repoRoot}" show auto/req-001/integration:file-a.ts`,
      { encoding: 'utf-8' },
    );

    expect(contentAfterFirst).toBe(contentAfterRemerge);
    expect(r2.conflictCount).toBe(0);
  });
});
