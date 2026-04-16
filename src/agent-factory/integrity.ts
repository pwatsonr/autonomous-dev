/**
 * Committed-state integrity checker (SPEC-005-1-2, Task 3).
 *
 * Ensures only git-committed, unmodified agent files can be loaded.
 * Two-phase verification:
 *   1. Batch `git status --porcelain` check for working-tree cleanliness.
 *   2. Per-file SHA-256 comparison between disk and committed content.
 *
 * Security logging: every rejection is logged via `logSecurityAlert`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { IntegrityResult, FileIntegrityResult } from './types';

// Re-export for convenience
export type { IntegrityResult, FileIntegrityResult };

// ---------------------------------------------------------------------------
// Security logging
// ---------------------------------------------------------------------------

/**
 * Log a security alert for integrity check failures.
 *
 * In a production system this would delegate to the audit log writer
 * (SPEC-005-1-3). For now, we emit structured messages to stderr so
 * they are captured by process-level log collectors.
 */
function logSecurityAlert(filePath: string, reason: string, details: Record<string, unknown>): void {
  const event = {
    timestamp: new Date().toISOString(),
    eventType: 'integrity_check_failed',
    filePath,
    reason,
    ...details,
  };
  process.stderr.write(`[SECURITY] ${JSON.stringify(event)}\n`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check integrity of all `.md` agent files in the given directory.
 *
 * Steps:
 *   1. Verify the directory exists. If not, return an empty passing result.
 *   2. Run `git status --porcelain` against the directory as a single
 *      batch call. Any file with a non-empty status indicator is rejected.
 *   3. For each `.md` file, compare the SHA-256 of the on-disk content
 *      with the SHA-256 of the committed (`HEAD`) version.
 *   4. Log security alerts for all rejections.
 *
 * @param agentsDir  Absolute or relative path to the agents directory.
 * @returns          IntegrityResult with passed/rejected file lists.
 */
export function checkIntegrity(agentsDir: string): IntegrityResult {
  const resolvedDir = path.resolve(agentsDir);

  // Handle missing directory gracefully
  if (!fs.existsSync(resolvedDir) || !fs.statSync(resolvedDir).isDirectory()) {
    return { passed: [], rejected: [], allPassed: true };
  }

  // Discover all .md files on disk
  const mdFiles = fs.readdirSync(resolvedDir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => path.join(resolvedDir, f));

  if (mdFiles.length === 0) {
    return { passed: [], rejected: [], allPassed: true };
  }

  // Phase 1: batch git status check
  const dirtyFiles = batchGitStatus(resolvedDir);

  const passed: FileIntegrityResult[] = [];
  const rejected: FileIntegrityResult[] = [];

  for (const filePath of mdFiles) {
    const relativePath = path.relative(resolvedDir, filePath);
    const basename = path.basename(filePath);

    // Path traversal guard: reject files that escape the agents directory
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      const result: FileIntegrityResult = {
        filePath,
        passed: false,
        reason: 'path traversal detected',
      };
      rejected.push(result);
      logSecurityAlert(filePath, result.reason!, { relativePath });
      continue;
    }

    // Check git status
    const status = dirtyFiles.get(basename) ?? dirtyFiles.get(relativePath);
    if (status !== undefined) {
      const reason = statusToReason(status);
      const result: FileIntegrityResult = {
        filePath,
        passed: false,
        reason,
        gitStatus: status,
      };
      rejected.push(result);
      logSecurityAlert(filePath, reason, { gitStatus: status });
      continue;
    }

    // Phase 2: SHA-256 comparison
    const hashResult = checkFileIntegrity(filePath);
    if (hashResult.passed) {
      passed.push(hashResult);
    } else {
      rejected.push(hashResult);
      logSecurityAlert(filePath, hashResult.reason!, {
        diskHash: hashResult.diskHash,
        gitHash: hashResult.gitHash,
      });
    }
  }

  // Also check the git status output for files that might not be on disk
  // (deleted files, path-traversal attempts from git status)
  for (const [statusFile, status] of dirtyFiles) {
    // Guard against path traversal in git status output
    if (statusFile.startsWith('..') || statusFile.includes('/../')) {
      const result: FileIntegrityResult = {
        filePath: path.join(resolvedDir, statusFile),
        passed: false,
        reason: 'path traversal detected',
        gitStatus: status,
      };
      // Only add if not already processed
      if (!rejected.some((r) => r.filePath === result.filePath) &&
          !passed.some((r) => r.filePath === result.filePath)) {
        rejected.push(result);
        logSecurityAlert(result.filePath, result.reason!, { gitStatus: status });
      }
    }
  }

  return {
    passed,
    rejected,
    allPassed: rejected.length === 0,
  };
}

/**
 * Check integrity of a single agent file by comparing disk and git SHA-256.
 *
 * This function does NOT check `git status` — use `checkIntegrity` for
 * the full two-phase check. This is the per-file SHA-256 verification only.
 *
 * @param filePath  Absolute path to the agent `.md` file.
 * @returns         FileIntegrityResult with hash comparison details.
 */
export function checkFileIntegrity(filePath: string): FileIntegrityResult {
  const resolvedPath = path.resolve(filePath);

  // Read disk content and compute hash
  let diskContent: string;
  try {
    diskContent = fs.readFileSync(resolvedPath, 'utf-8');
  } catch (err) {
    return {
      filePath: resolvedPath,
      passed: false,
      reason: `cannot read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const diskHash = computeSha256(diskContent);

  // Retrieve committed version from git
  let gitContent: string;
  try {
    gitContent = getGitFileContent(resolvedPath);
  } catch (err) {
    return {
      filePath: resolvedPath,
      passed: false,
      reason: `cannot retrieve git content: ${err instanceof Error ? err.message : String(err)}`,
      diskHash,
    };
  }

  const gitHash = computeSha256(gitContent);

  if (diskHash !== gitHash) {
    return {
      filePath: resolvedPath,
      passed: false,
      reason: 'hash mismatch',
      diskHash,
      gitHash,
    };
  }

  return {
    filePath: resolvedPath,
    passed: true,
    diskHash,
    gitHash,
  };
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Run `git status --porcelain` against the agents directory and return
 * a map of filename -> status indicator.
 *
 * Uses `execFileSync` (not `execSync`) to avoid shell injection.
 */
function batchGitStatus(agentsDir: string): Map<string, string> {
  const dirtyFiles = new Map<string, string>();

  try {
    const output = execFileSync(
      'git',
      ['status', '--porcelain', agentsDir],
      {
        encoding: 'utf-8',
        cwd: getGitRoot(agentsDir),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    if (!output.trim()) {
      return dirtyFiles;
    }

    for (const line of output.trim().split('\n')) {
      if (!line || line.length < 4) continue;

      // Porcelain format: XY <path>
      // X = index status, Y = worktree status
      const statusIndicator = line.substring(0, 2).trim();
      const filePart = line.substring(3).trim();

      if (!statusIndicator || !filePart) continue;

      // Extract just the filename relative to agents dir
      const basename = path.basename(filePart);
      dirtyFiles.set(basename, statusIndicator);
      // Also store the path as it appears in git output
      dirtyFiles.set(filePart, statusIndicator);
    }
  } catch (err) {
    // If git is not available or the directory is not in a repo, throw
    throw new Error(
      `git status failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return dirtyFiles;
}

/**
 * Retrieve the content of a file at HEAD from git.
 *
 * Uses `git show HEAD:<relative-path>` via `execFileSync`.
 */
function getGitFileContent(filePath: string): string {
  const gitRoot = getGitRoot(path.dirname(filePath));
  const relativePath = path.relative(gitRoot, filePath);

  return execFileSync(
    'git',
    ['show', `HEAD:${relativePath}`],
    {
      encoding: 'utf-8',
      cwd: gitRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
}

/**
 * Find the git repository root for a given directory.
 */
function getGitRoot(fromDir: string): string {
  try {
    return execFileSync(
      'git',
      ['rev-parse', '--show-toplevel'],
      {
        encoding: 'utf-8',
        cwd: fromDir,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (err) {
    throw new Error(
      `Not a git repository or git not available: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/**
 * Compute SHA-256 hex digest of a string.
 */
function computeSha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Map a git porcelain status indicator to a human-readable rejection reason.
 */
function statusToReason(status: string): string {
  // Normalize: take the first non-space character
  const indicator = status.replace(/\s/g, '');

  if (indicator.includes('?')) {
    return 'untracked (?)';
  }
  if (indicator.includes('A')) {
    return 'staged (A)';
  }
  if (indicator.includes('M')) {
    return 'modified (M)';
  }
  if (indicator.includes('D')) {
    return 'deleted (D)';
  }
  // Catch-all for any other status
  return `rejected (${indicator})`;
}
