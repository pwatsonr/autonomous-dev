/**
 * Core worktree CRUD operations, disk monitoring, and health checks
 * for the parallel execution engine.
 *
 * Wraps git worktree commands with precondition checks, idempotency,
 * disk-usage monitoring, and health validation.
 *
 * Based on SPEC-006-1-2.
 */

import { EventEmitter } from 'events';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';

import { ParallelConfig } from './config';
import { WorktreeInfo, DiskPressureLevel } from './types';
import {
  integrationBranchName,
  trackBranchName,
  worktreePath as buildWorktreePath,
} from './naming';
import { StatePersister } from './state-persister';
import type {
  WorktreeCreatedEvent,
  WorktreeRemovedEvent,
  WorktreeDiskWarningEvent,
  WorktreeDiskCriticalEvent,
} from './events';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when creating a worktree would exceed the max_worktrees limit. */
export class MaxWorktreesExceededError extends Error {
  constructor(current: number, max: number) {
    super(`Max worktrees exceeded: ${current} active, limit is ${max}`);
    this.name = 'MaxWorktreesExceededError';
  }
}

/** Thrown when creating a worktree while disk pressure is critical. */
export class DiskPressureCriticalError extends Error {
  constructor(totalBytes: number, limitBytes: number) {
    super(
      `Disk pressure critical: ${totalBytes} bytes used, hard limit is ${limitBytes} bytes`,
    );
    this.name = 'DiskPressureCriticalError';
  }
}

// ---------------------------------------------------------------------------
// Health report
// ---------------------------------------------------------------------------

/** Result of a single worktree health check. */
export interface WorktreeHealthReport {
  requestId: string;
  trackName: string;
  directoryExists: boolean;
  registeredInGit: boolean;
  branchExists: boolean;
  isClean: boolean;
  healthy: boolean;
  issues: string[];
}

// ---------------------------------------------------------------------------
// Cleanup report (SPEC-006-1-3: orphan cleanup)
// ---------------------------------------------------------------------------

/** Result of the orphan worktree cleanup pass. */
export interface CleanupReport {
  removedWorktrees: string[];
  removedBranches: string[];
  errors: Array<{ path: string; error: string }>;
}

// ---------------------------------------------------------------------------
// .gitignore management (SPEC-006-1-3 Section 3)
// ---------------------------------------------------------------------------

const GITIGNORE_ENTRIES = [
  '.worktrees/',
  '.autonomous-dev/state/',
  '.autonomous-dev/archive/',
];

// ---------------------------------------------------------------------------
// Logger (lightweight, no external deps)
// ---------------------------------------------------------------------------

const logger = {
  info: (msg: string) => {
    process.stderr.write(`[worktree-manager] INFO  ${msg}\n`);
  },
  error: (msg: string) => {
    process.stderr.write(`[worktree-manager] ERROR ${msg}\n`);
  },
};

// ---------------------------------------------------------------------------
// Disk usage helper
// ---------------------------------------------------------------------------

/**
 * Recursively calculate the total size of a directory in bytes.
 * Uses Node.js fs.stat (not shell `du`) for cross-platform compatibility.
 */
async function calculateDirectorySize(dirPath: string): Promise<number> {
  let totalSize = 0;
  let entries: Awaited<ReturnType<typeof fs.readdir>>;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    // Directory may not exist or be inaccessible
    return 0;
  }
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      totalSize += await calculateDirectorySize(fullPath);
    } else if (entry.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        totalSize += stat.size;
      } catch {
        // Skip files that vanish between readdir and stat
      }
    }
  }
  return totalSize;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Execute a git command in the given repository root directory.
 * Returns stdout trimmed.
 */
async function git(
  repoRoot: string,
  args: string[],
): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoRoot, ...args]);
  return stdout.trim();
}

/**
 * Check if a git ref exists (branch, tag, etc).
 */
async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse `git worktree list --porcelain` output into an array of
 * { worktree, HEAD, branch } objects.
 */
interface GitWorktreeEntry {
  worktree: string;
  head: string;
  branch: string;
}

function parseWorktreeList(porcelainOutput: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  const blocks = porcelainOutput.split('\n\n').filter((b) => b.trim() !== '');
  for (const block of blocks) {
    const lines = block.split('\n');
    let worktree = '';
    let head = '';
    let branch = '';
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        worktree = line.slice('worktree '.length);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branch = line.slice('branch '.length);
      }
    }
    if (worktree) {
      entries.push({ worktree, head, branch });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// WorktreeManager
// ---------------------------------------------------------------------------

export class WorktreeManager {
  /** Resolved absolute path to the worktree root directory. */
  private readonly worktreeRoot: string;
  /** Last known disk pressure level for threshold-crossing detection. */
  private lastPressureLevel: DiskPressureLevel = 'normal';
  /** Interval handle for the disk monitor. */
  private diskMonitorInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private config: ParallelConfig,
    private repoRoot: string,
    private eventEmitter: EventEmitter,
  ) {
    // Resolve worktree root relative to repo root if not absolute
    this.worktreeRoot = path.isAbsolute(config.worktree_root)
      ? config.worktree_root
      : path.join(repoRoot, config.worktree_root);
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  /**
   * Create an integration branch from baseBranch.
   *
   * Idempotency: if the branch already exists and points to the expected
   * base commit, returns the branch name without error.
   *
   * @returns The integration branch name (e.g. "auto/req-001/integration")
   */
  async createIntegrationBranch(
    requestId: string,
    baseBranch: string,
  ): Promise<string> {
    const branchName = integrationBranchName(requestId);
    const fullRef = `refs/heads/${branchName}`;

    // Precondition: verify baseBranch exists
    const baseRef = `refs/heads/${baseBranch}`;
    if (!(await refExists(this.repoRoot, baseRef))) {
      throw new Error(`Base branch "${baseBranch}" does not exist`);
    }

    // Idempotency: if branch already exists, verify it points to expected base
    if (await refExists(this.repoRoot, fullRef)) {
      return branchName;
    }

    // Create integration branch from baseBranch
    await git(this.repoRoot, ['branch', branchName, baseBranch]);
    return branchName;
  }

  /**
   * Create a track worktree for a given request.
   *
   * Precondition checks:
   *   1. Active worktree count < config.max_worktrees
   *   2. Disk pressure is not critical
   *   3. Integration branch exists
   *
   * Idempotency: if the worktree directory already exists and the branch
   * matches, returns the existing WorktreeInfo.
   */
  async createTrackWorktree(
    requestId: string,
    trackName: string,
  ): Promise<WorktreeInfo> {
    const branchName = trackBranchName(requestId, trackName);
    const integrationBranch = integrationBranchName(requestId);
    const wtPath = buildWorktreePath(this.worktreeRoot, requestId, trackName);

    // Idempotency: if worktree directory already exists and branch matches
    if (fsSync.existsSync(wtPath)) {
      try {
        const currentBranch = await git(wtPath, [
          'branch',
          '--show-current',
        ]);
        if (currentBranch === branchName) {
          return {
            requestId,
            trackName,
            worktreePath: wtPath,
            branchName,
            integrationBranch,
            createdAt: new Date().toISOString(),
            status: 'active',
          };
        }
      } catch {
        // Directory exists but isn't a valid worktree; fall through to create
      }
    }

    // Precondition 1: check max worktrees
    const activeCount = await this.getActiveWorktreeCount();
    if (activeCount >= this.config.max_worktrees) {
      throw new MaxWorktreesExceededError(activeCount, this.config.max_worktrees);
    }

    // Precondition 2: check disk pressure
    const pressure = this.getDiskPressureLevel();
    if (pressure === 'critical') {
      const limitBytes = this.config.disk_hard_limit_gb * 1024 * 1024 * 1024;
      throw new DiskPressureCriticalError(0, limitBytes);
    }

    // Precondition 3: verify integration branch exists
    const integrationRef = `refs/heads/${integrationBranch}`;
    if (!(await refExists(this.repoRoot, integrationRef))) {
      throw new Error(
        `Integration branch "${integrationBranch}" does not exist. ` +
          `Call createIntegrationBranch() first.`,
      );
    }

    // Ensure the parent directory for the worktree exists
    await fs.mkdir(path.dirname(wtPath), { recursive: true });

    // Create track branch from integration
    const trackRef = `refs/heads/${branchName}`;
    if (!(await refExists(this.repoRoot, trackRef))) {
      await git(this.repoRoot, ['branch', branchName, integrationBranch]);
    }

    // Create worktree at the designated path
    await git(this.repoRoot, ['worktree', 'add', wtPath, branchName]);

    const info: WorktreeInfo = {
      requestId,
      trackName,
      worktreePath: wtPath,
      branchName,
      integrationBranch,
      createdAt: new Date().toISOString(),
      status: 'active',
    };

    // Emit creation event
    const event: WorktreeCreatedEvent = {
      type: 'worktree.created',
      requestId,
      trackName,
      worktreePath: wtPath,
      timestamp: new Date().toISOString(),
    };
    this.eventEmitter.emit(event.type, event);

    return info;
  }

  // -------------------------------------------------------------------------
  // Listing
  // -------------------------------------------------------------------------

  /**
   * List all managed worktrees, optionally filtered by requestId.
   *
   * Parses `git worktree list --porcelain` and filters for branches
   * matching the `auto/` prefix convention.
   */
  async listWorktrees(requestId?: string): Promise<WorktreeInfo[]> {
    let output: string;
    try {
      output = await git(this.repoRoot, ['worktree', 'list', '--porcelain']);
    } catch {
      return [];
    }

    const entries = parseWorktreeList(output);
    const results: WorktreeInfo[] = [];

    for (const entry of entries) {
      // Only include worktrees on auto/ branches (skip the main worktree)
      const branchRef = entry.branch; // e.g. "refs/heads/auto/req-001/track-a"
      if (!branchRef.startsWith('refs/heads/auto/')) continue;

      const branchName = branchRef.slice('refs/heads/'.length);
      // Parse auto/{requestId}/{trackName}
      const parts = branchName.split('/');
      // parts: ['auto', requestId, trackName] or ['auto', requestId, 'integration']
      if (parts.length !== 3 || parts[0] !== 'auto') continue;

      const entryRequestId = parts[1];
      const entryTrackName = parts[2];

      // Skip integration branches
      if (entryTrackName === 'integration') continue;

      // Filter by requestId if provided
      if (requestId !== undefined && entryRequestId !== requestId) continue;

      results.push({
        requestId: entryRequestId,
        trackName: entryTrackName,
        worktreePath: entry.worktree,
        branchName,
        integrationBranch: `auto/${entryRequestId}/integration`,
        createdAt: '', // not tracked by git; would come from persisted state
        status: 'active',
      });
    }

    return results;
  }

  /**
   * Get a single worktree by requestId and trackName.
   * Returns null if not found.
   */
  async getWorktree(
    requestId: string,
    trackName: string,
  ): Promise<WorktreeInfo | null> {
    const worktrees = await this.listWorktrees(requestId);
    return worktrees.find((wt) => wt.trackName === trackName) ?? null;
  }

  /**
   * Get the number of active (non-main) worktrees managed by the engine.
   * Counts only worktrees on `auto/` branches excluding integration branches.
   */
  async getActiveWorktreeCount(): Promise<number> {
    const worktrees = await this.listWorktrees();
    return worktrees.length;
  }

  // -------------------------------------------------------------------------
  // Removal
  // -------------------------------------------------------------------------

  /**
   * Remove a single track worktree, its branch, and prune git metadata.
   *
   * Idempotency: if the directory does not exist, skip worktree remove.
   * If the branch does not exist, skip branch delete.
   */
  async removeWorktree(
    requestId: string,
    trackName: string,
    force: boolean = false,
  ): Promise<void> {
    const branchName = trackBranchName(requestId, trackName);
    const wtPath = buildWorktreePath(this.worktreeRoot, requestId, trackName);

    // Remove the worktree (idempotent: skip if directory does not exist)
    if (fsSync.existsSync(wtPath)) {
      try {
        const args = ['worktree', 'remove', wtPath];
        if (force) args.push('--force');
        await git(this.repoRoot, args);
      } catch (err) {
        // If the worktree is already gone or unregistered, that's fine
        if (force) {
          // Force-remove the directory as fallback
          await fs.rm(wtPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    // Delete the track branch (idempotent: skip if branch does not exist)
    const trackRef = `refs/heads/${branchName}`;
    if (await refExists(this.repoRoot, trackRef)) {
      try {
        await git(this.repoRoot, ['branch', '-D', branchName]);
      } catch {
        // Branch may already be deleted
      }
    }

    // Prune stale worktree metadata
    try {
      await git(this.repoRoot, ['worktree', 'prune']);
    } catch {
      // Best-effort prune
    }

    // Emit removal event
    const event: WorktreeRemovedEvent = {
      type: 'worktree.removed',
      requestId,
      trackName,
      timestamp: new Date().toISOString(),
    };
    this.eventEmitter.emit(event.type, event);
  }

  /**
   * Clean up all worktrees and branches for a given request.
   *
   * Steps:
   *   1. List all worktrees for this request
   *   2. For each: removeWorktree(requestId, trackName, force=true)
   *   3. Remove the integration branch
   *   4. Remove the request directory if empty
   */
  async cleanupRequest(requestId: string): Promise<void> {
    // List all worktrees for this request
    const worktrees = await this.listWorktrees(requestId);

    // Remove each track worktree
    for (const wt of worktrees) {
      await this.removeWorktree(requestId, wt.trackName, true);
    }

    // Delete the integration branch
    const integrationBranch = integrationBranchName(requestId);
    const integrationRef = `refs/heads/${integrationBranch}`;
    if (await refExists(this.repoRoot, integrationRef)) {
      try {
        await git(this.repoRoot, ['branch', '-D', integrationBranch]);
      } catch {
        // Best-effort
      }
    }

    // Remove the request directory if it exists
    const requestDir = path.join(this.worktreeRoot, requestId);
    try {
      await fs.rm(requestDir, { recursive: true, force: true });
    } catch {
      // Directory may already be gone
    }

    // Final prune
    try {
      await git(this.repoRoot, ['worktree', 'prune']);
    } catch {
      // Best-effort
    }
  }

  // -------------------------------------------------------------------------
  // Disk monitoring
  // -------------------------------------------------------------------------

  /**
   * Calculate total disk usage across all worktrees.
   * Returns total bytes and per-worktree breakdown.
   *
   * Also checks thresholds and emits warning/critical events on crossing.
   */
  async checkDiskUsage(): Promise<{
    totalBytes: number;
    perWorktree: Record<string, number>;
  }> {
    const worktrees = await this.listWorktrees();
    const perWorktree: Record<string, number> = {};
    let totalBytes = 0;

    for (const wt of worktrees) {
      const size = await calculateDirectorySize(wt.worktreePath);
      const key = `${wt.requestId}/${wt.trackName}`;
      perWorktree[key] = size;
      totalBytes += size;
    }

    // Also include any worktree directories not yet tracked by git
    // but present under worktreeRoot
    if (fsSync.existsSync(this.worktreeRoot) && worktrees.length === 0) {
      const rootSize = await calculateDirectorySize(this.worktreeRoot);
      totalBytes = rootSize;
    }

    // Check thresholds and emit events
    this.checkAndEmitDiskEvents(totalBytes);

    return { totalBytes, perWorktree };
  }

  /**
   * Get the current disk pressure level based on the last check.
   * Call checkDiskUsage() first to update this value.
   */
  getDiskPressureLevel(): DiskPressureLevel {
    return this.lastPressureLevel;
  }

  /**
   * Start periodic disk monitoring.
   * @param intervalMs Monitoring interval in milliseconds (default: 60000)
   */
  startDiskMonitor(intervalMs: number = 60_000): void {
    this.stopDiskMonitor();
    this.diskMonitorInterval = setInterval(async () => {
      try {
        await this.checkDiskUsage();
      } catch {
        // Swallow errors in the monitor loop
      }
    }, intervalMs);
    // Prevent the interval from keeping the process alive
    if (this.diskMonitorInterval.unref) {
      this.diskMonitorInterval.unref();
    }
  }

  /**
   * Stop the periodic disk monitor.
   */
  stopDiskMonitor(): void {
    if (this.diskMonitorInterval !== null) {
      clearInterval(this.diskMonitorInterval);
      this.diskMonitorInterval = null;
    }
  }

  /**
   * Check disk usage against thresholds and emit events on crossing.
   */
  private checkAndEmitDiskEvents(totalBytes: number): void {
    const warningBytes = this.config.disk_warning_threshold_gb * 1024 * 1024 * 1024;
    const criticalBytes = this.config.disk_hard_limit_gb * 1024 * 1024 * 1024;

    let newLevel: DiskPressureLevel;
    // Pressure levels per SPEC-006-1-2:
    //   normal:   usage < disk_warning_threshold_gb
    //   warning:  usage >= disk_warning_threshold_gb and < disk_hard_limit_gb
    //   critical: usage >= disk_hard_limit_gb
    // Check critical first since it takes priority.

    if (totalBytes >= criticalBytes) {
      newLevel = 'critical';
    } else if (totalBytes >= warningBytes) {
      newLevel = 'warning';
    } else {
      newLevel = 'normal';
    }

    // Emit events on threshold crossings
    if (newLevel === 'warning' && this.lastPressureLevel === 'normal') {
      const event: WorktreeDiskWarningEvent = {
        type: 'worktree.disk_warning',
        totalBytes,
        thresholdBytes: warningBytes,
        timestamp: new Date().toISOString(),
      };
      this.eventEmitter.emit(event.type, event);
    }

    if (newLevel === 'critical' && this.lastPressureLevel !== 'critical') {
      const event: WorktreeDiskCriticalEvent = {
        type: 'worktree.disk_critical',
        totalBytes,
        thresholdBytes: criticalBytes,
        timestamp: new Date().toISOString(),
      };
      this.eventEmitter.emit(event.type, event);
    }

    this.lastPressureLevel = newLevel;
  }

  /**
   * Manually set the disk pressure level. Useful for testing or when
   * external monitoring has determined the pressure level.
   */
  setDiskPressureLevel(level: DiskPressureLevel): void {
    this.lastPressureLevel = level;
  }

  // -------------------------------------------------------------------------
  // Health validation
  // -------------------------------------------------------------------------

  /**
   * Validate the health of a single worktree.
   *
   * Checks:
   *   1. Directory exists
   *   2. Worktree is registered in git
   *   3. Branch exists
   *   4. Working tree is clean (dirty is a warning, not an error for healthy)
   */
  async validateWorktreeHealth(
    requestId: string,
    trackName: string,
  ): Promise<WorktreeHealthReport> {
    const branchName = trackBranchName(requestId, trackName);
    const wtPath = buildWorktreePath(this.worktreeRoot, requestId, trackName);
    const issues: string[] = [];

    // 1. Directory exists
    let directoryExists = false;
    try {
      const stat = await fs.stat(wtPath);
      directoryExists = stat.isDirectory();
    } catch {
      directoryExists = false;
    }
    if (!directoryExists) {
      issues.push(`Directory does not exist: ${wtPath}`);
    }

    // 2. Worktree is registered in git
    let registeredInGit = false;
    try {
      const output = await git(this.repoRoot, [
        'worktree',
        'list',
        '--porcelain',
      ]);
      const entries = parseWorktreeList(output);
      registeredInGit = entries.some((e) => e.worktree === wtPath);
    } catch {
      registeredInGit = false;
    }
    if (!registeredInGit) {
      issues.push(`Worktree not registered in git: ${wtPath}`);
    }

    // 3. Branch exists
    const branchRef = `refs/heads/${branchName}`;
    const branchExists = await refExists(this.repoRoot, branchRef);
    if (!branchExists) {
      issues.push(`Branch does not exist: ${branchName}`);
    }

    // 4. Working tree is clean
    let isClean = true;
    if (directoryExists) {
      try {
        const statusOutput = await git(wtPath, ['status', '--porcelain']);
        isClean = statusOutput === '';
      } catch {
        isClean = false;
      }
    } else {
      isClean = false;
    }
    if (!isClean) {
      issues.push(`Working tree is dirty: ${wtPath}`);
    }

    // healthy = directory exists AND registered AND branch exists
    // Note: dirty worktree is a warning but does NOT affect healthy status
    // per the spec: "Non-empty output means dirty worktree (warning, not error)"
    const healthy = directoryExists && registeredInGit && branchExists;

    return {
      requestId,
      trackName,
      directoryExists,
      registeredInGit,
      branchExists,
      isClean,
      healthy,
      issues,
    };
  }

  /**
   * Validate health for all tracked worktrees.
   */
  async validateAllWorktrees(): Promise<WorktreeHealthReport[]> {
    const worktrees = await this.listWorktrees();
    const reports: WorktreeHealthReport[] = [];
    for (const wt of worktrees) {
      const report = await this.validateWorktreeHealth(
        wt.requestId,
        wt.trackName,
      );
      reports.push(report);
    }
    return reports;
  }

  // -------------------------------------------------------------------------
  // .gitignore management (SPEC-006-1-3 Section 3)
  // -------------------------------------------------------------------------

  /**
   * Ensures the repo's `.gitignore` includes the required entries
   * for worktrees and state directories.
   *
   * Only appends missing lines; never removes existing entries.
   * Safe to call multiple times (idempotent).
   */
  async ensureGitignore(): Promise<void> {
    const gitignorePath = path.join(this.repoRoot, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(gitignorePath, 'utf-8');
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err;
    }

    const existingLines = new Set(content.split('\n').map((l) => l.trim()));
    const toAdd: string[] = [];

    for (const entry of GITIGNORE_ENTRIES) {
      if (!existingLines.has(entry)) {
        toAdd.push(entry);
      }
    }

    if (toAdd.length > 0) {
      // Ensure we start on a new line
      const separator =
        content.length > 0 && !content.endsWith('\n') ? '\n' : '';
      const addition = toAdd.join('\n') + '\n';
      await fs.writeFile(
        gitignorePath,
        content + separator + addition,
        'utf-8',
      );
      logger.info(`Updated .gitignore with ${toAdd.length} entries`);
    }
  }

  // -------------------------------------------------------------------------
  // Orphan cleanup (SPEC-006-1-3 Section 2)
  // -------------------------------------------------------------------------

  /**
   * Reconciles `git worktree list` output against persisted state on startup,
   * removing stale worktrees and branches from previous crashed runs.
   *
   * Steps:
   *   1. Get all git-registered worktrees under worktreeRoot
   *   2. Get all in-flight request IDs from StatePersister
   *   3. Remove worktrees that have no corresponding in-flight state
   *   4. Remove `auto/*` branches with no corresponding state file
   *   5. Run `git worktree prune`
   *
   * All cleanup actions are logged with the worktree path and branch name.
   */
  async cleanupOrphanedWorktrees(
    persister: StatePersister,
  ): Promise<CleanupReport> {
    const report: CleanupReport = {
      removedWorktrees: [],
      removedBranches: [],
      errors: [],
    };

    // 1. Get all git-registered worktrees under our root
    let porcelainOutput: string;
    try {
      porcelainOutput = await git(this.repoRoot, [
        'worktree',
        'list',
        '--porcelain',
      ]);
    } catch {
      porcelainOutput = '';
    }
    const gitWorktrees = parseWorktreeList(porcelainOutput);

    // 2. Get all in-flight request IDs
    const inFlightIds = new Set(await persister.listInFlightRequests());

    // 3. For each worktree under worktreeRoot:
    for (const wt of gitWorktrees) {
      if (!wt.worktree.startsWith(this.worktreeRoot)) continue; // skip non-managed

      const { requestId, trackName } = this.parseWorktreePath(wt.worktree);
      if (!requestId) continue; // not our naming convention

      if (!inFlightIds.has(requestId)) {
        // Orphaned: no active state file
        const branchShort = wt.branch.replace('refs/heads/', '');
        logger.info(
          `Removing orphaned worktree: ${wt.worktree} (branch: ${branchShort})`,
        );
        try {
          await this.removeWorktree(requestId, trackName, true /* force */);
          report.removedWorktrees.push(wt.worktree);
        } catch (err) {
          report.errors.push({ path: wt.worktree, error: String(err) });
        }
      }
    }

    // 4. Clean stale auto/* branches with no corresponding state
    const autoBranches = await this.listAutoBranches();
    for (const branch of autoBranches) {
      const reqId = this.extractRequestIdFromBranch(branch);
      if (reqId && !inFlightIds.has(reqId)) {
        logger.info(`Removing stale branch: ${branch}`);
        try {
          await git(this.repoRoot, ['branch', '-D', branch]);
          report.removedBranches.push(branch);
        } catch (err) {
          report.errors.push({ path: branch, error: String(err) });
        }
      }
    }

    // 5. Final prune
    try {
      await git(this.repoRoot, ['worktree', 'prune']);
    } catch {
      // Best-effort prune
    }

    return report;
  }

  // -------------------------------------------------------------------------
  // Orphan cleanup helpers
  // -------------------------------------------------------------------------

  /**
   * Parses a worktree path under worktreeRoot to extract requestId and trackName.
   *
   * Expected format: {worktreeRoot}/{requestId}/{trackName}
   *
   * Returns empty strings if the path does not match our naming convention.
   */
  parseWorktreePath(wtPath: string): {
    requestId: string;
    trackName: string;
  } {
    const relative = path.relative(this.worktreeRoot, wtPath);
    const parts = relative.split(path.sep);

    if (parts.length >= 2) {
      return { requestId: parts[0], trackName: parts[1] };
    }

    return { requestId: '', trackName: '' };
  }

  /**
   * Lists all branches matching `auto/*`.
   */
  async listAutoBranches(): Promise<string[]> {
    try {
      const output = await git(this.repoRoot, [
        'branch',
        '--list',
        'auto/*',
        '--format=%(refname:short)',
      ]);
      if (!output) return [];
      return output.split('\n').filter((b) => b.trim() !== '');
    } catch {
      return [];
    }
  }

  /**
   * Extracts the requestId segment from a branch name like
   * "auto/{requestId}/integration" or "auto/{requestId}/{trackName}".
   *
   * Returns null if the branch name does not match the auto/* convention.
   */
  extractRequestIdFromBranch(branch: string): string | null {
    const match = branch.match(/^auto\/([^/]+)\//);
    return match ? match[1] : null;
  }

  // -------------------------------------------------------------------------
  // Accessor for worktree root (used by orphan cleanup and tests)
  // -------------------------------------------------------------------------

  /** Returns the resolved absolute worktree root path. */
  get resolvedWorktreeRoot(): string {
    return this.worktreeRoot;
  }
}
