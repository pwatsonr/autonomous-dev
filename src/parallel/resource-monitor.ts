// ============================================================================
// Resource Monitor — Disk Pressure Querying and Resource-Aware Throttle Logic
// SPEC-006-2-3: Scheduler and Priority Dispatch
// ============================================================================

import { execSync } from 'child_process';

import { ParallelConfig } from './config';
import { DiskPressureLevel } from './types';
import { WorktreeManager } from './worktree-manager';

// ============================================================================
// Error classes
// ============================================================================

/**
 * Thrown when resource checks indicate the system cannot accept new work.
 */
export class ResourceExhaustedError extends Error {
  constructor(reason: string) {
    super(`Resource exhausted: ${reason}`);
    this.name = 'ResourceExhaustedError';
  }
}

// ============================================================================
// Types
// ============================================================================

/** Snapshot of current resource availability. */
export interface ResourceStatus {
  diskUsageBytes: number;
  diskPressure: DiskPressureLevel;
  activeWorktrees: number;
  maxWorktrees: number;
  availableSlots: number;
}

// ============================================================================
// ResourceMonitor
// ============================================================================

/**
 * Queries WorktreeManager for disk pressure and slot availability,
 * throttling parallelism under resource pressure.
 *
 * Pre-dispatch resource gate checks are run:
 *   1. Before each worktree creation
 *   2. Every 60 seconds during execution
 *   3. After each track completion
 */
export class ResourceMonitor {
  constructor(
    private worktreeManager: WorktreeManager,
    private config: ParallelConfig,
  ) {}

  /**
   * Returns the current disk pressure level from the WorktreeManager.
   */
  getDiskPressureLevel(): DiskPressureLevel {
    return this.worktreeManager.getDiskPressureLevel();
  }

  /**
   * Gathers a full snapshot of current resource availability.
   */
  async checkResources(): Promise<ResourceStatus> {
    const diskUsage = await this.worktreeManager.checkDiskUsage();
    const worktreeCount = await this.worktreeManager.getActiveWorktreeCount();

    return {
      diskUsageBytes: diskUsage.totalBytes,
      diskPressure: this.getDiskPressureLevel(),
      activeWorktrees: worktreeCount,
      maxWorktrees: this.config.max_worktrees,
      availableSlots: Math.max(0, this.config.max_worktrees - worktreeCount),
    };
  }

  /**
   * Pre-dispatch resource gate. Returns true if a new worktree can be created.
   *
   * Checks are run:
   *   1. Before each worktree creation
   *   2. Every 60 seconds during execution
   *   3. After each track completion
   */
  async canDispatch(): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.checkResources();

    if (status.diskPressure === 'critical') {
      return { allowed: false, reason: 'Disk pressure critical: usage exceeds hard limit' };
    }

    if (status.activeWorktrees >= status.maxWorktrees) {
      return { allowed: false, reason: `Max worktrees reached (${status.maxWorktrees})` };
    }

    // Emergency: check available disk space
    const freeDiskBytes = await this.getFreeDiskSpace();
    if (freeDiskBytes < 1_073_741_824) { // 1 GB
      return { allowed: false, reason: 'Available disk space below 1 GB' };
    }

    return { allowed: true };
  }

  /**
   * Queries free disk space on the volume containing the worktree root.
   * Uses `df -k` for cross-platform compatibility (macOS and Linux).
   *
   * @returns Available disk space in bytes.
   */
  async getFreeDiskSpace(): Promise<number> {
    try {
      const worktreeRoot = this.worktreeManager.resolvedWorktreeRoot;
      const output = execSync(`df -k "${worktreeRoot}" | tail -1`)
        .toString()
        .trim();
      const parts = output.split(/\s+/);
      const availKB = parseInt(parts[3], 10);
      if (isNaN(availKB)) {
        // If parsing fails, return a large value to avoid false blocking
        return Number.MAX_SAFE_INTEGER;
      }
      return availKB * 1024;
    } catch {
      // If df fails (e.g., directory doesn't exist yet), return a large value
      // to avoid blocking dispatch on non-critical errors
      return Number.MAX_SAFE_INTEGER;
    }
  }
}
