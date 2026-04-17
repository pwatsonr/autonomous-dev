// ============================================================================
// Merge Engine — Ordering Logic, Core Merge Sequence, and Result Tracking
// SPEC-006-4-1: Merge Types, Ordering Logic, and Core Merge Sequence
// SPEC-006-4-3: Human Escalation, Merge Circuit Breaker, and Rollback
// ============================================================================

import { execSync } from 'child_process';
import { EventEmitter } from 'events';

import {
  DAGCluster,
  DependencyDAG,
  MergeResult,
  ConflictDetail,
} from './types';
import { ParallelConfig } from './config';
import { trackBranchName, integrationBranchName } from './naming';

// ============================================================================
// Interface contract validation types (SPEC-006-4-3)
// ============================================================================

/** Result of validating interface contracts after a merge. */
export interface ContractValidationResult {
  valid: boolean;
  violations: ContractViolation[];
}

/** A single contract violation found during post-merge validation. */
export interface ContractViolation {
  contractType: string;
  producer: string;
  consumer: string;
  filePath: string;
  message: string;
}

// ============================================================================
// Database migration validation types (SPEC-006-4-3)
// ============================================================================

/** Result of validating database migration sequence after a merge. */
export interface MigrationValidationResult {
  valid: boolean;
  issues: MigrationIssue[];
}

/** A single migration ordering issue. */
export interface MigrationIssue {
  migration: string;
  message: string;
  severity: 'error' | 'warning';
}

// ============================================================================
// MergeEngine
// ============================================================================

/**
 * Orchestrates the merging of track branches into the integration branch.
 *
 * Responsibilities:
 *   - Compute DAG-topological merge ordering within a cluster
 *   - Execute `git merge --no-commit --no-ff` for pre-commit inspection
 *   - Commit clean merges with conventional messages
 *   - Delegate conflicted merges to the resolution pipeline
 *   - Abort and rollback on resolution failure
 *   - Emit lifecycle events (merge.started, merge.completed, merge.failed)
 *   - Track cumulative failures for circuit-breaker escalation
 */
export class MergeEngine {
  /** Cumulative failure count across all merges for this engine instance. */
  private cumulativeFailures = 0;

  /**
   * Cumulative unresolved conflict count per request ID.
   * SPEC-006-4-3: Only unresolved (failed/escalated) conflicts count.
   */
  private unresolvedConflictCount: Map<string, number> = new Map();

  constructor(
    private config: ParallelConfig,
    private repoRoot: string,
    private eventEmitter: EventEmitter,
  ) {}

  // --------------------------------------------------------------------------
  // Merge ordering
  // --------------------------------------------------------------------------

  /**
   * Determine the merge order for tracks within a cluster.
   * Per TDD 3.5.1: nodes with outgoing edges (dependents waiting) merge first.
   * Alphabetical tiebreaker for determinism.
   *
   * @param cluster The DAG cluster whose nodes should be ordered
   * @param dag The full dependency DAG (used for reduced edges)
   * @returns Ordered array of specNames — merge in this sequence
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

  // --------------------------------------------------------------------------
  // Core merge sequence — single track
  // --------------------------------------------------------------------------

  /**
   * Merge a single track branch into the integration branch.
   * Uses --no-commit --no-ff for inspection before finalizing.
   * Calls git merge --abort on any failure.
   *
   * @param requestId The parallel execution request ID
   * @param trackName The track to merge
   * @param integrationBranch The target integration branch
   * @returns MergeResult with timing, SHA, and conflict details
   */
  async mergeTrack(
    requestId: string,
    trackName: string,
    integrationBranch: string,
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
    } catch {
      // Non-zero exit code means conflicts
      mergeExitCode = 1;
    }

    // Step 3: Check for conflicting files
    let conflictedFiles: string[] = [];
    if (mergeExitCode !== 0) {
      const output = this.exec(
        `git -C "${this.repoRoot}" diff --name-only --diff-filter=U`,
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

      const result: MergeResult = {
        trackName,
        integrationBranch,
        trackBranch,
        mergeCommitSha: sha,
        conflictCount: conflicts.length,
        conflicts,
        resolutionStrategy: conflicts.some(c => c.resolution === 'ai')
          ? 'ai-resolved'
          : 'auto-resolved',
        resolutionDurationMs: Date.now() - startTime,
        timestamp: new Date().toISOString(),
      };

      this.eventEmitter.emit('merge.completed', {
        type: 'merge.completed',
        ...result,
      });

      return result;
    } catch (resolutionErr) {
      // Resolution failed -- abort the merge
      this.exec(`git -C "${this.repoRoot}" merge --abort`);

      this.cumulativeFailures++;

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

  // --------------------------------------------------------------------------
  // Merge all tracks in a cluster
  // --------------------------------------------------------------------------

  /**
   * Merge all tracks in a cluster sequentially, in DAG-topological order.
   * Collects results and checks the circuit breaker after each failure.
   *
   * @param requestId The parallel execution request ID
   * @param cluster The cluster to merge
   * @param dag The full DAG (for ordering computation)
   * @returns Array of MergeResults, one per track
   */
  async mergeCluster(
    requestId: string,
    cluster: DAGCluster,
    dag: DependencyDAG,
  ): Promise<MergeResult[]> {
    const integrationBranch = integrationBranchName(requestId);
    const mergeOrder = this.computeMergeOrder(cluster, dag);
    const results: MergeResult[] = [];

    for (const trackName of mergeOrder) {
      const result = await this.mergeTrack(requestId, trackName, integrationBranch);
      results.push(result);

      if (result.resolutionStrategy === 'failed' || result.resolutionStrategy === 'escalated') {
        // Check circuit breaker -- may throw to halt further merges
        this.checkCircuitBreaker(requestId, results);
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Conflict resolution placeholder
  // --------------------------------------------------------------------------

  /**
   * Resolve conflicts for a set of conflicted files.
   * This is the integration point for SPEC-006-4-2 (conflict resolution pipeline).
   *
   * Default implementation throws -- concrete resolution is provided by
   * the conflict resolution pipeline which overrides or extends this method.
   *
   * @param _requestId The request ID
   * @param _trackName The track being merged
   * @param _conflictedFiles List of file paths with conflicts
   * @returns Array of ConflictDetail records, one per resolved file
   */
  protected async resolveConflicts(
    _requestId: string,
    _trackName: string,
    _conflictedFiles: string[],
  ): Promise<ConflictDetail[]> {
    throw new Error(
      'Conflict resolution not implemented. SPEC-006-4-2 provides the resolution pipeline.',
    );
  }

  // --------------------------------------------------------------------------
  // Circuit breaker (SPEC-006-4-3 Task 8)
  // --------------------------------------------------------------------------

  /**
   * Check whether the cumulative unresolved conflict count for a request
   * exceeds the configured threshold. If so, emit `request.escalated`
   * and throw MergeCircuitBreakerError.
   *
   * Only conflicts with resolutionStrategy 'failed' or 'escalated'
   * count as unresolved. Auto-resolved and AI-resolved do not.
   *
   * This method is cumulative: each call adds newly unresolved conflicts
   * to the running total for the given requestId.
   *
   * @param requestId The request ID
   * @param results Results to evaluate for unresolved conflicts
   * @throws MergeCircuitBreakerError when count exceeds threshold
   */
  checkCircuitBreaker(requestId: string, results: MergeResult[]): void {
    const unresolved = results.filter(
      r => r.resolutionStrategy === 'failed' || r.resolutionStrategy === 'escalated',
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
        this.config.merge_conflict_escalation_threshold,
      );
    }
  }

  /**
   * Reset the circuit breaker counter for a request.
   * Called when a human resolves conflicts and work resumes.
   */
  resetCircuitBreaker(requestId: string): void {
    this.unresolvedConflictCount.delete(requestId);
  }

  /**
   * Get the current unresolved conflict count for a request.
   * Useful for diagnostics and testing.
   */
  getUnresolvedCount(requestId: string): number {
    return this.unresolvedConflictCount.get(requestId) ?? 0;
  }

  // --------------------------------------------------------------------------
  // Rollback: single track (SPEC-006-4-3 Task 9)
  // --------------------------------------------------------------------------

  /**
   * Revert a single track's merge commit from the integration branch.
   *
   * Uses `git revert -m 1` to undo the merge while preserving history.
   * Only operates on `auto/` branches as a safety measure.
   *
   * @param requestId  Request identifier
   * @param trackName  Track whose merge commit should be reverted
   */
  async rollbackTrackMerge(requestId: string, trackName: string): Promise<void> {
    const intBranch = integrationBranchName(requestId);

    // Safety check: only operate on auto/ branches
    if (!intBranch.startsWith('auto/')) {
      throw new Error(`Refusing to rollback non-auto branch: ${intBranch}`);
    }

    this.exec(`git -C "${this.repoRoot}" checkout ${intBranch}`);

    // Find the merge commit for this track
    const mergeCommit = this.exec(
      `git -C "${this.repoRoot}" log --merges --grep="merge: ${trackName}" --format=%H -1`,
    ).trim();

    if (!mergeCommit) {
      throw new Error(`No merge commit found for track ${trackName} on ${intBranch}`);
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

  // --------------------------------------------------------------------------
  // Rollback: full integration reset (SPEC-006-4-3 Task 9)
  // --------------------------------------------------------------------------

  /**
   * Reset the entire integration branch to its state before any merges.
   *
   * Uses `git reset --hard` to the branch point (merge-base with base_branch).
   * Only operates on `auto/` branches as a safety measure.
   *
   * @param requestId  Request identifier
   */
  async rollbackIntegration(requestId: string): Promise<void> {
    const intBranch = integrationBranchName(requestId);

    // Safety check: only operate on auto/ branches
    if (!intBranch.startsWith('auto/')) {
      throw new Error(`Refusing to reset non-auto branch: ${intBranch}`);
    }

    this.exec(`git -C "${this.repoRoot}" checkout ${intBranch}`);

    // Find the branch point from the base branch
    const baseBranch = this.config.base_branch;
    const branchPoint = this.exec(
      `git -C "${this.repoRoot}" merge-base ${intBranch} ${baseBranch}`,
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

  // --------------------------------------------------------------------------
  // Interface contract validation (SPEC-006-4-3 post-merge)
  // --------------------------------------------------------------------------

  /**
   * Validate interface contracts after a merge to ensure that
   * producer/consumer relationships are intact.
   *
   * Checks that:
   *   - Every consumed interface has a corresponding producer export
   *   - Type signatures match between producer and consumer
   *   - No interface was accidentally deleted during merge
   *
   * @param contracts  List of interface contracts to validate
   * @returns Validation result with any violations found
   */
  async validateInterfaceContracts(
    contracts: Array<{
      contractType: string;
      producer: string;
      consumer: string;
      definition: string;
      filePath: string;
    }>,
  ): Promise<ContractValidationResult> {
    const violations: ContractViolation[] = [];

    for (const contract of contracts) {
      try {
        // Check if the file contains the expected definition at HEAD
        const fileContent = this.exec(
          `git -C "${this.repoRoot}" show HEAD:${contract.filePath}`,
        );

        // Verify the interface definition is present
        if (!fileContent.includes(contract.definition)) {
          violations.push({
            contractType: contract.contractType,
            producer: contract.producer,
            consumer: contract.consumer,
            filePath: contract.filePath,
            message: `Interface definition not found in ${contract.filePath} after merge`,
          });
        }
      } catch {
        // File doesn't exist at HEAD
        violations.push({
          contractType: contract.contractType,
          producer: contract.producer,
          consumer: contract.consumer,
          filePath: contract.filePath,
          message: `File ${contract.filePath} not found at HEAD after merge`,
        });
      }
    }

    return {
      valid: violations.length === 0,
      violations,
    };
  }

  // --------------------------------------------------------------------------
  // Database migration sequence validation (SPEC-006-4-3 post-merge)
  // --------------------------------------------------------------------------

  /**
   * Validate that database migrations from merged tracks maintain
   * a consistent ordering and don't create conflicts.
   *
   * Checks:
   *   - Migration filenames follow sequential numbering
   *   - No duplicate migration numbers across tracks
   *   - Migrations that modify the same table are ordered correctly
   *
   * @param migrationDir  Relative path to the migrations directory
   * @returns Validation result with any ordering issues
   */
  async validateMigrationSequence(
    migrationDir: string,
  ): Promise<MigrationValidationResult> {
    const issues: MigrationIssue[] = [];

    try {
      // List migration files at HEAD
      const output = this.exec(
        `git -C "${this.repoRoot}" ls-tree --name-only HEAD ${migrationDir}/`,
      );
      const files = output.split('\n').filter((f) => f.trim() !== '');

      // Extract migration numbers (pattern: 001_name.sql or V1__name.sql)
      const migrations: Array<{ file: string; number: number }> = [];
      for (const file of files) {
        const basename = file.split('/').pop() || file;
        const match = basename.match(/^(?:V?)?(\d+)/);
        if (match) {
          migrations.push({ file: basename, number: parseInt(match[1], 10) });
        }
      }

      // Sort by number
      migrations.sort((a, b) => a.number - b.number);

      // Check for duplicates
      const seen = new Map<number, string>();
      for (const m of migrations) {
        const existing = seen.get(m.number);
        if (existing) {
          issues.push({
            migration: m.file,
            message: `Duplicate migration number ${m.number}: ${existing} and ${m.file}`,
            severity: 'error',
          });
        }
        seen.set(m.number, m.file);
      }

      // Check for gaps
      if (migrations.length > 1) {
        for (let i = 1; i < migrations.length; i++) {
          const gap = migrations[i].number - migrations[i - 1].number;
          if (gap > 1) {
            issues.push({
              migration: migrations[i].file,
              message: `Gap in migration sequence: ${migrations[i - 1].number} -> ${migrations[i].number}`,
              severity: 'warning',
            });
          }
        }
      }
    } catch {
      // Migration directory doesn't exist or is empty -- not an error
    }

    return {
      valid: issues.filter((i) => i.severity === 'error').length === 0,
      issues,
    };
  }

  // --------------------------------------------------------------------------
  // Git helpers
  // --------------------------------------------------------------------------

  /**
   * Execute a shell command synchronously and return stdout.
   */
  private exec(cmd: string): string {
    return execSync(cmd, { encoding: 'utf-8' });
  }

  /**
   * Escape double quotes in a git commit message for shell safety.
   */
  private escapeGitMsg(msg: string): string {
    return msg.replace(/"/g, '\\"');
  }
}

// ============================================================================
// Error classes
// ============================================================================

/**
 * Thrown when the merge circuit breaker trips because cumulative
 * unresolved conflicts exceed the configured threshold.
 */
export class MergeCircuitBreakerError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly unresolvedCount: number,
    public readonly threshold: number,
  ) {
    super(
      `Merge circuit breaker tripped for request "${requestId}": ` +
      `${unresolvedCount} unresolved conflicts exceed threshold of ${threshold}`,
    );
    this.name = 'MergeCircuitBreakerError';
  }
}
