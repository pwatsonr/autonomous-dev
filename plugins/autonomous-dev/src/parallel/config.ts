/**
 * Configuration loading, validation, and defaults for the parallel execution engine.
 *
 * Loads from the project's `.autonomous-dev/config.yaml` (or programmatic override).
 * Defaults come from TDD Appendix A.
 */

import * as fs from 'fs';
import * as path from 'path';

/** Configuration for the parallel execution engine. */
export interface ParallelConfig {
  /** Maximum number of concurrent worktrees. Integer >= 1. */
  max_worktrees: number;
  /** Maximum number of parallel tracks. Integer >= 1. */
  max_tracks: number;
  /** Disk usage warning threshold in GB. Number > 0. */
  disk_warning_threshold_gb: number;
  /** Disk usage hard limit in GB. Number > 0, must be < warning threshold. */
  disk_hard_limit_gb: number;
  /** Seconds to wait before cleaning up a worktree. Integer >= 0. */
  worktree_cleanup_delay_seconds: number;
  /** Root directory for worktrees (relative or absolute). Non-empty string. */
  worktree_root: string;
  /** Directory for persisted state. Non-empty string. */
  state_dir: string;
  /** Default base branch name. Non-empty string. */
  base_branch: string;
  /** Minutes before a track is considered stalled. Integer >= 1. */
  stall_timeout_minutes: number;
  /** Maximum revision cycles before escalation. Integer >= 0. */
  max_revision_cycles: number;
  /** AI confidence threshold for conflict resolution. Number in (0, 1]. */
  conflict_ai_confidence_threshold: number;
  /** Number of merge conflicts before escalation. Integer >= 1. */
  merge_conflict_escalation_threshold: number;
}

/** Default values matching TDD Appendix A. */
export const DEFAULT_PARALLEL_CONFIG: ParallelConfig = {
  max_worktrees: 5,
  max_tracks: 5,
  disk_warning_threshold_gb: 5,
  disk_hard_limit_gb: 2,
  worktree_cleanup_delay_seconds: 300,
  worktree_root: '.worktrees',
  state_dir: '.autonomous-dev/state',
  base_branch: 'main',
  stall_timeout_minutes: 15,
  max_revision_cycles: 2,
  conflict_ai_confidence_threshold: 0.85,
  merge_conflict_escalation_threshold: 5,
};

/**
 * Validation error thrown when a config value is invalid.
 */
export class ConfigValidationError extends Error {
  constructor(
    public readonly field: string,
    public readonly reason: string,
  ) {
    super(`Invalid parallel config: ${field} -- ${reason}`);
    this.name = 'ConfigValidationError';
  }
}

/**
 * Validates a ParallelConfig, throwing ConfigValidationError for each
 * invalid parameter combination.
 */
export function validateConfig(cfg: ParallelConfig): void {
  // max_worktrees: integer >= 1
  if (!Number.isInteger(cfg.max_worktrees) || cfg.max_worktrees < 1) {
    throw new ConfigValidationError('max_worktrees', 'must be an integer >= 1');
  }

  // max_tracks: integer >= 1
  if (!Number.isInteger(cfg.max_tracks) || cfg.max_tracks < 1) {
    throw new ConfigValidationError('max_tracks', 'must be an integer >= 1');
  }

  // disk_warning_threshold_gb: number > 0
  if (typeof cfg.disk_warning_threshold_gb !== 'number' || cfg.disk_warning_threshold_gb <= 0) {
    throw new ConfigValidationError('disk_warning_threshold_gb', 'must be a number > 0');
  }

  // disk_hard_limit_gb: number > 0
  if (typeof cfg.disk_hard_limit_gb !== 'number' || cfg.disk_hard_limit_gb <= 0) {
    throw new ConfigValidationError('disk_hard_limit_gb', 'must be a number > 0');
  }

  // disk_hard_limit_gb must be < disk_warning_threshold_gb
  if (cfg.disk_hard_limit_gb >= cfg.disk_warning_threshold_gb) {
    throw new ConfigValidationError(
      'disk_hard_limit_gb',
      `must be less than disk_warning_threshold_gb (${cfg.disk_warning_threshold_gb}), got ${cfg.disk_hard_limit_gb}`,
    );
  }

  // worktree_cleanup_delay_seconds: integer >= 0
  if (!Number.isInteger(cfg.worktree_cleanup_delay_seconds) || cfg.worktree_cleanup_delay_seconds < 0) {
    throw new ConfigValidationError('worktree_cleanup_delay_seconds', 'must be an integer >= 0');
  }

  // worktree_root: non-empty string
  if (typeof cfg.worktree_root !== 'string' || cfg.worktree_root.trim() === '') {
    throw new ConfigValidationError('worktree_root', 'must be a non-empty string');
  }

  // If worktree_root is absolute, verify it exists
  if (path.isAbsolute(cfg.worktree_root)) {
    if (!fs.existsSync(cfg.worktree_root)) {
      throw new ConfigValidationError(
        'worktree_root',
        `absolute path does not exist: ${cfg.worktree_root}`,
      );
    }
  }

  // state_dir: non-empty string
  if (typeof cfg.state_dir !== 'string' || cfg.state_dir.trim() === '') {
    throw new ConfigValidationError('state_dir', 'must be a non-empty string');
  }

  // base_branch: non-empty string
  if (typeof cfg.base_branch !== 'string' || cfg.base_branch.trim() === '') {
    throw new ConfigValidationError('base_branch', 'must be a non-empty string');
  }

  // stall_timeout_minutes: integer >= 1
  if (!Number.isInteger(cfg.stall_timeout_minutes) || cfg.stall_timeout_minutes < 1) {
    throw new ConfigValidationError('stall_timeout_minutes', 'must be an integer >= 1');
  }

  // max_revision_cycles: integer >= 0
  if (!Number.isInteger(cfg.max_revision_cycles) || cfg.max_revision_cycles < 0) {
    throw new ConfigValidationError('max_revision_cycles', 'must be an integer >= 0');
  }

  // conflict_ai_confidence_threshold: number in (0, 1]
  if (
    typeof cfg.conflict_ai_confidence_threshold !== 'number' ||
    cfg.conflict_ai_confidence_threshold <= 0 ||
    cfg.conflict_ai_confidence_threshold > 1
  ) {
    throw new ConfigValidationError(
      'conflict_ai_confidence_threshold',
      'must be a number in (0, 1]',
    );
  }

  // merge_conflict_escalation_threshold: integer >= 1
  if (
    !Number.isInteger(cfg.merge_conflict_escalation_threshold) ||
    cfg.merge_conflict_escalation_threshold < 1
  ) {
    throw new ConfigValidationError(
      'merge_conflict_escalation_threshold',
      'must be an integer >= 1',
    );
  }
}

/**
 * Loads configuration with defaults from TDD Appendix A.
 * Programmatic overrides are merged on top of defaults.
 *
 * @param overrides Optional partial config to merge over defaults
 * @returns Merged and validated ParallelConfig
 * @throws ConfigValidationError if the resulting config is invalid
 */
export function loadConfig(overrides?: Partial<ParallelConfig>): ParallelConfig {
  const cfg: ParallelConfig = {
    ...DEFAULT_PARALLEL_CONFIG,
    ...overrides,
  };
  validateConfig(cfg);
  return cfg;
}
