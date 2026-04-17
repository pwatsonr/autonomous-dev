# SPEC-006-5-2: Progress Reporting and ETA Calculation

## Metadata
- **Parent Plan**: PLAN-006-5
- **Tasks Covered**: Task 4, Task 5
- **Estimated effort**: 8 hours

## Description

Implement per-track and request-level progress reporting with estimated time remaining. Build the integration test runner that executes the project's test suite on the integration branch after all tracks merge and captures structured output.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/parallel/progress-tracker.ts` | **Modify** | Add progress reporting and ETA calculation |
| `src/parallel/integration-tester.ts` | **Create** | Integration test runner on the integration branch |
| `tests/parallel/progress-tracker.test.ts` | **Modify** | Add progress/ETA tests |
| `tests/parallel/integration-tester.test.ts` | **Create** | Test runner tests |

## Implementation Details

### 1. Progress reporting types

```typescript
export interface TrackProgress {
  trackName: string;
  state: TrackState;
  phaseProgress: string;     // e.g. "executing (turn 23/60)", "testing", "complete"
  elapsedMinutes: number;
  turnsUsed: number;
  turnBudget: number;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RequestProgress {
  requestId: string;
  totalTracks: number;
  completedTracks: number;
  failedTracks: number;
  inProgressTracks: TrackProgress[];
  percentComplete: number;     // 0-100
  etaMinutes: number | null;   // null if insufficient data
  currentCluster: number;
  totalClusters: number;
  elapsedMinutes: number;
  startedAt: string;
}
```

### 2. Progress tracker

```typescript
export class ProgressTracker {
  private trackMachines = new Map<string, TrackStateMachine>();
  private trackAssignments = new Map<string, TrackAssignment>();
  private completedDurations: number[] = [];  // minutes per completed track
  private requestStartTime: number = Date.now();
  private reportInterval: NodeJS.Timeout | null = null;

  constructor(
    private requestId: string,
    private eventBus: EventBus,
    private config: ParallelConfig
  ) {}

  registerTrack(trackName: string, assignment: TrackAssignment, sm: TrackStateMachine): void {
    this.trackMachines.set(trackName, sm);
    this.trackAssignments.set(trackName, assignment);
  }

  /**
   * Record a track completion for ETA calculation.
   */
  recordTrackCompletion(trackName: string, durationMinutes: number): void {
    this.completedDurations.push(durationMinutes);
  }

  getTrackProgress(trackName: string): TrackProgress {
    const sm = this.trackMachines.get(trackName);
    const assignment = this.trackAssignments.get(trackName);
    if (!sm || !assignment) throw new Error(`Unknown track: ${trackName}`);

    const state = sm.getState();
    let phaseProgress: string;
    switch (state) {
      case 'executing':
        phaseProgress = `executing (turn ${assignment.turnsUsed}/${assignment.turnBudget})`;
        break;
      case 'complete':
        phaseProgress = 'complete';
        break;
      case 'failed':
        phaseProgress = `failed (retry ${assignment.retryCount})`;
        break;
      default:
        phaseProgress = state;
    }

    const startedAt = assignment.startedAt;
    const elapsedMs = startedAt
      ? Date.now() - new Date(startedAt).getTime()
      : 0;

    return {
      trackName,
      state,
      phaseProgress,
      elapsedMinutes: Math.round(elapsedMs / 60_000),
      turnsUsed: assignment.turnsUsed,
      turnBudget: assignment.turnBudget,
      startedAt,
      completedAt: assignment.completedAt,
    };
  }

  getRequestProgress(currentCluster: number, totalClusters: number): RequestProgress {
    const total = this.trackMachines.size;
    let completed = 0;
    let failed = 0;
    const inProgress: TrackProgress[] = [];

    for (const [trackName, sm] of this.trackMachines) {
      const state = sm.getState();
      if (state === 'complete') completed++;
      else if (state === 'failed' || state === 'escalated') failed++;
      else inProgress.push(this.getTrackProgress(trackName));
    }

    const percentComplete = total > 0 ? Math.round((completed / total) * 100) : 0;
    const etaMinutes = this.calculateETA(total, completed, inProgress.length, totalClusters - currentCluster);

    return {
      requestId: this.requestId,
      totalTracks: total,
      completedTracks: completed,
      failedTracks: failed,
      inProgressTracks: inProgress,
      percentComplete,
      etaMinutes,
      currentCluster,
      totalClusters,
      elapsedMinutes: Math.round((Date.now() - this.requestStartTime) / 60_000),
      startedAt: new Date(this.requestStartTime).toISOString(),
    };
  }

  /**
   * ETA calculation:
   * 1. If completed tracks exist: rolling average of completed durations / effective parallelism
   * 2. If no completed tracks: use complexity heuristic
   */
  calculateETA(
    total: number,
    completed: number,
    inProgress: number,
    remainingClusters: number
  ): number | null {
    const remaining = total - completed;
    if (remaining === 0) return 0;

    if (this.completedDurations.length > 0) {
      // Rolling average of completed track durations
      const avgDuration = this.completedDurations.reduce((a, b) => a + b, 0)
                          / this.completedDurations.length;

      // Effective parallelism: min(max_tracks, remaining tracks)
      const parallelism = Math.min(this.config.max_tracks, remaining);

      // Remaining time = (remaining tracks / parallelism) * avgDuration
      // Adjust for cluster boundaries: add ~1 min per remaining cluster transition
      const trackTime = (remaining / parallelism) * avgDuration;
      const clusterOverhead = remainingClusters * 1; // 1 min per cluster merge

      return Math.round(trackTime + clusterOverhead);
    }

    // No completed tracks: use complexity heuristic
    const heuristicETA = this.calculateHeuristicETA(remaining, remainingClusters);
    return heuristicETA;
  }

  /**
   * Complexity-based initial estimate:
   * small = 5 min, medium = 15 min, large = 30 min
   * Divide by effective parallelism
   */
  private calculateHeuristicETA(remaining: number, remainingClusters: number): number {
    let totalEstimate = 0;
    for (const [trackName, assignment] of this.trackAssignments) {
      const sm = this.trackMachines.get(trackName)!;
      if (sm.getState() !== 'complete' && sm.getState() !== 'failed') {
        switch (assignment.spec.complexity) {
          case 'small': totalEstimate += 5; break;
          case 'medium': totalEstimate += 15; break;
          case 'large': totalEstimate += 30; break;
        }
      }
    }

    const parallelism = Math.min(this.config.max_tracks, remaining);
    return Math.round((totalEstimate / parallelism) + remainingClusters);
  }

  /**
   * Start periodic progress event emission.
   */
  startPeriodicReporting(currentCluster: number, totalClusters: number, intervalMs: number = 60_000): void {
    this.reportInterval = setInterval(() => {
      const progress = this.getRequestProgress(currentCluster, totalClusters);
      this.eventBus.emit({
        type: 'request.progress',
        ...progress,
        timestamp: new Date().toISOString(),
      });
    }, intervalMs);
  }

  stopPeriodicReporting(): void {
    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }
  }
}
```

### 3. Integration test runner

```typescript
export interface IntegrationTestResult {
  passed: boolean;
  exitCode: number;
  output: string;
  failedTests: FailedTest[];
  duration: number;    // ms
  logPath: string;
}

export interface FailedTest {
  testFile: string;
  testName: string;
  lineNumber: number | null;
  errorMessage: string;
}

export class IntegrationTester {
  constructor(
    private repoRoot: string,
    private config: ParallelConfig,
    private worktreeManager: WorktreeManager,
    private eventBus: EventBus
  ) {}

  /**
   * Run the project's test suite on the integration branch.
   * Creates a dedicated worktree for test execution.
   */
  async runIntegrationTests(requestId: string): Promise<IntegrationTestResult> {
    const integrationBranch = integrationBranchName(requestId);
    const testTrackName = 'integration-test';

    this.eventBus.emit({
      type: 'integration.test_started',
      requestId,
      timestamp: new Date().toISOString(),
    });

    // Create a dedicated worktree for testing
    const worktree = await this.worktreeManager.createTrackWorktree(requestId, testTrackName);
    const cwd = worktree.worktreePath;

    try {
      // Checkout the integration branch
      execSync(`git -C "${cwd}" checkout ${integrationBranch}`, { encoding: 'utf-8' });

      // Install dependencies (project-specific)
      const installCmd = this.config.install_command ?? 'npm ci';
      try {
        execSync(installCmd, { cwd, encoding: 'utf-8', timeout: 300_000 }); // 5 min timeout
      } catch (err) {
        // Install failure is itself a test failure
      }

      // Run test suite
      const testCmd = this.config.test_command ?? 'npm test';
      const startTime = Date.now();
      let output: string;
      let exitCode: number;

      try {
        output = execSync(testCmd, {
          cwd,
          encoding: 'utf-8',
          timeout: 600_000, // 10 min timeout
          env: { ...process.env, CI: 'true' },
        });
        exitCode = 0;
      } catch (err: any) {
        output = err.stdout?.toString() ?? '' + '\n' + (err.stderr?.toString() ?? '');
        exitCode = err.status ?? 1;
      }

      const duration = Date.now() - startTime;

      // Write output to log file
      const logDir = path.join(this.repoRoot, '.autonomous-dev', 'logs', `req-${requestId}`);
      await fs.mkdir(logDir, { recursive: true });
      const logPath = path.join(logDir, 'integration-test.log');
      await fs.writeFile(logPath, output, 'utf-8');

      // Parse failed tests
      const failedTests = this.parseTestOutput(output);

      const passed = exitCode === 0;
      const eventType = passed ? 'integration.test_passed' : 'integration.test_failed';

      this.eventBus.emit({
        type: eventType,
        requestId,
        exitCode,
        failedTestCount: failedTests.length,
        duration,
        timestamp: new Date().toISOString(),
      });

      return { passed, exitCode, output, failedTests, duration, logPath };
    } finally {
      // Clean up test worktree
      await this.worktreeManager.removeWorktree(requestId, testTrackName, true);
    }
  }

  /**
   * Parse test output to extract failed test information.
   * Supports Jest/Vitest output format initially; extensible for other frameworks.
   */
  private parseTestOutput(output: string): FailedTest[] {
    const failed: FailedTest[] = [];

    // Jest/Vitest format: "FAIL src/path/to/test.ts"
    const failRegex = /FAIL\s+(\S+\.(?:ts|js|tsx|jsx))/g;
    let match;
    while ((match = failRegex.exec(output)) !== null) {
      failed.push({
        testFile: match[1],
        testName: '',
        lineNumber: null,
        errorMessage: '',
      });
    }

    // Extract specific test names: "  x test name (42ms)"
    // or "  ✕ test name"
    const testNameRegex = /[✕x]\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm;
    while ((match = testNameRegex.exec(output)) !== null) {
      if (failed.length > 0) {
        failed[failed.length - 1].testName = match[1].trim();
      }
    }

    // Extract error messages from "Expected/Received" blocks
    const errorRegex = /Expected:.*\n.*Received:.*/g;
    while ((match = errorRegex.exec(output)) !== null) {
      if (failed.length > 0 && !failed[failed.length - 1].errorMessage) {
        failed[failed.length - 1].errorMessage = match[0];
      }
    }

    return failed;
  }
}
```

## Acceptance Criteria

1. `getTrackProgress` returns status, phase progress string, elapsed minutes, turn usage for any track.
2. Phase progress string includes turn count for executing tracks (e.g., "executing (turn 23/60)").
3. `getRequestProgress` returns total/completed/failed tracks, percent complete, ETA, cluster info.
4. ETA uses rolling average of completed track durations divided by effective parallelism.
5. For first cluster (no completed tracks): ETA uses complexity heuristic (small=5, medium=15, large=30 min).
6. Periodic `request.progress` events emitted at configurable interval (default 60 sec).
7. `runIntegrationTests` creates a dedicated worktree, runs install + test commands, captures output.
8. Test output written to `.autonomous-dev/logs/req-{id}/integration-test.log`.
9. Test command is configurable (not hardcoded to `npm test`).
10. `integration.test_started`, `integration.test_passed`, `integration.test_failed` events emitted.
11. `parseTestOutput` extracts failed test files from Jest/Vitest format.
12. Test worktree is cleaned up after test execution (even on failure).
13. Integration test runner has configurable timeouts (install: 5 min, test: 10 min).

## Test Cases

```
// progress-tracker.test.ts (progress reporting section)

describe('ProgressTracker.getTrackProgress', () => {
  it('reports executing track with turn count', () => {
    assignment.turnsUsed = 23;
    assignment.turnBudget = 60;
    assignment.startedAt = new Date(Date.now() - 5 * 60000).toISOString();
    sm.transition('queued', 'test'); sm.transition('executing', 'test');

    const progress = tracker.getTrackProgress('track-a');
    expect(progress.phaseProgress).toBe('executing (turn 23/60)');
    expect(progress.elapsedMinutes).toBeGreaterThanOrEqual(4);
  });

  it('reports complete track', async () => {
    await sm.transition('queued', 'test');
    await sm.transition('executing', 'test');
    await sm.transition('testing', 'test');
    await sm.transition('reviewing', 'test');
    await sm.transition('merging', 'test');
    await sm.transition('complete', 'test');
    const progress = tracker.getTrackProgress('track-a');
    expect(progress.state).toBe('complete');
    expect(progress.phaseProgress).toBe('complete');
  });
});

describe('ProgressTracker.getRequestProgress', () => {
  it('calculates correct percentages', () => {
    // 3 tracks: 1 complete, 1 executing, 1 pending
    const progress = tracker.getRequestProgress(0, 2);
    expect(progress.totalTracks).toBe(3);
    expect(progress.completedTracks).toBe(1);
    expect(progress.percentComplete).toBe(33);
  });

  it('includes in-progress track details', () => {
    const progress = tracker.getRequestProgress(0, 2);
    expect(progress.inProgressTracks.length).toBeGreaterThan(0);
    expect(progress.inProgressTracks[0].trackName).toBeDefined();
  });
});

describe('ETA calculation', () => {
  it('uses rolling average when completed tracks exist', () => {
    tracker.recordTrackCompletion('t1', 10);
    tracker.recordTrackCompletion('t2', 20);
    // Average = 15 min, 3 remaining, parallelism = 3 -> ~15 min
    const eta = tracker.calculateETA(5, 2, 3, 1);
    expect(eta).toBeGreaterThan(0);
    expect(eta).toBeLessThan(30);
  });

  it('uses heuristic when no completed tracks', () => {
    // All small (5 min each), 5 tracks, parallelism 5 -> ~5 min
    const eta = tracker.calculateETA(5, 0, 5, 1);
    expect(eta).toBeGreaterThan(0);
  });

  it('returns 0 when all tracks complete', () => {
    const eta = tracker.calculateETA(5, 5, 0, 0);
    expect(eta).toBe(0);
  });

  it('accounts for cluster overhead', () => {
    tracker.recordTrackCompletion('t1', 10);
    const etaWith1Cluster = tracker.calculateETA(3, 1, 2, 1);
    const etaWith3Clusters = tracker.calculateETA(3, 1, 2, 3);
    expect(etaWith3Clusters).toBeGreaterThan(etaWith1Cluster!);
  });
});

// integration-tester.test.ts

describe('IntegrationTester', () => {
  it('runs test command and captures output', async () => {
    // Set up: simple project with passing tests
    const result = await tester.runIntegrationTests('req-001');
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output.length).toBeGreaterThan(0);
  });

  it('captures failed tests', async () => {
    // Set up: project with failing test
    const result = await tester.runIntegrationTests('req-001');
    expect(result.passed).toBe(false);
    expect(result.failedTests.length).toBeGreaterThan(0);
    expect(result.failedTests[0].testFile).toBeTruthy();
  });

  it('writes output to log file', async () => {
    const result = await tester.runIntegrationTests('req-001');
    expect(fs.existsSync(result.logPath)).toBe(true);
    const content = fs.readFileSync(result.logPath, 'utf-8');
    expect(content).toBe(result.output);
  });

  it('cleans up test worktree', async () => {
    await tester.runIntegrationTests('req-001');
    const worktrees = await worktreeManager.listWorktrees('req-001');
    expect(worktrees.find(w => w.trackName === 'integration-test')).toBeUndefined();
  });

  it('emits test started and result events', async () => {
    const events: any[] = [];
    bus.on('integration.test_started', e => events.push(e));
    bus.on('integration.test_passed', e => events.push(e));
    await tester.runIntegrationTests('req-001');
    expect(events[0].type).toBe('integration.test_started');
    expect(events[1].type).toBe('integration.test_passed');
  });

  it('uses configurable test command', async () => {
    config.test_command = 'yarn test';
    // Should run yarn test instead of npm test
  });

  it('parses Jest FAIL output format', () => {
    const output = `FAIL src/user.test.ts\n  ✕ should create user (42ms)\n\nExpected: true\nReceived: false`;
    const failed = tester['parseTestOutput'](output);
    expect(failed.length).toBe(1);
    expect(failed[0].testFile).toBe('src/user.test.ts');
  });
});
```
