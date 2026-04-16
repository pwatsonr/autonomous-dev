/**
 * Triage audit logger (SPEC-007-4-2).
 *
 * Append-only JSONL logger for triage actions. Writes to
 * `.autonomous-dev/logs/intelligence/triage-audit.jsonl`.
 *
 * Each line is a JSON-serialized TriageAuditEntry.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { TriageAuditEntry, TriageAuditLogger } from './types';

// ---------------------------------------------------------------------------
// Default triage audit logger
// ---------------------------------------------------------------------------

export class DefaultTriageAuditLogger implements TriageAuditLogger {
  private readonly entries: TriageAuditEntry[] = [];
  private readonly errorEntries: Array<{ observationId: string; message: string; timestamp: string }> = [];
  private readonly logPath: string;

  /**
   * @param logDir Directory for triage audit logs
   *               (typically `.autonomous-dev/logs/intelligence`)
   */
  constructor(logDir: string) {
    this.logPath = path.join(logDir, 'triage-audit.jsonl');
  }

  /** Returns the absolute path to the triage audit log file. */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Records a triage action to the in-memory log.
   * Call flush() to persist to disk.
   */
  log(entry: TriageAuditEntry): void {
    this.entries.push(entry);
  }

  /**
   * Records a triage error to the in-memory log.
   */
  logError(observationId: string, message: string): void {
    this.errorEntries.push({
      observationId,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  /** Returns all accumulated audit entries. */
  getEntries(): ReadonlyArray<TriageAuditEntry> {
    return this.entries;
  }

  /** Returns all accumulated error entries (for diagnostics). */
  getErrorEntries(): ReadonlyArray<{ observationId: string; message: string; timestamp: string }> {
    return this.errorEntries;
  }

  /**
   * Flushes all accumulated entries to disk as JSONL (append mode).
   * Creates parent directories if needed.
   */
  async flush(): Promise<void> {
    if (this.entries.length === 0 && this.errorEntries.length === 0) return;

    const dir = path.dirname(this.logPath);
    await fs.mkdir(dir, { recursive: true });

    const lines: string[] = [];

    for (const entry of this.entries) {
      lines.push(JSON.stringify(entry));
    }

    for (const errEntry of this.errorEntries) {
      lines.push(
        JSON.stringify({
          type: 'error',
          observation_id: errEntry.observationId,
          message: errEntry.message,
          timestamp: errEntry.timestamp,
        }),
      );
    }

    if (lines.length > 0) {
      await fs.appendFile(this.logPath, lines.join('\n') + '\n', 'utf-8');
    }
  }
}
