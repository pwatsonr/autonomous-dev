# SPEC-006-4-3: Human Escalation, Merge Circuit Breaker, and Rollback

## Metadata
- **Parent Plan**: PLAN-006-4
- **Tasks Covered**: Task 7, Task 8, Task 9
- **Estimated effort**: 8 hours

## Description

Implement human escalation report generation for conflicts that cannot be auto- or AI-resolved, the merge circuit breaker that halts merging when unresolved conflict count exceeds the configured threshold, and rollback procedures for reverting single track merges or resetting the entire integration branch.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/conflict-resolver.ts` | **Modify** | Add escalation report generation |
| `src/parallel/merge-engine.ts` | **Modify** | Add circuit breaker and rollback logic |
| `tests/parallel/conflict-resolver.test.ts` | **Modify** | Add escalation tests |
| `tests/parallel/merge-engine.test.ts` | **Modify** | Add circuit breaker and rollback tests |

## Implementation Details

### 1. Human escalation report

When a conflict cannot be resolved by auto or AI strategies (or AI confidence is below threshold), generate a structured escalation report.

```typescript
// In ConflictResolver class:

export interface EscalationReport {
  id: string;
  requestId: string;
  file: string;
  trackA: string;
  trackB: string;
  conflictType: ConflictType;
  baseContent: string;
  oursContent: string;
  theirsContent: string;
  specAIntent: string;       // relevant spec excerpt for trackA
  specBIntent: string;       // relevant spec excerpt for trackB
  aiSuggestion: string | null;
  aiConfidence: number | null;
  aiReasoning: string | null;
  timestamp: string;
}

async escalateConflict(
  file: string,
  requestId: string,
  trackA: string,
  trackB: string,
  aiResult?: ConflictResolutionResult
): Promise<EscalationReport> {
  const report: EscalationReport = {
    id: `conflict-${requestId}-${Date.now()}`,
    requestId,
    file,
    trackA,
    trackB,
    conflictType: ConflictType.OverlappingConflicting, // or as classified
    baseContent: await this.getStageContent(file, 1) ?? '',
    oursContent: await this.getStageContent(file, 2) ?? '',
    theirsContent: await this.getStageContent(file, 3) ?? '',
    specAIntent: 'extracted from spec', // pull relevant section
    specBIntent: 'extracted from spec',
    aiSuggestion: aiResult?.resolvedContent ?? null,
    aiConfidence: aiResult?.confidence ?? null,
    aiReasoning: aiResult?.reasoning ?? null,
    timestamp: new Date().toISOString(),
  };

  // Write report to structured location
  const reportDir = path.join(this.repoRoot, '.autonomous-dev', 'conflicts', `req-${requestId}`);
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `${report.id}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf-8');

  // Abort the in-progress merge
  try {
    execSync(`git -C "${this.repoRoot}" merge --abort`);
  } catch {
    // merge --abort may fail if no merge in progress; that's fine
  }

  this.eventEmitter.emit('merge.escalated', {
    type: 'merge.escalated',
    requestId,
    file,
    trackA,
    trackB,
    reportPath,
    timestamp: new Date().toISOString(),
  });

  return report;
}
```

**Escalation report directory layout**:
```
.autonomous-dev/
  conflicts/
    req-001/
      conflict-req-001-1712345678901.json
      conflict-req-001-1712345678999.json
```

### 2. Merge circuit breaker

```typescript
// In MergeEngine class:

private unresolvedConflictCount: Map<string, number> = new Map();

private checkCircuitBreaker(requestId: string, results: MergeResult[]): void {
  const unresolved = results.filter(
    r => r.resolutionStrategy === 'failed' || r.resolutionStrategy === 'escalated'
  ).length;

  const current = (this.unresolvedConflictCount.get(requestId) ?? 0) + unresolved;
  this.unresolvedConflictCount.set(requestId, current);

  if (current > this.config.merge_conflict_escalation_threshold) {
    this.eventEmitter.emit('request.escalated', {
      type: 'request.escalated',
      requestId,
      reason: `Merge conflict circuit breaker: ${current} unresolved conflicts exceed threshold of ${this.config.merge_conflict_escalation_threshold}`,
      unresolvedConflicts: current,
      timestamp: new Date().toISOString(),
    });

    throw new MergeCircuitBreakerError(
      requestId,
      current,
      this.config.merge_conflict_escalation_threshold
    );
  }
}

resetCircuitBreaker(requestId: string): void {
  this.unresolvedConflictCount.delete(requestId);
}
```

The circuit breaker counts **only unresolved** conflicts (those not resolved by auto or AI). Successfully resolved conflicts do not count toward the threshold.

### 3. Rollback procedures

```typescript
// In MergeEngine class:

/**
 * Revert a single track's merge commit from the integration branch.
 * Uses git revert -m 1 to undo the merge while preserving history.
 */
async rollbackTrackMerge(requestId: string, trackName: string): Promise<void> {
  const integrationBranch = integrationBranchName(requestId);

  // Safety check: only operate on auto/ branches
  if (!integrationBranch.startsWith('auto/')) {
    throw new Error(`Refusing to rollback non-auto branch: ${integrationBranch}`);
  }

  this.exec(`git -C "${this.repoRoot}" checkout ${integrationBranch}`);

  // Find the merge commit for this track
  const mergeCommit = this.exec(
    `git -C "${this.repoRoot}" log --merges --grep="merge: ${trackName}" --format=%H -1`
  ).trim();

  if (!mergeCommit) {
    throw new Error(`No merge commit found for track ${trackName} on ${integrationBranch}`);
  }

  // Revert the merge commit (parent 1 is the integration branch side)
  this.exec(`git -C "${this.repoRoot}" revert -m 1 --no-edit ${mergeCommit}`);

  this.eventEmitter.emit('merge.rolledback', {
    type: 'merge.rolledback',
    requestId,
    trackName,
    revertedCommit: mergeCommit,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Reset the entire integration branch to its state before any merges.
 * Uses git reset --hard to the first commit on the integration branch
 * (the branch point from base).
 */
async rollbackIntegration(requestId: string): Promise<void> {
  const integrationBranch = integrationBranchName(requestId);

  // Safety check: only operate on auto/ branches
  if (!integrationBranch.startsWith('auto/')) {
    throw new Error(`Refusing to reset non-auto branch: ${integrationBranch}`);
  }

  this.exec(`git -C "${this.repoRoot}" checkout ${integrationBranch}`);

  // Find the branch point (first parent of the first merge commit, or the initial branch point)
  // The integration branch was created from base_branch, so find that commit
  const baseBranch = this.config.base_branch;
  const branchPoint = this.exec(
    `git -C "${this.repoRoot}" merge-base ${integrationBranch} ${baseBranch}`
  ).trim();

  // Reset to branch point
  this.exec(`git -C "${this.repoRoot}" reset --hard ${branchPoint}`);

  this.eventEmitter.emit('merge.integration_reset', {
    type: 'merge.integration_reset',
    requestId,
    resetToCommit: branchPoint,
    timestamp: new Date().toISOString(),
  });
}
```

## Acceptance Criteria

1. `escalateConflict` generates a JSON report with base/ours/theirs content, spec intents, AI suggestion, and confidence.
2. Report is written to `.autonomous-dev/conflicts/req-{id}/conflict-{id}.json`.
3. `escalateConflict` calls `git merge --abort` to restore the integration branch.
4. `escalateConflict` emits `merge.escalated` event with report path.
5. Circuit breaker tracks cumulative unresolved conflicts per request.
6. Circuit breaker throws `MergeCircuitBreakerError` when count exceeds threshold (default 5).
7. Only unresolved conflicts count (auto-resolved and AI-resolved do not).
8. `request.escalated` event emitted when circuit breaker trips.
9. `rollbackTrackMerge` uses `git revert -m 1` to undo a specific track's merge commit.
10. `rollbackTrackMerge` finds the merge commit via `git log --merges --grep`.
11. `rollbackTrackMerge` refuses to operate on non-`auto/` branches.
12. `rollbackIntegration` uses `git reset --hard` to the branch point (merge-base with base_branch).
13. `rollbackIntegration` refuses to operate on non-`auto/` branches.
14. Both rollback operations are logged and emit events.

## Test Cases

```
// conflict-resolver.test.ts (escalation section)

describe('escalateConflict', () => {
  it('writes escalation report to correct path', async () => {
    const report = await resolver.escalateConflict('src/service.ts', 'req-001', 'track-a', 'track-b');
    const reportPath = path.join(repoRoot, '.autonomous-dev', 'conflicts', 'req-req-001');
    const files = fs.readdirSync(reportPath);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^conflict-req-001-\d+\.json$/);
  });

  it('report contains all required fields', async () => {
    const report = await resolver.escalateConflict('src/service.ts', 'req-001', 'track-a', 'track-b');
    expect(report.file).toBe('src/service.ts');
    expect(report.trackA).toBe('track-a');
    expect(report.trackB).toBe('track-b');
    expect(report.baseContent).toBeTruthy();
  });

  it('includes AI suggestion when provided', async () => {
    const aiResult = { resolvedContent: 'merged', confidence: 0.5, reasoning: 'unsure', strategy: 'ai' as const };
    const report = await resolver.escalateConflict('src/service.ts', 'req-001', 'track-a', 'track-b', aiResult);
    expect(report.aiSuggestion).toBe('merged');
    expect(report.aiConfidence).toBe(0.5);
  });

  it('aborts the in-progress merge', async () => {
    await resolver.escalateConflict('src/service.ts', 'req-001', 'track-a', 'track-b');
    // Verify no merge in progress
    const status = execSync(`git -C "${repoRoot}" status`).toString();
    expect(status).not.toContain('Unmerged');
  });

  it('emits merge.escalated event', async () => {
    const events: any[] = [];
    emitter.on('merge.escalated', e => events.push(e));
    await resolver.escalateConflict('src/service.ts', 'req-001', 'track-a', 'track-b');
    expect(events.length).toBe(1);
  });
});

// merge-engine.test.ts (circuit breaker and rollback sections)

describe('merge circuit breaker', () => {
  it('does not trip below threshold', () => {
    const results = Array.from({ length: 4 }, () => ({
      ...cleanMergeResult,
      resolutionStrategy: 'failed' as const,
    }));
    // threshold is 5, count is 4
    expect(() => mergeEngine['checkCircuitBreaker']('req-001', results)).not.toThrow();
  });

  it('trips when count exceeds threshold', () => {
    const results = Array.from({ length: 6 }, () => ({
      ...cleanMergeResult,
      resolutionStrategy: 'failed' as const,
    }));
    expect(() => mergeEngine['checkCircuitBreaker']('req-001', results)).toThrow(MergeCircuitBreakerError);
  });

  it('only counts unresolved conflicts', () => {
    const results = [
      { ...cleanMergeResult, resolutionStrategy: 'auto-resolved' as const },
      { ...cleanMergeResult, resolutionStrategy: 'auto-resolved' as const },
      { ...cleanMergeResult, resolutionStrategy: 'failed' as const },
    ];
    // Only 1 unresolved, threshold is 5 -> no trip
    expect(() => mergeEngine['checkCircuitBreaker']('req-001', results)).not.toThrow();
  });

  it('emits request.escalated on trip', () => {
    const events: any[] = [];
    emitter.on('request.escalated', e => events.push(e));
    try {
      const results = Array.from({ length: 6 }, () => ({
        ...cleanMergeResult,
        resolutionStrategy: 'failed' as const,
      }));
      mergeEngine['checkCircuitBreaker']('req-001', results);
    } catch {}
    expect(events.length).toBe(1);
    expect(events[0].reason).toContain('circuit breaker');
  });

  it('accumulates across multiple mergeCluster calls', async () => {
    // First call: 3 failures
    // Second call: 3 more failures -> total 6, trips at 5
    // (Tested by calling checkCircuitBreaker twice with cumulative tracking)
  });
});

describe('rollbackTrackMerge', () => {
  beforeEach(async () => {
    // Set up: merge a track, then we'll revert it
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
  });

  it('reverts the merge commit', async () => {
    const preSha = execSync(`git -C "${repoRoot}" rev-parse HEAD`).toString().trim();
    await mergeEngine.rollbackTrackMerge('req-001', 'track-a');
    const postSha = execSync(`git -C "${repoRoot}" rev-parse HEAD`).toString().trim();
    expect(postSha).not.toBe(preSha); // new revert commit
    // Verify the track's changes are undone
  });

  it('refuses non-auto branches', async () => {
    await expect(
      mergeEngine.rollbackTrackMerge('req-001', 'track-a')
    ).resolves.not.toThrow(); // auto/ branch is fine

    // Manually set a non-auto integration branch
    mergeEngine['config'].base_branch = 'main';
    // This would need a different test setup
  });

  it('throws if no merge commit found', async () => {
    await expect(
      mergeEngine.rollbackTrackMerge('req-001', 'nonexistent-track')
    ).rejects.toThrow(/no merge commit/i);
  });
});

describe('rollbackIntegration', () => {
  it('resets to branch point', async () => {
    const branchPoint = execSync(
      `git -C "${repoRoot}" merge-base auto/req-001/integration main`
    ).toString().trim();

    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    await mergeEngine.rollbackIntegration('req-001');

    const currentSha = execSync(`git -C "${repoRoot}" rev-parse auto/req-001/integration`).toString().trim();
    expect(currentSha).toBe(branchPoint);
  });

  it('removes all merge commits', async () => {
    await mergeEngine.mergeTrack('req-001', 'track-a', 'auto/req-001/integration');
    await mergeEngine.mergeTrack('req-001', 'track-c', 'auto/req-001/integration');
    await mergeEngine.rollbackIntegration('req-001');

    const log = execSync(
      `git -C "${repoRoot}" log --oneline auto/req-001/integration`
    ).toString().trim();
    expect(log).not.toContain('merge:');
  });
});
```
