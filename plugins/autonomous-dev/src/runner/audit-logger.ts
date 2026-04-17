/**
 * Run-level audit log writer (SPEC-007-1-4, Task 9).
 *
 * Writes structured log entries to `.autonomous-dev/logs/intelligence/RUN-<id>.log`.
 * Each entry is timestamped with ISO 8601 and tagged with a severity level.
 *
 * Log format:
 *   [2026-04-08T14:30:00Z] [INFO] Run RUN-20260408-143000 started
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { RunMetadata } from './observation-runner';

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL';

export interface AuditLogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
}

export class AuditLogger {
  private readonly logPath: string;
  private readonly entries: AuditLogEntry[] = [];
  private readonly runId: string;
  private closed = false;

  /**
   * @param runId The run ID (e.g. "RUN-20260408-143000")
   * @param logDir The directory where log files are written
   *               (defaults to .autonomous-dev/logs/intelligence under rootDir)
   */
  constructor(runId: string, logDir: string) {
    this.runId = runId;
    this.logPath = path.join(logDir, `${runId}.log`);
  }

  /** Returns the absolute path to this run's log file. */
  getLogPath(): string {
    return this.logPath;
  }

  /** Returns all log entries accumulated so far. */
  getEntries(): ReadonlyArray<AuditLogEntry> {
    return this.entries;
  }

  /**
   * Formats a single log entry as a string.
   */
  private formatEntry(entry: AuditLogEntry): string {
    return `[${entry.timestamp}] [${entry.level}] ${entry.message}`;
  }

  /**
   * Records a log entry at the given severity level.
   */
  private log(level: LogLevel, message: string): void {
    if (this.closed) {
      throw new Error(`AuditLogger for ${this.runId} is already closed`);
    }
    this.entries.push({
      timestamp: new Date().toISOString(),
      level,
      message,
    });
  }

  info(message: string): void {
    this.log('INFO', message);
  }

  warn(message: string): void {
    this.log('WARN', message);
  }

  error(message: string): void {
    this.log('ERROR', message);
  }

  critical(message: string): void {
    this.log('CRITICAL', message);
  }

  /**
   * Writes run metadata as a JSON block appended to the end of the log.
   */
  async writeMetadata(metadata: RunMetadata): Promise<void> {
    if (this.closed) {
      throw new Error(`AuditLogger for ${this.runId} is already closed`);
    }
    this.info(`Run completed. ${metadata.observations_generated} observations generated. ${metadata.total_tokens_consumed} tokens consumed.`);
  }

  /**
   * Flushes all accumulated entries to disk and closes the logger.
   * After close() is called, no further log entries can be recorded.
   */
  async close(): Promise<void> {
    if (this.closed) return;

    const logDir = path.dirname(this.logPath);
    await fs.mkdir(logDir, { recursive: true });

    const content = this.entries.map((e) => this.formatEntry(e)).join('\n') + '\n';
    await fs.writeFile(this.logPath, content, 'utf-8');

    this.closed = true;
  }

  /** Returns true if the logger has been closed. */
  isClosed(): boolean {
    return this.closed;
  }
}
