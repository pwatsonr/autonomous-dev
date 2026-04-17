# SPEC-006-4-1: Merge Types, Ordering Logic, and Core Merge Sequence

## Metadata
- **Parent Plan**: PLAN-006-4
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 9 hours

## Description

Define the `MergeResult`, `ConflictDetail`, `ConflictRecord`, and conflict type enums. Implement the merge ordering logic that determines the correct DAG-topological merge sequence within a cluster, and the core merge function that executes `git merge --no-commit --no-ff` with pre-commit inspection and abort-on-failure safety.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/types.ts` | **Modify** | Add merge-related types |
| `src/parallel/merge-engine.ts` | **Create** | Merge ordering, core merge sequence, result tracking |
| `tests/parallel/merge-engine.test.ts` | **Create** | Merge ordering and clean/conflict merge tests |

## Implementation Details

### 1. Merge type definitions (`src/parallel/types.ts`)

```typescript
export interface MergeResult {
  trackName: string;
  integrationBranch: string;
  trackBranch: string;
  mergeCommitSha: string | null;   // null if merge failed
  conflictCount: number;
  conflicts: ConflictDetail[];
  resolutionStrategy: 'clean' | 'auto-resolved' | 'ai-resolved' | 'escalated' | 'failed';
  resolutionDurationMs: number;
  timestamp: string;
}

export interface ConflictDetail {
  file: string;
  conflictType: ConflictType;
  resolution: 'auto' | 'ai' | 'human' | 'unresolved';
  confidence: number;          // 0.0 - 1.0
  resolvedContent?: string;    // the final merged content (for audit)
}

export enum ConflictType {
  Disjoint = 'disjoint',
  NonOverlapping = 'non-overlapping',
  OverlappingCompatible = 'overlapping-compatible',
  OverlappingConflicting = 'overlapping-conflicting',
  Structural = 'structural',
}

export interface ConflictRecord {
  id: string;                    // unique identifier
  requestId: string;
  file: string;
  trackA: string;                // the integration branch side
  trackB: string;                // the track being merged
  conflictType: ConflictType;
  resolutionStrategy: 'auto' | 'ai' | 'human';
  aiConfidence: number | null;
  resolution: string;            // the resolved content or description
  integrationTestsPassed: boolean | null;  // populated after integration tests
  timestamp: string;
}

export interface ConflictResolutionRequest {
  file: string;
  requestId: string;
  trackA: string;
  trackB: string;
  baseContent: string;     // git stage 1 (common ancestor)
  oursContent: string;     // git stage 2 (integration branch)
  theirsContent: string;   // git stage 3 (track branch)
  specA: string;           // spec for trackA
  specB: string;           // spec for trackB
  interfaceContracts: InterfaceContract[];
}

export interface ConflictResolutionResult {
  resolvedContent: string;
  confidence: number;
  reasoning: string;
  strategy: 'auto' | 'ai' | 'human';
}
```

### 2. Merge ordering logic

```typescript
export class MergeEngine {
  constructor(
    private config: ParallelConfig,
    private repoRoot: string,
    private eventEmitter: EventEmitter
  ) {}

  /**
   * Determine the merge order for tracks within a cluster.
   * Per TDD 3.5.1: nodes with outgoing edges (dependents waiting) merge first.
   * Alphabetical tiebreaker for determinism.
   */
  computeMergeOrder(cluster: DAGCluster, dag: DependencyDAG): string[] {
    const trackNames = [...cluster.nodes];

    // Count outgoing edges from each track (using reduced edges)
    const outDegree = new Map<string, number>();
    for (const name of trackNames) {
      outDegree.set(name, 0);
    }
    for (const edge of dag.reducedEdges) {
      if (trackNames.includes(edge.from)) {
        outDegree.set(edge.from, (outDegree.get(edge.from) ?? 0) + 1);
      }
    }

    // Sort: highest out-degree first, then alphabetical
    return trackNames.sort((a, b) => {
      const degDiff = (outDegree.get(b) ?? 0) - (outDegree.get(a) ?? 0);
      if (degDiff !== 0) return degDiff;
      return a.localeCompare(b);
    });
  }
}
```

### 3. Core merge sequence

```typescript
  /**
   * Merge a single track branch into the integration branch.
   * Uses --no-commit --no-ff for inspection before finalizing.
   * Calls git merge --abort on any failure.
   */
  async mergeTrack(
    requestId: string,
    trackName: string,
    integrationBranch: string
  ): Promise<MergeResult> {
    const startTime = Date.now();
    const trackBranch = trackBranchName(requestId, trackName);

    this.eventEmitter.emit('merge.started', {
      type: 'merge.started',
      requestId,
      trackName,
      integrationBranch,
      trackBranch,
      timestamp: new Date().toISOString(),
    });

    // Step 1: Checkout integration branch
    this.exec(`git -C "${this.repoRoot}" checkout ${integrationBranch}`);

    // Step 2: Attempt merge with --no-commit --no-ff
    let mergeExitCode: number;
    try {
      this.exec(`git -C "${this.repoRoot}" merge --no-commit --no-ff ${trackBranch}`);
      mergeExitCode = 0;
    } catch (err) {
      // Non-zero exit code means conflicts
      mergeExitCode = 1;
    }

    // Step 3: Check for conflicting files
    let conflictedFiles: string[] = [];
    if (mergeExitCode !== 0) {
      const output = this.exec(
        `git -C "${this.repoRoot}" diff --name-only --diff-filter=U`
      );
      conflictedFiles = output.trim().split('\n').filter(Boolean);
    }

    if (conflictedFiles.length === 0) {
      // Clean merge -- commit it
      const commitMsg = [
        `merge: ${trackName} into ${integrationBranch}`,
        '',
        `Request: ${requestId}`,
        `Track: ${trackName}`,
        `Conflicts: 0`,
      ].join('\n');

      this.exec(`git -C "${this.repoRoot}" commit -m "${this.escapeGitMsg(commitMsg)}"`);
      const sha = this.exec(`git -C "${this.repoRoot}" rev-parse HEAD`).trim();

      const result: MergeResult = {
        trackName,
        integrationBranch,
        trackBranch,
        mergeCommitSha: sha,
        conflictCount: 0,
        conflicts: [],
        resolutionStrategy: 'clean',
        resolutionDurationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };

      this.eventEmitter.emit('merge.completed', {
        type: 'merge.completed',
        ...result,
      });

      return result;
    }

    // Conflicts detected -- delegate to conflict resolution pipeline
    try {
      const conflicts = await this.resolveConflicts(requestId, trackName, conflictedFiles);
      
      // All conflicts resolved -- commit
      const commitMsg = [
        `merge: ${trackName} into ${integrationBranch}`,
        '',
        `Request: ${requestId}`,
        `Track: ${trackName}`,
        `Conflicts: ${conflicts.length}`,
        `Resolutions: ${conflicts.map(c => `${c.file}:${c.resolution}`).join(', ')}`,
      ].join('\n');

      this.exec(`git -C "${this.repoRoot}" commit -m "${this.escapeGitMsg(commitMsg)}"`);
      const sha = this.exec(`git -C "${this.repoRoot}" rev-parse HEAD`).trim();

      return {
        trackName,
        integrationBranch,
        trackBranch,
        mergeCommitSha: sha,
        conflictCount: conflicts.length,
        conflicts,
        resolutionStrategy: conflicts.some(c => c.resolution === 'ai') ? 'ai-resolved' : 'auto-resolved',
        resolutionDurationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    } catch (resolutionErr) {
      // Resolution failed -- abort the merge
      this.exec(`git -C "${this.repoRoot}" merge --abort`);

      this.eventEmitter.emit('merge.failed', {
        type: 'merge.failed',
        requestId,
        trackName,
        reason: String(resolutionErr),
        timestamp: new Date().toISOString(),
      });

      return {
        trackName,
        integrationBranch,
        trackBranch,
        mergeCommitSha: null,
        conflictCount: conflictedFiles.length,
        conflicts: [],
        resolutionStrategy: 'failed',
        resolutionDurationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };
    }
  }

  private exec(cmd: string): string {
    return execSync(cmd, { encoding: 'utf-8' });
  }

  private escapeGitMsg(msg: string): string {
    return msg.replace(/"/g, '\\"');
  }
```

### 4. Merge all tracks in a cluster

```typescript
  async mergeCluster(
    requestId: string,
    cluster: DAGCluster,
    dag: DependencyDAG
  ): Promise<MergeResult[]> {
    const integrationBranch = integrationBranchName(requestId);
    const mergeOrder = this.computeMergeOrder(cluster, dag);
    const results: MergeResult[] = [];

    for (const trackName of mergeOrder) {
      const result = await this.mergeTrack(requestId, trackName, integrationBranch);
      results.push(result);

      if (result.resolutionStrategy === 'failed' || result.resolutionStrategy === 'escalated') {
        // Check circuit breaker
        this.checkCircuitBreaker(requestId, results);
      }
    }

    return results;
  }
```

## Acceptance Criteria

1. `MergeResult`, `ConflictDetail`, `ConflictRecord`, `ConflictResolutionRequest/Result` match TDD types.
2. `ConflictType` enum covers all five types: disjoint, non-overlapping, overlapping-compatible, overlapping-conflicting, structural.
3. `computeMergeOrder` merges nodes with highest out-degree first; alphabetical tiebreaker.
4. For TDD 2.3: cluster 0 merges track-a before track-c (track-a has outgoing edge to track-b).
5. `mergeTrack` uses `git merge --no-commit --no-ff` and inspects before committing.
6. Clean merge (no conflicts): commits with conventional message including track name, request ID, conflict count 0.
7. Conflicted merge delegates to resolution pipeline (SPEC-006-4-2).
8. Failed resolution calls `git merge --abort` to restore integration branch.
9. `merge.started`, `merge.completed`, `merge.failed` events emitted at appropriate times.
10. `MergeResult` includes timing (`resolutionDurationMs`) and full conflict details.
11. Merge commit SHA captured and returned in result.
12. `mergeCluster` processes tracks in computed order, collecting results.

## Test Cases

```
// merge-engine.test.ts
// All tests use real temp git repos with branches

describe('computeMergeOrder', () => {
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
});

describe('mergeTrack - clean merge', () => {
  beforeEach(async () => {
    // Set up: repo with integration branch, track branch with non-overlapping changes
    // integration: has file-a.ts
    // track-a: modified file-b.ts (new file, no conflict)
  });

  it('commits clean merge with conventional message', async () => {
    const result = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(result.conflictCount).toBe(0);
    expect(result.resolutionStrategy).toBe('clean');
    expect(result.mergeCommitSha).toBeTruthy();
    
    // Verify commit message
    const msg = execSync(`git -C "${repoRoot}" log -1 --format=%B`).toString().trim();
    expect(msg).toContain('track-a');
    expect(msg).toContain('Conflicts: 0');
  });

  it('emits merge.started and merge.completed', async () => {
    const events: any[] = [];
    emitter.on('merge.started', e => events.push(e));
    emitter.on('merge.completed', e => events.push(e));
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(events[0].type).toBe('merge.started');
    expect(events[1].type).toBe('merge.completed');
  });

  it('captures merge commit SHA', async () => {
    const result = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    const headSha = execSync(`git -C "${repoRoot}" rev-parse HEAD`).toString().trim();
    expect(result.mergeCommitSha).toBe(headSha);
  });
});

describe('mergeTrack - conflict handling', () => {
  beforeEach(async () => {
    // Set up: integration and track both modify the same file differently
    // This creates a genuine git merge conflict
  });

  it('detects conflicted files', async () => {
    // Mock resolveConflicts to track what's passed
    const result = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(result.conflictCount).toBeGreaterThan(0);
  });

  it('aborts merge on resolution failure', async () => {
    // Make resolution throw
    mergeEngine['resolveConflicts'] = async () => { throw new Error('cannot resolve'); };
    const result = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(result.resolutionStrategy).toBe('failed');
    expect(result.mergeCommitSha).toBeNull();
    
    // Verify integration branch is clean (merge was aborted)
    const status = execSync(`git -C "${repoRoot}" status --porcelain`).toString().trim();
    expect(status).toBe('');
  });

  it('emits merge.failed on resolution failure', async () => {
    mergeEngine['resolveConflicts'] = async () => { throw new Error('cannot resolve'); };
    const events: any[] = [];
    emitter.on('merge.failed', e => events.push(e));
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    expect(events.length).toBe(1);
  });
});

describe('mergeTrack - idempotency', () => {
  it('merging same track twice is safe (second is a no-op)', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    const sha1 = execSync(`git -C "${repoRoot}" rev-parse HEAD`).toString().trim();

    // Second merge: track branch is already merged
    const result = await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    const sha2 = execSync(`git -C "${repoRoot}" rev-parse HEAD`).toString().trim();
    
    // Should be clean (nothing to merge) or result in same state
    expect(result.conflictCount).toBe(0);
  });
});
```
