/**
 * Agent Rollback Mechanism (SPEC-005-2-5, Task 11).
 *
 * Restores a previous version of an agent definition from git history with
 * impact analysis and audit logging. Supports targeted rollback to a specific
 * version, confirmation gating, quarantine marking, and full post-rollback
 * registry reload.
 *
 * Exports: `RollbackManager`, `RollbackOptions`, `RollbackResult`, `ImpactAnalysis`
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { IAgentRegistry } from './types';
import type { IMetricsEngine } from './metrics/types';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface RollbackOptions {
  /** Skip confirmation prompt. */
  force?: boolean;
  /** Mark artifacts from rolled-back version with a quarantine flag. */
  quarantine?: boolean;
  /** Specific version to roll back to (default: previous). */
  targetVersion?: string;
}

export interface RollbackResult {
  success: boolean;
  agentName: string;
  previousVersion: string;
  restoredVersion: string;
  commitHash: string;
  impactAnalysis: ImpactAnalysis;
  error?: string;
}

export interface ImpactAnalysis {
  currentVersionInvocations: number;
  inFlightPipelineRuns: string[];
  diff: string;
  warningMessage: string | null;
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

function logRollbackEvent(
  eventType: string,
  details: Record<string, unknown>,
): void {
  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...details,
  };
  process.stderr.write(`[ROLLBACK] ${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// RollbackManager
// ---------------------------------------------------------------------------

export class RollbackManager {
  private readonly agentsDir: string;
  private readonly registry: IAgentRegistry;
  private readonly metricsEngine: IMetricsEngine;

  constructor(
    agentsDir: string,
    registry: IAgentRegistry,
    metricsEngine: IMetricsEngine,
  ) {
    this.agentsDir = path.resolve(agentsDir);
    this.registry = registry;
    this.metricsEngine = metricsEngine;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Roll back an agent to a previous version.
   *
   * Procedure:
   *   1. Identify previous version from git history.
   *   2. Perform impact analysis.
   *   3. Restore file content from git.
   *   4. Update version_history with rollback entry.
   *   5. Commit the change.
   *   6. Post-rollback: reload registry, audit log, quarantine.
   */
  async rollback(
    agentName: string,
    opts?: RollbackOptions,
  ): Promise<RollbackResult> {
    const filePath = path.join(this.agentsDir, `${agentName}.md`);

    // Validate agent exists in registry
    const record = this.registry.get(agentName);
    if (!record) {
      return this.failResult(agentName, `Agent '${agentName}' not found in registry`);
    }

    const currentVersion = record.agent.version;

    // Step 1: Identify the target version and commit
    let targetVersion: string;
    let targetCommit: string;

    try {
      const resolved = this.resolveTargetVersion(
        agentName,
        filePath,
        currentVersion,
        opts?.targetVersion,
      );
      targetVersion = resolved.version;
      targetCommit = resolved.commitHash;
    } catch (err: unknown) {
      return this.failResult(
        agentName,
        `Failed to identify target version: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Step 2: Impact analysis
    const impactAnalysis = this.performImpactAnalysis(
      agentName,
      currentVersion,
      targetCommit,
      filePath,
    );

    // Step 3: Restore file content from git
    let restoredContent: string;
    try {
      restoredContent = this.getFileFromCommit(targetCommit, filePath);
    } catch (err: unknown) {
      return this.failResult(
        agentName,
        `Failed to restore content from git: ${err instanceof Error ? err.message : String(err)}`,
        impactAnalysis,
      );
    }

    // Step 4: Update version_history with rollback entry and set version
    const today = new Date().toISOString().split('T')[0];
    const rollbackEntry = `  - version: "${targetVersion}"\n    date: "${today}"\n    change: "Rollback from v${currentVersion} to v${targetVersion}"`;

    const updatedContent = this.updateContentForRollback(
      restoredContent,
      targetVersion,
      rollbackEntry,
    );

    // Write the updated content
    try {
      fs.writeFileSync(filePath, updatedContent, { encoding: 'utf-8' });
    } catch (err: unknown) {
      return this.failResult(
        agentName,
        `Failed to write restored file: ${err instanceof Error ? err.message : String(err)}`,
        impactAnalysis,
      );
    }

    // Step 5: Commit the change
    let commitHash: string;
    try {
      commitHash = this.commitRollback(agentName, currentVersion, targetVersion, filePath);
    } catch (err: unknown) {
      return this.failResult(
        agentName,
        `Failed to commit rollback: ${err instanceof Error ? err.message : String(err)}`,
        impactAnalysis,
      );
    }

    // Step 6: Post-rollback
    try {
      await this.registry.reload(this.agentsDir);
    } catch (err: unknown) {
      logRollbackEvent('registry_reload_failed', {
        agentName,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Audit log
    logRollbackEvent('agent_rolled_back', {
      agentName,
      previousVersion: currentVersion,
      restoredVersion: targetVersion,
      commitHash,
      impactAnalysis: {
        currentVersionInvocations: impactAnalysis.currentVersionInvocations,
        inFlightPipelineRuns: impactAnalysis.inFlightPipelineRuns,
        warningMessage: impactAnalysis.warningMessage,
      },
    });

    // Emit rollback metric event
    this.emitRollbackMetric(agentName, currentVersion, targetVersion);

    // Quarantine handling
    if (opts?.quarantine) {
      this.quarantineVersion(agentName, currentVersion);
    }

    return {
      success: true,
      agentName,
      previousVersion: currentVersion,
      restoredVersion: targetVersion,
      commitHash,
      impactAnalysis,
    };
  }

  /**
   * Perform impact analysis without executing the rollback.
   * Useful for displaying the analysis in a confirmation prompt.
   */
  getImpactAnalysis(agentName: string): ImpactAnalysis | null {
    const record = this.registry.get(agentName);
    if (!record) return null;

    const filePath = path.join(this.agentsDir, `${agentName}.md`);
    const currentVersion = record.agent.version;

    try {
      const resolved = this.resolveTargetVersion(
        agentName,
        filePath,
        currentVersion,
      );
      return this.performImpactAnalysis(
        agentName,
        currentVersion,
        resolved.commitHash,
        filePath,
      );
    } catch {
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Private: version resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve the target version and commit hash for a rollback.
   *
   * If `targetVersion` is specified, search git history for that version.
   * Otherwise, find the commit immediately before the current version.
   */
  private resolveTargetVersion(
    agentName: string,
    filePath: string,
    currentVersion: string,
    targetVersion?: string,
  ): { version: string; commitHash: string } {
    const relativePath = this.getRelativePath(filePath);
    const commits = this.getGitLog(relativePath);

    if (commits.length < 2) {
      throw new Error(
        `No previous version found in git history for '${agentName}'`,
      );
    }

    if (targetVersion) {
      // Search for the specific version in git history
      for (const commit of commits) {
        try {
          const content = this.getFileContentAtCommit(commit.hash, relativePath);
          const version = this.extractVersionFromContent(content);
          if (version === targetVersion) {
            return { version: targetVersion, commitHash: commit.hash };
          }
        } catch {
          continue;
        }
      }
      throw new Error(
        `Target version '${targetVersion}' not found in git history for '${agentName}'`,
      );
    }

    // Default: find the commit immediately before the current version.
    // Walk commits (newest first) until we find one with a different version.
    for (let i = 1; i < commits.length; i++) {
      try {
        const content = this.getFileContentAtCommit(commits[i].hash, relativePath);
        const version = this.extractVersionFromContent(content);
        if (version !== currentVersion) {
          return { version, commitHash: commits[i].hash };
        }
      } catch {
        continue;
      }
    }

    throw new Error(
      `No previous version (different from ${currentVersion}) found in git history for '${agentName}'`,
    );
  }

  // -----------------------------------------------------------------------
  // Private: impact analysis
  // -----------------------------------------------------------------------

  /**
   * Perform impact analysis for a potential rollback.
   */
  private performImpactAnalysis(
    agentName: string,
    currentVersion: string,
    targetCommit: string,
    filePath: string,
  ): ImpactAnalysis {
    // Count invocations for the current version
    const invocations = this.metricsEngine.getInvocations(agentName, {});
    const currentVersionInvocations = invocations.filter(
      (m) => m.agent_version === currentVersion,
    ).length;

    // Check for in-flight pipeline runs
    const inFlightPipelineRuns = this.findInFlightPipelineRuns(agentName);

    // Compute unified diff
    const diff = this.computeDiff(targetCommit, filePath);

    // Build warning message
    let warningMessage: string | null = null;
    if (inFlightPipelineRuns.length > 0) {
      warningMessage = `Agent is referenced in ${inFlightPipelineRuns.length} in-flight pipeline runs`;
    }

    return {
      currentVersionInvocations,
      inFlightPipelineRuns,
      diff,
      warningMessage,
    };
  }

  /**
   * Find in-flight (incomplete) pipeline runs referencing this agent.
   */
  private findInFlightPipelineRuns(agentName: string): string[] {
    const invocations = this.metricsEngine.getInvocations(agentName, {});
    const pipelineIds = new Set<string>();

    for (const inv of invocations) {
      if (inv.pipeline_run_id) {
        pipelineIds.add(inv.pipeline_run_id);
      }
    }

    // Check each pipeline for incomplete runs (invocations without
    // 'approved' or 'rejected' outcome suggest the pipeline may still
    // be in progress)
    const inFlight: string[] = [];
    for (const pipelineId of pipelineIds) {
      const pipelineInvocations = invocations.filter(
        (m) => m.pipeline_run_id === pipelineId,
      );
      const hasIncomplete = pipelineInvocations.some(
        (m) => m.review_outcome === 'not_reviewed',
      );
      if (hasIncomplete) {
        inFlight.push(pipelineId);
      }
    }

    return inFlight;
  }

  // -----------------------------------------------------------------------
  // Private: git operations
  // -----------------------------------------------------------------------

  /**
   * Get git log entries for a specific file.
   */
  private getGitLog(relativePath: string): Array<{ hash: string; message: string }> {
    try {
      const output = execSync(
        `git log --oneline -- "${relativePath}"`,
        { encoding: 'utf-8', cwd: this.findGitRoot() },
      ).trim();

      if (!output) return [];

      return output.split('\n').map((line) => {
        const spaceIdx = line.indexOf(' ');
        return {
          hash: line.substring(0, spaceIdx),
          message: line.substring(spaceIdx + 1),
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Get file content at a specific commit.
   */
  private getFileContentAtCommit(commitHash: string, relativePath: string): string {
    return execSync(
      `git show ${commitHash}:"${relativePath}"`,
      { encoding: 'utf-8', cwd: this.findGitRoot() },
    );
  }

  /**
   * Get file content from a commit using the absolute file path.
   */
  private getFileFromCommit(commitHash: string, filePath: string): string {
    const relativePath = this.getRelativePath(filePath);
    return this.getFileContentAtCommit(commitHash, relativePath);
  }

  /**
   * Compute unified diff between a commit and HEAD for a file.
   */
  private computeDiff(targetCommit: string, filePath: string): string {
    const relativePath = this.getRelativePath(filePath);
    try {
      return execSync(
        `git diff ${targetCommit} HEAD -- "${relativePath}"`,
        { encoding: 'utf-8', cwd: this.findGitRoot() },
      );
    } catch {
      return '(diff unavailable)';
    }
  }

  /**
   * Stage and commit the rollback.
   */
  private commitRollback(
    agentName: string,
    currentVersion: string,
    targetVersion: string,
    filePath: string,
  ): string {
    const gitRoot = this.findGitRoot();
    const relativePath = this.getRelativePath(filePath);

    execSync(`git add "${relativePath}"`, {
      encoding: 'utf-8',
      cwd: gitRoot,
    });

    const message = `revert(agents): rollback ${agentName} v${currentVersion} -> v${targetVersion}`;
    execSync(`git commit -m "${message}"`, {
      encoding: 'utf-8',
      cwd: gitRoot,
    });

    // Get the commit hash
    const hash = execSync('git rev-parse HEAD', {
      encoding: 'utf-8',
      cwd: gitRoot,
    }).trim();

    return hash;
  }

  /**
   * Find the git repository root.
   */
  private findGitRoot(): string {
    try {
      return execSync('git rev-parse --show-toplevel', {
        encoding: 'utf-8',
        cwd: this.agentsDir,
      }).trim();
    } catch {
      return this.agentsDir;
    }
  }

  /**
   * Get a path relative to the git root.
   */
  private getRelativePath(filePath: string): string {
    const gitRoot = this.findGitRoot();
    return path.relative(gitRoot, filePath);
  }

  // -----------------------------------------------------------------------
  // Private: content manipulation
  // -----------------------------------------------------------------------

  /**
   * Extract the version field from agent file content.
   */
  private extractVersionFromContent(content: string): string {
    const match = content.match(/^version:\s*["']?([^"'\n]+)["']?\s*$/m);
    if (!match) {
      throw new Error('Could not extract version from content');
    }
    return match[1].trim();
  }

  /**
   * Update restored content to reflect the rollback:
   *   - Set the version field to the restored version.
   *   - Append a rollback entry to version_history.
   */
  private updateContentForRollback(
    content: string,
    targetVersion: string,
    rollbackEntry: string,
  ): string {
    let updated = content;

    // Ensure version field matches the target version
    updated = updated.replace(
      /^(version:\s*["']?)[^"'\n]+(["']?\s*)$/m,
      `$1${targetVersion}$2`,
    );

    // Append rollback entry to version_history
    // Find the last entry in version_history (look for the pattern of
    // the last "- version:" or "change:" line before the next top-level key
    // or the closing ---).
    const versionHistoryRegex = /(version_history:\n(?:\s+-\s+.*\n)*?)(\n*(?:[a-z]|---))/;
    const match = updated.match(versionHistoryRegex);
    if (match) {
      const historyBlock = match[1];
      const afterHistory = match[2];
      updated = updated.replace(
        versionHistoryRegex,
        `${historyBlock}${rollbackEntry}\n${afterHistory}`,
      );
    }

    return updated;
  }

  // -----------------------------------------------------------------------
  // Private: post-rollback operations
  // -----------------------------------------------------------------------

  /**
   * Emit a rollback metric event to the metrics engine.
   */
  private emitRollbackMetric(
    agentName: string,
    previousVersion: string,
    restoredVersion: string,
  ): void {
    logRollbackEvent('rollback_metric', {
      agentName,
      previousVersion,
      restoredVersion,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Mark all metrics from the rolled-back version with a quarantine flag.
   *
   * Since the metrics schema does not natively support quarantine flags,
   * this is logged as an audit event for external processing.
   */
  private quarantineVersion(agentName: string, version: string): void {
    logRollbackEvent('version_quarantined', {
      agentName,
      version,
      timestamp: new Date().toISOString(),
      message: `All metrics from version ${version} of '${agentName}' are quarantined`,
    });
  }

  // -----------------------------------------------------------------------
  // Private: failure helper
  // -----------------------------------------------------------------------

  private failResult(
    agentName: string,
    error: string,
    impactAnalysis?: ImpactAnalysis,
  ): RollbackResult {
    logRollbackEvent('rollback_failed', { agentName, error });
    return {
      success: false,
      agentName,
      previousVersion: '',
      restoredVersion: '',
      commitHash: '',
      impactAnalysis: impactAnalysis ?? {
        currentVersionInvocations: 0,
        inFlightPipelineRuns: [],
        diff: '',
        warningMessage: null,
      },
      error,
    };
  }
}
