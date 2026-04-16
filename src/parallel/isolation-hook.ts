/**
 * Filesystem isolation hook for the parallel execution engine.
 *
 * PostToolUse hook that enforces path traversal protection between worktrees.
 * Every file access from an agent must resolve within its assigned worktree.
 *
 * Based on SPEC-006-3-2, Task 4.
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IsolationHookContext {
  trackName: string;
  worktreePath: string; // absolute, normalized, resolved (no symlinks)
  eventEmitter: EventEmitter;
}

// ---------------------------------------------------------------------------
// FilesystemIsolationHook
// ---------------------------------------------------------------------------

export class FilesystemIsolationHook {
  private resolvedWorktreePath: string;

  constructor(private context: IsolationHookContext) {
    // Pre-resolve the worktree path to its real path (follow symlinks)
    this.resolvedWorktreePath = fs.realpathSync(context.worktreePath);
  }

  /**
   * PostToolUse hook handler. Returns true to allow, false to block.
   * Called after every tool invocation by the agent.
   */
  async validate(
    toolName: string,
    toolInput: Record<string, any>,
  ): Promise<boolean> {
    // Extract file paths from tool input based on tool type
    const paths = this.extractPaths(toolName, toolInput);

    for (const targetPath of paths) {
      if (!this.isPathAllowed(targetPath)) {
        this.context.eventEmitter.emit('security.isolation_violation', {
          type: 'security.isolation_violation',
          trackName: this.context.trackName,
          toolName,
          attemptedPath: targetPath,
          worktreePath: this.context.worktreePath,
          timestamp: new Date().toISOString(),
        });

        return false; // block the tool call
      }
    }

    return true; // allow
  }

  /**
   * Core path validation logic.
   * 1. Resolve the path relative to the worktree CWD
   * 2. Follow all symlinks via realpath
   * 3. Verify the resolved path starts with the resolved worktree path
   */
  isPathAllowed(targetPath: string): boolean {
    try {
      // Reject null bytes immediately -- they can truncate C-level path operations
      if (targetPath.includes('\x00')) {
        return false;
      }

      // Step 1: Resolve relative paths against the worktree directory
      const absolutePath = path.isAbsolute(targetPath)
        ? targetPath
        : path.resolve(this.context.worktreePath, targetPath);

      // Step 2: Normalize to remove . and .. components
      const normalizedPath = path.normalize(absolutePath);

      // Step 3: Resolve symlinks (if the path exists)
      let resolvedPath: string;
      try {
        resolvedPath = fs.realpathSync(normalizedPath);
      } catch {
        // Path doesn't exist yet (e.g., file being created).
        // Validate the deepest existing ancestor.
        resolvedPath = this.resolveDeepestExistingAncestor(normalizedPath);
      }

      // Step 4: Prefix check -- resolved path must start with resolved worktree path
      return (
        resolvedPath.startsWith(this.resolvedWorktreePath + path.sep) ||
        resolvedPath === this.resolvedWorktreePath
      );
    } catch {
      // Any resolution error -> deny
      return false;
    }
  }

  private resolveDeepestExistingAncestor(targetPath: string): string {
    let current = targetPath;
    while (current !== path.dirname(current)) {
      try {
        const real = fs.realpathSync(current);
        // Append the remaining unresolved portion
        const remainder = targetPath.slice(current.length);
        return path.join(real, remainder);
      } catch {
        current = path.dirname(current);
      }
    }
    return targetPath; // fallback
  }

  /**
   * Extract file paths from tool inputs based on tool type.
   */
  private extractPaths(
    toolName: string,
    toolInput: Record<string, any>,
  ): string[] {
    switch (toolName) {
      case 'Read':
      case 'Write':
        return toolInput.file_path ? [toolInput.file_path] : [];

      case 'Edit':
        return toolInput.file_path ? [toolInput.file_path] : [];

      case 'Glob':
        return toolInput.path ? [toolInput.path] : [];

      case 'Grep':
        return toolInput.path ? [toolInput.path] : [];

      case 'Bash': {
        // Best-effort extraction from bash commands
        // Look for common file-path patterns in the command
        const cmd = toolInput.command ?? '';
        return this.extractPathsFromBashCommand(cmd);
      }

      default:
        return [];
    }
  }

  /**
   * Best-effort extraction of file paths from a bash command string.
   * Catches obvious cases like: cd /path, cat /path, > /path
   * Not exhaustive -- the isolation is defense-in-depth, not solely reliant on this.
   */
  private extractPathsFromBashCommand(cmd: string): string[] {
    const paths: string[] = [];

    // Match absolute paths (starting with /)
    const absPathRegex = /(?:^|\s)(\/[^\s;|&>]+)/g;
    let match;
    while ((match = absPathRegex.exec(cmd)) !== null) {
      paths.push(match[1]);
    }

    // Match cd commands with relative paths
    const cdMatch = cmd.match(/cd\s+([^\s;|&]+)/);
    if (cdMatch) paths.push(cdMatch[1]);

    return paths;
  }
}
