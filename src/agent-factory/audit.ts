/**
 * Audit Logger (SPEC-005-1-3, Task 8).
 *
 * Append-only JSONL writer for security and operational events.
 * Writes one JSON object per line to `data/agent-audit.log`.
 *
 * Design constraints:
 *   - File is opened in append mode; never truncated or overwritten.
 *   - File is created on first write if it does not exist.
 *   - On write failure, logs to stderr and continues (never crashes).
 *   - Each line is a self-contained JSON object with ISO 8601 timestamp.
 */

import * as fs from 'fs';
import * as path from 'path';
import { AuditEvent, AuditEventType } from './types';

// Re-export for convenience
export type { AuditEvent, AuditEventType };

// ---------------------------------------------------------------------------
// AuditLogger
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL audit log writer.
 *
 * Usage:
 * ```ts
 * const logger = new AuditLogger('/path/to/data/agent-audit.log');
 * logger.log({
 *   timestamp: new Date().toISOString(),
 *   event_type: 'tool_call_blocked',
 *   agent_name: 'prd-author',
 *   details: { tool: 'Bash', reason: 'Tool not authorized' },
 * });
 * ```
 */
export class AuditLogger {
  private readonly logPath: string;
  private fd: number | null = null;

  /**
   * Create an AuditLogger that writes to the specified file path.
   *
   * The file is opened lazily on first write. The directory is created
   * if it does not exist.
   *
   * @param logPath  Absolute or relative path to the audit log file.
   */
  constructor(logPath: string) {
    this.logPath = path.resolve(logPath);
  }

  /**
   * Append an audit event to the log file.
   *
   * Each event is serialized as a single JSON line followed by a newline.
   * On failure, the error is logged to stderr but the system continues.
   *
   * @param event  The audit event to log.
   */
  log(event: AuditEvent): void {
    try {
      this.ensureOpen();
      const line = JSON.stringify(event) + '\n';
      fs.writeSync(this.fd!, line);
    } catch (err) {
      // Never crash on write failure — log to stderr and continue
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[AUDIT_ERROR] Failed to write audit event: ${message}\n`,
      );
    }
  }

  /**
   * Close the file descriptor if open.
   *
   * Call this during graceful shutdown to flush pending writes.
   */
  close(): void {
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Ignore close errors during shutdown
      }
      this.fd = null;
    }
  }

  /**
   * Return the resolved path of the audit log file.
   */
  getLogPath(): string {
    return this.logPath;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Ensure the log file is open in append mode.
   * Creates the parent directory and file if they do not exist.
   */
  private ensureOpen(): void {
    if (this.fd !== null) return;

    // Create the parent directory if needed
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Open in append mode — creates if not exists, never truncates
    this.fd = fs.openSync(this.logPath, 'a');
  }
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/**
 * Create an AuditLogger with the default log path relative to a base directory.
 *
 * @param baseDir  The plugin or project root directory.
 * @returns        An AuditLogger writing to `<baseDir>/data/agent-audit.log`.
 */
export function createAuditLogger(baseDir: string): AuditLogger {
  const logPath = path.join(baseDir, 'data', 'agent-audit.log');
  return new AuditLogger(logPath);
}
