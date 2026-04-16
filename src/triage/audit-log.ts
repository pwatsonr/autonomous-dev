/**
 * Triage audit log (SPEC-007-4-3, Task 8).
 *
 * Append-only JSONL log at `.autonomous-dev/logs/intelligence/triage-audit.log`.
 * Each line is a JSON-serialized TriageAuditEntry recording a triage action
 * (promote, dismiss, defer, investigate, deferred_return, error).
 *
 * Extends the audit logging from SPEC-007-4-2 with:
 *   - Persistent file-based JSONL storage (the 4-2 logger buffers in memory)
 *   - `error` action type for recording triage errors
 *   - `auto_promoted` flag for Phase 3 auto-promotion
 *   - Query methods for governance analysis and reporting
 */

import * as fs from 'fs/promises';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single triage audit log entry.
 *
 * Recorded whenever a triage action is taken on an observation.
 * Extends the TriageAuditEntry from types.ts with the `error` action.
 */
export interface TriageAuditEntry {
  /** Observation ID this action applies to */
  observation_id: string;
  /** Triage action taken */
  action: 'promote' | 'dismiss' | 'defer' | 'investigate' | 'deferred_return' | 'error';
  /** Username or "system" */
  actor: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Human-readable reason for the action */
  reason: string;
  /** PRD ID if one was generated, null otherwise */
  generated_prd: string | null;
  /** Whether this was an automatic promotion (Phase 3) */
  auto_promoted: boolean;
}

// ---------------------------------------------------------------------------
// TriageAuditLogger
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL logger for triage actions.
 *
 * Writes to `.autonomous-dev/logs/intelligence/triage-audit.log`.
 * Each call to `log()` immediately appends a single JSON line
 * followed by '\n'. The file is created (along with parent
 * directories) on first write.
 *
 * Unlike the `DefaultTriageAuditLogger` from SPEC-007-4-2 which
 * buffers in memory, this logger writes directly to disk on each
 * `log()` call for durability and governance compliance.
 */
export class TriageAuditLogger {
  private readonly logPath: string;

  /**
   * @param rootDir The project root directory. The log file will be written
   *                to `<rootDir>/.autonomous-dev/logs/intelligence/triage-audit.log`.
   */
  constructor(rootDir: string) {
    this.logPath = path.join(
      rootDir,
      '.autonomous-dev',
      'logs',
      'intelligence',
      'triage-audit.log',
    );
  }

  /** Returns the absolute path to the audit log file. */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Appends a single audit entry to the log file.
   *
   * Creates parent directories if they do not exist.
   * Each entry is serialized as a single JSON line followed by '\n'.
   *
   * @param entry The triage audit entry to record
   */
  async log(entry: TriageAuditEntry): Promise<void> {
    const logDir = path.dirname(this.logPath);
    await fs.mkdir(logDir, { recursive: true });
    const json = JSON.stringify(entry);
    await fs.appendFile(this.logPath, json + '\n', 'utf-8');
  }

  /**
   * Convenience method to log an error event for an observation.
   *
   * @param observationId The observation ID that encountered an error
   * @param error         Human-readable error description
   */
  async logError(observationId: string, error: string): Promise<void> {
    await this.log({
      observation_id: observationId,
      action: 'error',
      actor: 'system',
      timestamp: new Date().toISOString(),
      reason: error,
      generated_prd: null,
      auto_promoted: false,
    });
  }

  /**
   * Reads all audit entries from the log file.
   *
   * Returns an empty array if the file does not exist or is empty.
   * Each non-empty line is parsed as a JSON TriageAuditEntry.
   *
   * @returns Array of all audit entries in chronological order
   */
  async readAll(): Promise<TriageAuditEntry[]> {
    try {
      const content = await fs.readFile(this.logPath, 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as TriageAuditEntry);
    } catch {
      return [];
    }
  }

  /**
   * Reads audit entries filtered by observation ID.
   *
   * @param observationId The observation ID to filter by
   * @returns Array of matching audit entries
   */
  async readByObservation(observationId: string): Promise<TriageAuditEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.observation_id === observationId);
  }

  /**
   * Reads audit entries filtered by action type.
   *
   * @param action The action type to filter by
   * @returns Array of matching audit entries
   */
  async readByAction(
    action: TriageAuditEntry['action'],
  ): Promise<TriageAuditEntry[]> {
    const all = await this.readAll();
    return all.filter((e) => e.action === action);
  }
}
