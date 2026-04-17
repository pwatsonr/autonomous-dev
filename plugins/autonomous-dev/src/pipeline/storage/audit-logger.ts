import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import { DirectoryManager } from './directory-manager';

export interface PipelineEvent {
  /** UUID v4 event ID */
  eventId: string;
  /** Pipeline this event belongs to */
  pipelineId: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event type (e.g. 'document_created', 'version_created', etc.) */
  eventType: string;
  /** Document ID, if this event is about a specific document */
  documentId?: string;
  /** Free-form details about the event */
  details: Record<string, unknown>;
  /** Agent or system that triggered the event */
  actorId: string;
  /** SHA-256 hash of the previous log entry (hash chain) */
  previousHash: string;
}

/**
 * Append-only audit logger with hash chain integrity.
 *
 * Format: Newline-delimited JSON (JSONL).
 * Each line is a JSON-serialized PipelineEvent.
 * Each event includes a hash of the previous event's JSON string.
 * First event uses previousHash = SHA-256 of empty string.
 *
 * File is opened in append mode only (flag 'a').
 */
export class AuditLogger {
  /** Hash of the last event appended (in-memory cache) */
  private lastHash: string | null = null;

  constructor(private readonly directoryManager: DirectoryManager) {}

  /**
   * Appends a pipeline event to the audit log.
   *
   * Steps:
   *   1. If lastHash is null, read the last line of the log to initialize it.
   *      If the log is empty, use SHA-256('') as the initial previous hash.
   *   2. Set event.previousHash = lastHash
   *   3. Serialize event to JSON (single line, no newlines in values)
   *   4. Append line + '\n' to audit.log using fs.appendFile
   *   5. Update lastHash = SHA-256(serialized line)
   */
  async appendEvent(
    pipelineId: string,
    eventType: string,
    details: Record<string, unknown>,
    actorId: string,
    documentId?: string,
  ): Promise<PipelineEvent> {
    const logPath = this.directoryManager.getAuditLogPath(pipelineId);

    // Initialize hash chain if needed
    if (this.lastHash === null) {
      this.lastHash = await this.getLastHash(logPath);
    }

    const event: PipelineEvent = {
      eventId: crypto.randomUUID(),
      pipelineId,
      timestamp: new Date().toISOString(),
      eventType,
      documentId,
      details,
      actorId,
      previousHash: this.lastHash,
    };

    const line = JSON.stringify(event);
    await fs.appendFile(logPath, line + '\n', 'utf-8');

    this.lastHash = crypto.createHash('sha256').update(line).digest('hex');
    return event;
  }

  /**
   * Reads all events from the audit log for a pipeline.
   * Verifies hash chain integrity on read.
   *
   * @throws AuditIntegrityError if hash chain is broken
   */
  async readEvents(pipelineId: string): Promise<PipelineEvent[]> {
    const logPath = this.directoryManager.getAuditLogPath(pipelineId);
    const content = await fs.readFile(logPath, 'utf-8');
    if (!content.trim()) return [];

    const lines = content.trim().split('\n');
    const events: PipelineEvent[] = [];
    let expectedPreviousHash = crypto.createHash('sha256').update('').digest('hex');

    for (let i = 0; i < lines.length; i++) {
      const event = JSON.parse(lines[i]) as PipelineEvent;
      if (event.previousHash !== expectedPreviousHash) {
        throw new AuditIntegrityError(i, expectedPreviousHash, event.previousHash);
      }
      events.push(event);
      expectedPreviousHash = crypto.createHash('sha256').update(lines[i]).digest('hex');
    }

    return events;
  }

  private async getLastHash(logPath: string): Promise<string> {
    try {
      const content = await fs.readFile(logPath, 'utf-8');
      const lines = content.trim().split('\n').filter(l => l.length > 0);
      if (lines.length === 0) {
        return crypto.createHash('sha256').update('').digest('hex');
      }
      return crypto.createHash('sha256').update(lines[lines.length - 1]).digest('hex');
    } catch {
      return crypto.createHash('sha256').update('').digest('hex');
    }
  }
}

export class AuditIntegrityError extends Error {
  constructor(
    public readonly lineIndex: number,
    public readonly expectedHash: string,
    public readonly actualHash: string,
  ) {
    super(`Audit log integrity violation at line ${lineIndex}: expected ${expectedHash}, got ${actualHash}`);
    this.name = 'AuditIntegrityError';
  }
}
