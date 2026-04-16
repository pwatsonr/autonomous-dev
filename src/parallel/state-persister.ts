/**
 * StatePersister — Atomic state I/O, in-flight listing, and archival.
 *
 * SPEC-006-1-3: State Persistence and Orphan Cleanup
 *
 * Writes execution state atomically to disk using write-to-temp-then-rename,
 * with crash recovery detection on startup.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PersistedExecutionState } from './types';

// ============================================================================
// Error classes
// ============================================================================

/** Thrown when a state file does not exist for the given requestId. */
export class StateNotFoundError extends Error {
  constructor(public readonly requestId: string) {
    super(`State not found for request: ${requestId}`);
    this.name = 'StateNotFoundError';
  }
}

/** Thrown when a state file contains invalid or truncated JSON. */
export class CorruptStateError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly filePath: string,
  ) {
    super(`Corrupt state file for ${requestId}: ${filePath}`);
    this.name = 'CorruptStateError';
  }
}

/** Thrown when a state file has an unsupported schema version. */
export class UnsupportedStateVersionError extends Error {
  constructor(
    public readonly requestId: string,
    public readonly version: unknown,
  ) {
    super(`Unsupported state version for ${requestId}: ${version}`);
    this.name = 'UnsupportedStateVersionError';
  }
}

// ============================================================================
// Logger (lightweight, no external deps)
// ============================================================================

const logger = {
  info: (msg: string) => {
    // Structured log for observability; can be replaced with a real logger
    process.stderr.write(`[state-persister] INFO  ${msg}\n`);
  },
  error: (msg: string) => {
    process.stderr.write(`[state-persister] ERROR ${msg}\n`);
  },
};

// ============================================================================
// StatePersister
// ============================================================================

export class StatePersister {
  constructor(
    private stateDir: string,   // e.g. "{repoRoot}/.autonomous-dev/state"
    private archiveDir: string, // e.g. "{repoRoot}/.autonomous-dev/archive"
  ) {}

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * Ensure state and archive directories exist.
   * Safe to call multiple times (idempotent).
   */
  async init(): Promise<void> {
    await fs.mkdir(this.stateDir, { recursive: true });
    await fs.mkdir(this.archiveDir, { recursive: true });
  }

  // --------------------------------------------------------------------------
  // saveState — atomic write via temp-then-rename
  // --------------------------------------------------------------------------

  /**
   * Persists execution state atomically.
   *
   * Algorithm:
   *   1. Serialize to JSON with 2-space indent for debuggability
   *   2. Write to `.json.tmp` temp file
   *   3. Atomic rename to `.json` (POSIX guarantees atomicity on same FS)
   *
   * On success the `.tmp` file no longer exists. On crash the `.json`
   * file is either the old version or the new version, never partial.
   */
  async saveState(state: PersistedExecutionState): Promise<void> {
    state.updatedAt = new Date().toISOString();

    const filePath = path.join(this.stateDir, `${state.requestId}.json`);
    const tmpPath = `${filePath}.tmp`;

    // 1. Serialize to JSON with 2-space indent for debuggability
    const json = JSON.stringify(state, null, 2);

    // 2. Write to temp file
    await fs.writeFile(tmpPath, json, 'utf-8');

    // 3. Atomic rename (POSIX guarantees atomicity for rename on same filesystem)
    await fs.rename(tmpPath, filePath);
  }

  // --------------------------------------------------------------------------
  // loadState — read with validation
  // --------------------------------------------------------------------------

  /**
   * Loads and validates a persisted state file.
   *
   * @throws StateNotFoundError   when the file does not exist
   * @throws CorruptStateError    when the file contains invalid JSON
   * @throws UnsupportedStateVersionError when version !== 1
   */
  async loadState(requestId: string): Promise<PersistedExecutionState> {
    const filePath = path.join(this.stateDir, `${requestId}.json`);

    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new StateNotFoundError(requestId);
      throw err;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt file -- log and throw
      logger.error(`Corrupt state file for ${requestId}: ${filePath}`);
      throw new CorruptStateError(requestId, filePath);
    }

    // Schema version check
    if (parsed.version !== 1) {
      throw new UnsupportedStateVersionError(requestId, parsed.version);
    }

    return parsed as PersistedExecutionState;
  }

  // --------------------------------------------------------------------------
  // listInFlightRequests
  // --------------------------------------------------------------------------

  /**
   * Returns request IDs whose phase is neither 'complete' nor 'failed'.
   *
   * Skips `.tmp` files and corrupt state files (they will be handled
   * by crash recovery separately).
   */
  async listInFlightRequests(): Promise<string[]> {
    let files: string[];
    try {
      files = await fs.readdir(this.stateDir);
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const inFlight: string[] = [];

    for (const file of files) {
      if (!file.endsWith('.json') || file.endsWith('.tmp')) continue;
      try {
        const state = await this.loadState(file.replace('.json', ''));
        if (state.phase !== 'complete' && state.phase !== 'failed') {
          inFlight.push(state.requestId);
        }
      } catch {
        // Skip corrupt files -- they'll be handled by crash recovery
      }
    }
    return inFlight;
  }

  // --------------------------------------------------------------------------
  // archiveState
  // --------------------------------------------------------------------------

  /**
   * Moves a state file from the active state directory to the archive
   * directory with a timestamp suffix for historical reference.
   */
  async archiveState(requestId: string): Promise<void> {
    const src = path.join(this.stateDir, `${requestId}.json`);
    const dst = path.join(this.archiveDir, `${requestId}-${Date.now()}.json`);
    await fs.mkdir(this.archiveDir, { recursive: true });
    await fs.rename(src, dst);
  }

  // --------------------------------------------------------------------------
  // deleteState
  // --------------------------------------------------------------------------

  /**
   * Removes a state file from the active state directory.
   * No-op if the file does not exist.
   */
  async deleteState(requestId: string): Promise<void> {
    const filePath = path.join(this.stateDir, `${requestId}.json`);
    try {
      await fs.unlink(filePath);
    } catch (err: any) {
      if (err.code === 'ENOENT') return; // already gone
      throw err;
    }
  }
}
