# SPEC-006-5-3: Test Failure Attribution and Revision Loop

## Metadata
- **Parent Plan**: PLAN-006-5
- **Tasks Covered**: Task 6, Task 7
- **Estimated effort**: 10 hours

## Description

Implement the failure attribution system that maps failing integration tests to responsible tracks using `git log` and `git blame`, and the revision loop that re-executes responsible tracks in fresh worktrees branched from the current integration branch with failure context. Includes the revision loop circuit breaker.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/integration-tester.ts` | **Modify** | Add failure attribution and revision loop |
| `tests/parallel/integration-tester.test.ts` | **Modify** | Add attribution and revision tests |

## Implementation Details

### 1. Failure attribution

```typescript
export interface FailureAttribution {
  testFile: string;
  testName: string;
  responsibleTracks: string[];
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
}

/**
 * Map failing tests to responsible tracks by analyzing git history.
 * Two strategies:
 *   1. Test file attribution: which merge commit last modified the test file?
 *   2. Source code attribution: git blame on failing lines to find responsible merge.
 */
async attributeFailures(
  requestId: string,
  failedTests: FailedTest[]
): Promise<Map<string, FailureAttribution[]>> {
  const integrationBranch = integrationBranchName(requestId);
  const baseBranch = this.config.base_branch;
  const attributions = new Map<string, FailureAttribution[]>();

  for (const test of failedTests) {
    const tracks = await this.findResponsibleTracks(
      requestId,
      test,
      integrationBranch,
      baseBranch
    );

    for (const trackName of tracks) {
      if (!attributions.has(trackName)) {
        attributions.set(trackName, []);
      }
      attributions.get(trackName)!.push({
        testFile: test.testFile,
        testName: test.testName,
        responsibleTracks: tracks,
        confidence: tracks.length === 1 ? 'high' : 'medium',
        evidence: `Identified via git log/blame analysis`,
      });
    }
  }

  return attributions;
}

private async findResponsibleTracks(
  requestId: string,
  test: FailedTest,
  integrationBranch: string,
  baseBranch: string
): Promise<string[]> {
  const tracks: Set<string> = new Set();

  // Strategy 1: Find which merge commits modified the test file
  try {
    const log = execSync(
      `git -C "${this.repoRoot}" log --oneline --merges ${baseBranch}..${integrationBranch} -- "${test.testFile}"`,
      { encoding: 'utf-8' }
    ).trim();

    if (log) {
      // Parse merge commit messages to extract track names
      // Format: "merge: {trackName} into auto/{requestId}/integration"
      const trackRegex = /merge:\s+(\S+)\s+into/g;
      let match;
      while ((match = trackRegex.exec(log)) !== null) {
        tracks.add(match[1]);
      }
    }
  } catch {
    // git log failed -- skip this strategy
  }

  // Strategy 2: If the test imports source files, check which tracks modified those
  if (tracks.size === 0) {
    try {
      // Read the test file to find imports
      const testContent = execSync(
        `git -C "${this.repoRoot}" show ${integrationBranch}:${test.testFile}`,
        { encoding: 'utf-8' }
      );

      // Extract import paths
      const importRegex = /(?:import|require)\s*\(?['"](\.\/[^'"]+)['"]/g;
      let importMatch;
      while ((importMatch = importRegex.exec(testContent)) !== null) {
        const importPath = importMatch[1];
        // Resolve relative to test file directory
        const resolvedPath = path.join(path.dirname(test.testFile), importPath);

        // Find which merge commits modified this source file
        const sourceLog = execSync(
          `git -C "${this.repoRoot}" log --oneline --merges ${baseBranch}..${integrationBranch} -- "${resolvedPath}*"`,
          { encoding: 'utf-8' }
        ).trim();

        const trackRegex2 = /merge:\s+(\S+)\s+into/g;
        let match2;
        while ((match2 = trackRegex2.exec(sourceLog)) !== null) {
          tracks.add(match2[1]);
        }
      }
    } catch {
      // fallback
    }
  }

  // Strategy 3: If specific line numbers available, use git blame
  if (tracks.size === 0 && test.lineNumber) {
    try {
      const blame = execSync(
        `git -C "${this.repoRoot}" blame -L ${test.lineNumber},${test.lineNumber} ${integrationBranch} -- "${test.testFile}"`,
        { encoding: 'utf-8' }
      ).trim();

      // Extract commit SHA from blame output
      const commitSha = blame.split(' ')[0];
      if (commitSha && commitSha !== '00000000') {
        // Find which merge commit introduced this change
        const mergeLog = execSync(
          `git -C "${this.repoRoot}" log --merges --ancestry-path ${commitSha}..${integrationBranch} --format=%s -1`,
          { encoding: 'utf-8' }
        ).trim();

        const trackMatch = mergeLog.match(/merge:\s+(\S+)\s+into/);
        if (trackMatch) tracks.add(trackMatch[1]);
      }
    } catch {
      // blame failed
    }
  }

  // If still no attribution, attribute to all tracks in the last cluster
  if (tracks.size === 0) {
    tracks.add('unknown');
  }

  return Array.from(tracks);
}
```

### 2. Revision loop

```typescript
export interface RevisionRequest {
  requestId: string;
  trackName: string;
  failures: FailureAttribution[];
  revisionCycle: number;
}

private revisionCounts = new Map<string, number>();

/**
 * Re-execute a track in a fresh worktree branched from the current
 * integration branch, with failure context provided to the agent.
 */
async reviseTrack(
  requestId: string,
  trackName: string,
  failures: FailureAttribution[]
): Promise<void> {
  const currentCycle = (this.revisionCounts.get(trackName) ?? 0) + 1;
  this.revisionCounts.set(trackName, currentCycle);

  // Check revision loop circuit breaker
  if (currentCycle > this.config.max_revision_cycles) {
    this.eventBus.emit({
      type: 'request.escalated',
      requestId,
      reason: `Track ${trackName} exceeded max revision cycles (${this.config.max_revision_cycles})`,
      timestamp: new Date().toISOString(),
    });
    throw new RevisionLimitExceededError(trackName, currentCycle, this.config.max_revision_cycles);
  }

  // Create a fresh worktree for the revision, branched from current integration
  // The revision track name includes the cycle number to avoid collisions
  const revisionTrackName = `${trackName}-rev${currentCycle}`;
  const worktree = await this.worktreeManager.createTrackWorktree(requestId, revisionTrackName);

  // Prepare failure context for the agent
  const failureContext = this.buildFailureContext(failures);

  // Signal the scheduler to dispatch a new agent for this revision track
  // The agent receives:
  // 1. The original spec
  // 2. The integration branch state (all other tracks' changes are visible)
  // 3. Failure output: specific test files, error messages, line numbers
  // 4. Instruction to fix the failing tests while preserving all other functionality

  this.eventBus.emit({
    type: 'track.state_changed',
    requestId,
    trackName: revisionTrackName,
    from: 'pending',
    to: 'queued',
    reason: `Revision cycle ${currentCycle}: fixing ${failures.length} test failures`,
    timestamp: new Date().toISOString(),
  });

  // The actual agent dispatch is handled by the scheduler/engine orchestrator
  // This method prepares the revision and signals readiness
}

private buildFailureContext(failures: FailureAttribution[]): string {
  const lines = [
    '## Revision Context: Fix Integration Test Failures',
    '',
    'The following tests failed after your changes were merged. Fix these failures',
    'while preserving all existing functionality.',
    '',
    '### Failing Tests',
    '',
  ];

  for (const failure of failures) {
    lines.push(`**${failure.testFile}**${failure.testName ? `: ${failure.testName}` : ''}`);
    lines.push(`- Responsible tracks: ${failure.responsibleTracks.join(', ')}`);
    lines.push(`- Confidence: ${failure.confidence}`);
    lines.push('');
  }

  return lines.join('\n');
}
```

### 3. Integration test circuit breaker

```typescript
private consecutiveFailures = 0;
private readonly maxConsecutiveFailures = 3;

async runIntegrationTestsWithRevision(requestId: string): Promise<IntegrationTestResult> {
  const result = await this.runIntegrationTests(requestId);

  if (result.passed) {
    this.consecutiveFailures = 0;
    return result;
  }

  this.consecutiveFailures++;

  if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
    this.eventBus.emit({
      type: 'request.escalated',
      requestId,
      reason: `Integration test circuit breaker: ${this.consecutiveFailures} consecutive failures`,
      timestamp: new Date().toISOString(),
    });
    throw new IntegrationTestCircuitBreakerError(
      requestId,
      this.consecutiveFailures
    );
  }

  // Attribute failures and trigger revisions
  const attributions = await this.attributeFailures(requestId, result.failedTests);

  // Revise each responsible track
  for (const [trackName, failures] of attributions) {
    if (trackName === 'unknown') continue; // cannot revise unknown
    await this.reviseTrack(requestId, trackName, failures);
  }

  // After revisions complete (triggered asynchronously), the engine will
  // re-merge and re-run integration tests, looping back here

  return result;
}
```

## Acceptance Criteria

1. `attributeFailures` maps each failing test to one or more responsible tracks.
2. Strategy 1: identifies tracks via `git log --merges` on the test file path.
3. Strategy 2: traces imports from test file to source files, then finds modifying tracks.
4. Strategy 3: uses `git blame` on specific failing lines when line numbers available.
5. Fallback: attributes to "unknown" when no track can be identified.
6. Attribution confidence: "high" when single track, "medium" when multiple tracks.
7. `reviseTrack` creates a fresh worktree branched from the current integration branch.
8. Revised track worktree name includes revision cycle number (e.g., `track-a-rev1`).
9. Revision agent receives: original spec, failure output, specific test files and errors.
10. Revision loop circuit breaker: max `max_revision_cycles` (default 2) per track before escalation.
11. Integration test circuit breaker: 3 consecutive failures abort the entire request.
12. `request.escalated` event emitted when either circuit breaker trips.
13. Consecutive failure count resets to 0 on a passing test run.
14. Revision tracks go through the full lifecycle: execute, test, review, merge.

## Test Cases

```
// integration-tester.test.ts (attribution and revision sections)

describe('attributeFailures', () => {
  beforeEach(async () => {
    // Set up: repo with integration branch, two merge commits
    // Merge 1: track-a modified src/user.ts
    // Merge 2: track-b modified src/auth.ts
    // Test file: src/user.test.ts imports src/user.ts
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

  it('attributes via import analysis when test file not directly modified', async () => {
    // Test file imports src/user.ts which was modified by track-a
    const attributions = await tester.attributeFailures('req-001', [{
      testFile: 'src/integration.test.ts', // not directly modified by any track
      testName: 'integration test',
      lineNumber: null,
      errorMessage: 'error',
    }]);
    // Should trace imports to find track-a
    expect(attributions.size).toBeGreaterThan(0);
  });

  it('handles multiple responsible tracks', async () => {
    // Test file modified by both track-a and track-b
    const attributions = await tester.attributeFailures('req-001', [{
      testFile: 'src/combined.test.ts',
      testName: 'combined test',
      lineNumber: null,
      errorMessage: 'error',
    }]);
    // Multiple tracks attributed
    for (const [, attrs] of attributions) {
      expect(attrs[0].confidence).toBe('medium');
    }
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

describe('reviseTrack', () => {
  it('creates revision worktree with cycle number', async () => {
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
    const worktrees = await worktreeManager.listWorktrees('req-001');
    expect(worktrees.find(w => w.trackName === 'track-a-rev1')).toBeDefined();
  });

  it('increments revision count', async () => {
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
    const worktrees = await worktreeManager.listWorktrees('req-001');
    expect(worktrees.find(w => w.trackName === 'track-a-rev2')).toBeDefined();
  });

  it('throws RevisionLimitExceededError when max cycles exceeded', async () => {
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]); // cycle 1
    await tester.reviseTrack('req-001', 'track-a', [mockAttribution]); // cycle 2
    await expect(
      tester.reviseTrack('req-001', 'track-a', [mockAttribution]) // cycle 3 > max 2
    ).rejects.toThrow(RevisionLimitExceededError);
  });

  it('emits request.escalated when revision limit exceeded', async () => {
    const events: any[] = [];
    bus.on('request.escalated', e => events.push(e));
    try {
      for (let i = 0; i < 3; i++) {
        await tester.reviseTrack('req-001', 'track-a', [mockAttribution]);
      }
    } catch {}
    expect(events.length).toBe(1);
    expect(events[0].reason).toContain('revision cycles');
  });
});

describe('integration test circuit breaker', () => {
  it('resets count on passing test', async () => {
    // Run 2 failures then 1 pass
    tester['consecutiveFailures'] = 2;
    mockTestRunner.pass = true;
    await tester.runIntegrationTestsWithRevision('req-001');
    expect(tester['consecutiveFailures']).toBe(0);
  });

  it('trips after 3 consecutive failures', async () => {
    mockTestRunner.pass = false;
    await expect(async () => {
      for (let i = 0; i < 3; i++) {
        await tester.runIntegrationTestsWithRevision('req-001');
      }
    }).rejects.toThrow(IntegrationTestCircuitBreakerError);
  });

  it('emits request.escalated on trip', async () => {
    const events: any[] = [];
    bus.on('request.escalated', e => events.push(e));
    mockTestRunner.pass = false;
    try {
      for (let i = 0; i < 3; i++) {
        await tester.runIntegrationTestsWithRevision('req-001');
      }
    } catch {}
    expect(events.some(e => e.reason.includes('circuit breaker'))).toBe(true);
  });
});
```
