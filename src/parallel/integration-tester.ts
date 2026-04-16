// ============================================================================
// Integration Tester — Shell Test Runner, Failure Attribution, Revision Loop
// SPEC-006-5-2: Progress Reporting and ETA Calculation (Integration Test Runner)
// SPEC-006-5-3: Test Failure Attribution and Revision Loop
// ============================================================================

import { execSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';

import { ParallelConfig } from './config';
import { integrationBranchName } from './naming';
import { WorktreeManager } from './worktree-manager';
import type { WorktreeInfo } from './types';

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Represents a single failed test from an integration test run.
 */
export interface FailedTest {
  testFile: string;
  testName: string;
  lineNumber: number | null;
  errorMessage: string;
}

/**
 * Attribution of a failing test to one or more responsible tracks.
 */
export interface FailureAttribution {
  testFile: string;
  testName: string;
  responsibleTracks: string[];
  confidence: 'high' | 'medium' | 'low';
  evidence: string;
}

/**
 * The result of running integration tests.
 */
export interface IntegrationTestResult {
  passed: boolean;
  totalTests: number;
  passedTests: number;
  failedTests: FailedTest[];
  durationMs: number;
}

/**
 * A revision request for a single track.
 */
export interface RevisionRequest {
  requestId: string;
  trackName: string;
  failures: FailureAttribution[];
  revisionCycle: number;
}

// ============================================================================
// Error types
// ============================================================================

/**
 * Thrown when a track exceeds the maximum allowed revision cycles.
 */
export class RevisionLimitExceededError extends Error {
  constructor(
    public readonly trackName: string,
    public readonly currentCycle: number,
    public readonly maxCycles: number,
  ) {
    super(
      `Track "${trackName}" exceeded max revision cycles: ` +
      `cycle ${currentCycle} > limit ${maxCycles}`,
    );
    this.name = 'RevisionLimitExceededError';
  }
}

/**
 * Thrown when the integration test circuit breaker trips
 * after too many consecutive failures.
 */
export class IntegrationTestCircuitBreakerError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly consecutiveFailures: number,
  ) {
    super(
      `Integration test circuit breaker tripped for request "${requestId}": ` +
      `${consecutiveFailures} consecutive failures`,
    );
    this.name = 'IntegrationTestCircuitBreakerError';
  }
}

// ============================================================================
// Test runner interface (injectable for testing)
// ============================================================================

/**
 * Minimal interface for running integration tests.
 * Implementations can call any test framework (jest, vitest, etc.).
 */
export interface TestRunner {
  run(repoRoot: string, integrationBranch: string): Promise<IntegrationTestResult>;
}

// ============================================================================
// Extended config for shell-based test runner (SPEC-006-5-2)
// ============================================================================

/**
 * ParallelConfig extended with optional install/test command overrides.
 */
export interface IntegrationTestConfig extends ParallelConfig {
  /** Command to install dependencies (default: 'npm ci'). */
  install_command?: string;
  /** Command to run the test suite (default: 'npm test'). */
  test_command?: string;
}

// ============================================================================
// Shell-based result (SPEC-006-5-2)
// ============================================================================

/**
 * Extended integration test result including raw output and log file path.
 * Used by ShellTestRunner for detailed audit and reporting.
 */
export interface ShellTestRunnerResult {
  /** Whether all tests passed (exitCode === 0). */
  passed: boolean;
  /** Process exit code. */
  exitCode: number;
  /** Raw stdout + stderr output from the test command. */
  output: string;
  /** Parsed list of failed tests (from Jest/Vitest output format). */
  failedTests: FailedTest[];
  /** Total test execution duration in milliseconds. */
  duration: number;
  /** Absolute path to the log file where output was written. */
  logPath: string;
}

// ============================================================================
// ShellTestRunner (SPEC-006-5-2)
// ============================================================================

/**
 * Concrete TestRunner that executes install + test commands in a
 * dedicated worktree on the integration branch.
 *
 * SPEC-006-5-2 acceptance criteria:
 *   - Creates a dedicated worktree for test execution
 *   - Runs configurable install command (default: npm ci, 5 min timeout)
 *   - Runs configurable test command (default: npm test, 10 min timeout)
 *   - Writes output to `.autonomous-dev/logs/req-{id}/integration-test.log`
 *   - Emits integration.test_started, test_passed, test_failed events
 *   - Parses Jest/Vitest FAIL output format
 *   - Always cleans up the test worktree, even on failure
 */
export class ShellTestRunner implements TestRunner {
  constructor(
    private repoRoot: string,
    private config: IntegrationTestConfig,
    private worktreeManager: WorktreeManager,
    private eventBus: EventEmitter,
  ) {}

  /**
   * Run the project's test suite on the integration branch.
   *
   * Creates a dedicated worktree, installs dependencies, runs the test
   * command, captures and parses output, writes a log file, and emits
   * lifecycle events. The test worktree is always cleaned up.
   *
   * @param repoRoot          The repository root (used for worktree context)
   * @param integrationBranch The integration branch name to test
   * @returns IntegrationTestResult (compatible with TestRunner interface)
   */
  async run(
    repoRoot: string,
    integrationBranch: string,
  ): Promise<IntegrationTestResult> {
    const result = await this.runWithDetails(repoRoot, integrationBranch);
    return {
      passed: result.passed,
      totalTests: 0, // Not available from shell runner output parsing
      passedTests: 0,
      failedTests: result.failedTests,
      durationMs: result.duration,
    };
  }

  /**
   * Run integration tests and return the extended ShellTestRunnerResult
   * with raw output, log path, and exit code.
   *
   * @param requestId The parallel execution request identifier
   * @returns ShellTestRunnerResult with full details
   */
  async runIntegrationTests(requestId: string): Promise<ShellTestRunnerResult> {
    const integrationBranch = integrationBranchName(requestId);
    return this.runWithDetails(this.repoRoot, integrationBranch, requestId);
  }

  /**
   * Core implementation shared by run() and runIntegrationTests().
   */
  private async runWithDetails(
    _repoRoot: string,
    integrationBranch: string,
    requestId?: string,
  ): Promise<ShellTestRunnerResult> {
    // Extract requestId from branch name if not provided
    const effectiveRequestId = requestId
      ?? integrationBranch.replace(/^auto\//, '').replace(/\/integration$/, '');
    const testTrackName = 'integration-test';

    this.eventBus.emit('integration.test_started', {
      type: 'integration.test_started',
      requestId: effectiveRequestId,
      timestamp: new Date().toISOString(),
    });

    // Create a dedicated worktree for testing
    const worktree = await this.worktreeManager.createTrackWorktree(
      effectiveRequestId,
      testTrackName,
    );
    const cwd = worktree.worktreePath;

    try {
      // Checkout the integration branch
      execSync(`git -C "${cwd}" checkout ${integrationBranch}`, {
        encoding: 'utf-8',
      });

      // Install dependencies (project-specific, configurable)
      const installCmd = this.config.install_command ?? 'npm ci';
      try {
        execSync(installCmd, {
          cwd,
          encoding: 'utf-8',
          timeout: 300_000, // 5 min timeout
        });
      } catch {
        // Install failure flows through to the test run below
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
      } catch (err: unknown) {
        const execError = err as {
          stdout?: Buffer | string;
          stderr?: Buffer | string;
          status?: number;
        };
        const stdout = execError.stdout?.toString() ?? '';
        const stderr = execError.stderr?.toString() ?? '';
        output = stdout + '\n' + stderr;
        exitCode = execError.status ?? 1;
      }

      const duration = Date.now() - startTime;

      // Write output to log file for audit
      const logDir = path.join(
        this.repoRoot,
        '.autonomous-dev',
        'logs',
        `req-${effectiveRequestId}`,
      );
      await fs.mkdir(logDir, { recursive: true });
      const logPath = path.join(logDir, 'integration-test.log');
      await fs.writeFile(logPath, output, 'utf-8');

      // Parse failed tests from output
      const failedTests = this.parseTestOutput(output);

      const passed = exitCode === 0;
      const eventType = passed
        ? 'integration.test_passed'
        : 'integration.test_failed';

      this.eventBus.emit(eventType, {
        type: eventType,
        requestId: effectiveRequestId,
        exitCode,
        failedTestCount: failedTests.length,
        duration,
        timestamp: new Date().toISOString(),
      });

      return { passed, exitCode, output, failedTests, duration, logPath };
    } finally {
      // Always clean up test worktree, even on failure
      await this.worktreeManager.removeWorktree(
        effectiveRequestId,
        testTrackName,
        true,
      );
    }
  }

  // --------------------------------------------------------------------------
  // Test output parser (SPEC-006-5-2)
  // --------------------------------------------------------------------------

  /**
   * Parse test output to extract failed test information.
   *
   * Supports Jest/Vitest output format initially; extensible for other
   * frameworks by adding additional regex patterns.
   *
   * Recognized patterns:
   *   - "FAIL src/path/to/test.ts" -- identifies failed test files
   *   - "x test name (42ms)" or "\u2715 test name" -- identifies test names
   *   - "Expected: .../Received: ..." -- extracts error messages
   *
   * @param output  Raw test command output (stdout + stderr)
   * @returns Array of parsed FailedTest entries
   */
  parseTestOutput(output: string): FailedTest[] {
    const failed: FailedTest[] = [];

    // Jest/Vitest format: "FAIL src/path/to/test.ts"
    const failRegex = /FAIL\s+(\S+\.(?:ts|js|tsx|jsx))/g;
    let match: RegExpExecArray | null;
    while ((match = failRegex.exec(output)) !== null) {
      failed.push({
        testFile: match[1],
        testName: '',
        lineNumber: null,
        errorMessage: '',
      });
    }

    // Extract specific test names: "  x test name (42ms)"
    // or "  \u2715 test name"
    const testNameRegex = /[\u2715x]\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm;
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

// ============================================================================
// IntegrationTester
// ============================================================================

/**
 * Orchestrates integration test execution, failure attribution via
 * git log/blame, and the revision loop that re-dispatches agents
 * to fix broken tracks.
 *
 * Responsibilities:
 *   - Run integration tests on the merged integration branch
 *   - Attribute failing tests to responsible tracks using git history
 *   - Dispatch revision agents in fresh worktrees for broken tracks
 *   - Enforce circuit breakers: per-track revision limit, consecutive failure limit
 */
export class IntegrationTester {
  /** Per-track revision cycle counts. Key: trackName, Value: cycle count. */
  private revisionCounts = new Map<string, number>();

  /** Consecutive integration test failure count (resets on pass). */
  private consecutiveFailures = 0;

  /** Maximum consecutive failures before the circuit breaker trips. */
  private readonly maxConsecutiveFailures = 3;

  constructor(
    private config: ParallelConfig,
    private repoRoot: string,
    private eventBus: EventEmitter,
    private worktreeManager: WorktreeManager,
    private testRunner: TestRunner,
  ) {}

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Run integration tests on the integration branch.
   * Delegates to the injected TestRunner.
   */
  async runIntegrationTests(requestId: string): Promise<IntegrationTestResult> {
    const integrationBranch = integrationBranchName(requestId);
    return this.testRunner.run(this.repoRoot, integrationBranch);
  }

  /**
   * Run integration tests with automatic failure attribution and revision loop.
   *
   * Flow:
   *   1. Run tests
   *   2. If passed, reset consecutive failure count and return
   *   3. If failed, increment consecutive failures; trip circuit breaker if >= 3
   *   4. Attribute failures to tracks via git log/blame
   *   5. Trigger revision for each responsible (non-unknown) track
   *
   * The actual re-merge and re-test after revision is driven by the
   * engine orchestrator, which calls this method again after the revised
   * tracks complete.
   */
  async runIntegrationTestsWithRevision(
    requestId: string,
  ): Promise<IntegrationTestResult> {
    const result = await this.runIntegrationTests(requestId);

    if (result.passed) {
      this.consecutiveFailures = 0;
      return result;
    }

    this.consecutiveFailures++;

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.eventBus.emit('request.escalated', {
        type: 'request.escalated',
        requestId,
        reason: `Integration test circuit breaker: ${this.consecutiveFailures} consecutive failures`,
        timestamp: new Date().toISOString(),
      });
      throw new IntegrationTestCircuitBreakerError(
        requestId,
        this.consecutiveFailures,
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

  // --------------------------------------------------------------------------
  // Failure attribution
  // --------------------------------------------------------------------------

  /**
   * Map failing tests to responsible tracks by analyzing git history.
   *
   * Three strategies in order of priority:
   *   1. Test file attribution: which merge commit last modified the test file?
   *   2. Source code attribution: trace imports from test file, find modifying tracks
   *   3. Line-level blame: git blame on specific failing lines
   *
   * Falls back to "unknown" when no track can be identified.
   */
  async attributeFailures(
    requestId: string,
    failedTests: FailedTest[],
  ): Promise<Map<string, FailureAttribution[]>> {
    const integrationBranch = integrationBranchName(requestId);
    const baseBranch = this.config.base_branch;
    const attributions = new Map<string, FailureAttribution[]>();

    for (const test of failedTests) {
      const tracks = await this.findResponsibleTracks(
        requestId,
        test,
        integrationBranch,
        baseBranch,
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
          evidence: 'Identified via git log/blame analysis',
        });
      }
    }

    return attributions;
  }

  // --------------------------------------------------------------------------
  // Revision loop
  // --------------------------------------------------------------------------

  /**
   * Re-execute a track in a fresh worktree branched from the current
   * integration branch, with failure context provided to the agent.
   *
   * Enforces the per-track revision circuit breaker: max `max_revision_cycles`
   * revisions before escalation.
   *
   * @throws RevisionLimitExceededError when the track exceeds max_revision_cycles
   */
  async reviseTrack(
    requestId: string,
    trackName: string,
    failures: FailureAttribution[],
  ): Promise<void> {
    const currentCycle = (this.revisionCounts.get(trackName) ?? 0) + 1;
    this.revisionCounts.set(trackName, currentCycle);

    // Check revision loop circuit breaker
    if (currentCycle > this.config.max_revision_cycles) {
      this.eventBus.emit('request.escalated', {
        type: 'request.escalated',
        requestId,
        reason: `Track ${trackName} exceeded max revision cycles (${this.config.max_revision_cycles})`,
        timestamp: new Date().toISOString(),
      });
      throw new RevisionLimitExceededError(
        trackName,
        currentCycle,
        this.config.max_revision_cycles,
      );
    }

    // Create a fresh worktree for the revision, branched from current integration.
    // The revision track name includes the cycle number to avoid collisions.
    const revisionTrackName = `${trackName}-rev${currentCycle}`;
    await this.worktreeManager.createTrackWorktree(requestId, revisionTrackName);

    // Prepare failure context for the agent
    const _failureContext = this.buildFailureContext(failures);

    // Signal the scheduler to dispatch a new agent for this revision track.
    // The agent receives:
    //   1. The original spec
    //   2. The integration branch state (all other tracks' changes are visible)
    //   3. Failure output: specific test files, error messages, line numbers
    //   4. Instruction to fix the failing tests while preserving all other functionality
    this.eventBus.emit('track.state_changed', {
      type: 'track.state_changed',
      requestId,
      trackName: revisionTrackName,
      from: 'pending',
      to: 'queued',
      reason: `Revision cycle ${currentCycle}: fixing ${failures.length} test failures`,
      timestamp: new Date().toISOString(),
    });

    // The actual agent dispatch is handled by the scheduler/engine orchestrator.
    // This method prepares the revision and signals readiness.
  }

  /**
   * Get the current revision count for a track.
   * Exposed for testing and diagnostics.
   */
  getRevisionCount(trackName: string): number {
    return this.revisionCounts.get(trackName) ?? 0;
  }

  /**
   * Reset the consecutive failure counter.
   * Exposed for testing and diagnostics.
   */
  resetConsecutiveFailures(): void {
    this.consecutiveFailures = 0;
  }

  // --------------------------------------------------------------------------
  // Private: attribution strategies
  // --------------------------------------------------------------------------

  /**
   * Find which track(s) are responsible for a failing test.
   * Applies three strategies in order, stopping at the first that yields results.
   */
  private async findResponsibleTracks(
    _requestId: string,
    test: FailedTest,
    integrationBranch: string,
    baseBranch: string,
  ): Promise<string[]> {
    const tracks: Set<string> = new Set();

    // Strategy 1: Find which merge commits modified the test file
    try {
      const log = execSync(
        `git -C "${this.repoRoot}" log --oneline --merges ${baseBranch}..${integrationBranch} -- "${test.testFile}"`,
        { encoding: 'utf-8' },
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
          { encoding: 'utf-8' },
        );

        // Extract import paths (CommonJS require or ES import)
        const importRegex = /(?:import|require)\s*\(?['"](\.\/[^'"]+)['"]/g;
        let importMatch;
        while ((importMatch = importRegex.exec(testContent)) !== null) {
          const importPath = importMatch[1];
          // Resolve relative to test file directory
          const resolvedPath = path.join(path.dirname(test.testFile), importPath);

          // Find which merge commits modified this source file
          const sourceLog = execSync(
            `git -C "${this.repoRoot}" log --oneline --merges ${baseBranch}..${integrationBranch} -- "${resolvedPath}*"`,
            { encoding: 'utf-8' },
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
          { encoding: 'utf-8' },
        ).trim();

        // Extract commit SHA from blame output
        const commitSha = blame.split(' ')[0];
        if (commitSha && commitSha !== '00000000') {
          // Find which merge commit introduced this change
          const mergeLog = execSync(
            `git -C "${this.repoRoot}" log --merges --ancestry-path ${commitSha}..${integrationBranch} --format=%s -1`,
            { encoding: 'utf-8' },
          ).trim();

          const trackMatch = mergeLog.match(/merge:\s+(\S+)\s+into/);
          if (trackMatch) tracks.add(trackMatch[1]);
        }
      } catch {
        // blame failed
      }
    }

    // If still no attribution, attribute to all tracks as "unknown"
    if (tracks.size === 0) {
      tracks.add('unknown');
    }

    return Array.from(tracks);
  }

  // --------------------------------------------------------------------------
  // Private: failure context builder
  // --------------------------------------------------------------------------

  /**
   * Build a human-readable failure context string for the revision agent.
   * Includes test file names, test names, responsible tracks, and confidence.
   */
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
}
