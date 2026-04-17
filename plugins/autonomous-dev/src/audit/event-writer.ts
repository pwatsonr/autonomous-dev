/**
 * Audit Event Writer (SPEC-009-5-1, Task 2).
 *
 * Append-only JSONL writer for audit events with:
 *   - Atomic append via O_APPEND + fsync
 *   - File-level mutex (lock file with O_CREAT | O_EXCL spin-lock)
 *   - Retry with exponential backoff (3 attempts)
 *   - In-memory buffer for events that fail all retries
 *   - Automatic buffer flush on next successful write
 *
 * Every audit event from every subsystem passes through this writer.
 * It must be reliable, concurrent-safe, and never truncate the log.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import { AuditEvent, AuditEventType } from './types';

// ---------------------------------------------------------------------------
// HashChainComputer interface (implemented in SPEC-009-5-2)
// ---------------------------------------------------------------------------

/**
 * Interface for the hash chain computer.
 * Optional dependency -- when not provided, hash fields are empty strings.
 */
export interface HashChainComputer {
  computeHash(
    event: Omit<AuditEvent, 'hash' | 'prev_hash'>,
    prevHash: string,
  ): { hash: string; prev_hash: string };
}

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [0, 100, 500]; // Attempt 1: immediate, 2: 100ms, 3: 500ms

// ---------------------------------------------------------------------------
// Lock file spin-lock configuration
// ---------------------------------------------------------------------------

const LOCK_SPIN_INTERVAL_MS = 5;
const LOCK_SPIN_MAX_WAIT_MS = 10_000; // 10 seconds max wait for lock

// ---------------------------------------------------------------------------
// Partial event type (fields auto-populated by the writer)
// ---------------------------------------------------------------------------

export type PartialAuditEvent = Omit<AuditEvent, 'event_id' | 'timestamp' | 'hash' | 'prev_hash'>;

// ---------------------------------------------------------------------------
// Infrastructure escalation callback
// ---------------------------------------------------------------------------

export type EscalationCallback = (message: string, event: AuditEvent) => void;

// ---------------------------------------------------------------------------
// AuditEventWriter
// ---------------------------------------------------------------------------

export class AuditEventWriter {
  private lastHash: string = '';
  private pendingBuffer: AuditEvent[] = [];
  private onEscalation: EscalationCallback | null = null;

  constructor(
    private readonly logPath: string,
    private readonly hashChain?: HashChainComputer,
  ) {}

  /**
   * Register a callback invoked when a persistent write failure occurs.
   * Used to raise infrastructure escalations.
   */
  setEscalationCallback(callback: EscalationCallback): void {
    this.onEscalation = callback;
  }

  /**
   * Append a single event to the log.
   *
   * Auto-generates event_id (UUID v4), timestamp (ISO 8601 with ms),
   * and hash/prev_hash (empty strings unless hash chain is enabled).
   *
   * On persistent write failure, the event is buffered in memory and
   * an infrastructure escalation is raised.
   *
   * @param partialEvent Event data without auto-generated fields.
   * @returns The complete AuditEvent as written (or buffered).
   */
  async append(partialEvent: PartialAuditEvent): Promise<AuditEvent> {
    // Step 1: Build the complete event
    const event: AuditEvent = {
      ...partialEvent,
      event_id: randomUUID(),
      timestamp: new Date().toISOString(),
      hash: '',
      prev_hash: '',
    };

    // Step 2: Compute hash chain if enabled
    if (this.hashChain) {
      const prevHash = this.getLastHash();
      const { hash, prev_hash } = this.hashChain.computeHash(
        {
          event_id: event.event_id,
          event_type: event.event_type,
          timestamp: event.timestamp,
          request_id: event.request_id,
          repository: event.repository,
          pipeline_phase: event.pipeline_phase,
          agent: event.agent,
          payload: event.payload,
        },
        prevHash,
      );
      event.hash = hash;
      event.prev_hash = prev_hash;
    }

    // Step 3: Attempt to write (with retry)
    // First, try to flush any previously buffered events before the new event.
    // This preserves chronological ordering: buffered events come first.
    if (this.pendingBuffer.length > 0) {
      await this.flushBuffer();
    }

    const writeSucceeded = await this.writeWithRetry(event);

    if (writeSucceeded) {
      // Update last hash on success
      this.lastHash = event.hash;
    } else {
      // Buffer the event and raise escalation
      this.pendingBuffer.push(event);
      this.raiseEscalation(event);
    }

    return event;
  }

  /**
   * Get the last event's hash (for chaining).
   * Returns empty string when hash chain is disabled or no events written.
   */
  getLastHash(): string {
    return this.lastHash;
  }

  /**
   * Get the current number of buffered events awaiting flush.
   * Exposed for testing and monitoring.
   */
  getPendingCount(): number {
    return this.pendingBuffer.length;
  }

  /**
   * Get a copy of the pending buffer.
   * Exposed for testing.
   */
  getPendingBuffer(): AuditEvent[] {
    return [...this.pendingBuffer];
  }

  // -------------------------------------------------------------------------
  // Write with retry + exponential backoff
  // -------------------------------------------------------------------------

  private async writeWithRetry(event: AuditEvent): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      // Delay before retry (attempt 0 = immediate)
      if (RETRY_DELAYS_MS[attempt] > 0) {
        await this.delay(RETRY_DELAYS_MS[attempt]);
      }

      try {
        this.writeEventAtomic(event);
        return true;
      } catch {
        // Continue to next retry attempt
      }
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Atomic write with file-level mutex
  // -------------------------------------------------------------------------

  private writeEventAtomic(event: AuditEvent): void {
    const serialized = JSON.stringify(event);
    const line = serialized + '\n';
    const lockPath = this.logPath + '.lock';

    // Ensure parent directory exists
    const dir = path.dirname(this.logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Acquire file-level mutex
    const lockFd = this.acquireLock(lockPath);
    try {
      // Open in append mode -- creates file if it doesn't exist, never truncates
      const fd = fs.openSync(
        this.logPath,
        fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_CREAT,
      );
      try {
        fs.writeSync(fd, line);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      this.releaseLock(lockFd, lockPath);
    }
  }

  // -------------------------------------------------------------------------
  // File-level mutex (lock file with O_CREAT | O_EXCL)
  // -------------------------------------------------------------------------

  /**
   * Acquire an exclusive lock by creating a lock file with O_CREAT | O_EXCL.
   * Spins until the lock is acquired or the timeout is reached.
   *
   * @returns The file descriptor for the lock file.
   * @throws Error if the lock cannot be acquired within the timeout.
   */
  private acquireLock(lockPath: string): number {
    const deadline = Date.now() + LOCK_SPIN_MAX_WAIT_MS;

    while (true) {
      try {
        // O_CREAT | O_EXCL: fails if file already exists (atomic create)
        const fd = fs.openSync(
          lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        );
        return fd;
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr.code !== 'EEXIST') {
          throw err; // Unexpected error, propagate
        }

        // Lock file exists -- another writer holds the lock
        if (Date.now() >= deadline) {
          // Stale lock detection: forcibly remove and retry once
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // Ignore unlink errors
          }
          throw new Error(
            `Failed to acquire audit log lock at ${lockPath} within ${LOCK_SPIN_MAX_WAIT_MS}ms`,
          );
        }

        // Spin-wait
        this.spinWait(LOCK_SPIN_INTERVAL_MS);
      }
    }
  }

  /**
   * Release the lock by closing the fd and removing the lock file.
   */
  private releaseLock(lockFd: number, lockPath: string): void {
    try {
      fs.closeSync(lockFd);
    } catch {
      // Ignore close errors
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Ignore unlink errors (another process may have already cleaned up)
    }
  }

  /**
   * Synchronous busy-wait for the given number of milliseconds.
   * Used for lock spin-wait to avoid async complexity in the critical section.
   */
  private spinWait(ms: number): void {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      // busy-wait
    }
  }

  // -------------------------------------------------------------------------
  // Buffer flush
  // -------------------------------------------------------------------------

  /**
   * Flush buffered events to disk. Called after a successful write.
   * Events are written in original order (FIFO).
   * If any flush write fails, remaining events stay in the buffer.
   */
  private async flushBuffer(): Promise<void> {
    while (this.pendingBuffer.length > 0) {
      const event = this.pendingBuffer[0];
      try {
        this.writeEventAtomic(event);
        this.pendingBuffer.shift(); // Remove on success
      } catch {
        // Stop flushing on first failure -- remaining events stay buffered
        break;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Infrastructure escalation
  // -------------------------------------------------------------------------

  private raiseEscalation(event: AuditEvent): void {
    const message = `Audit event log write failure: failed to write event ${event.event_id} (${event.event_type}) after ${MAX_RETRIES} attempts. Event buffered in memory.`;

    if (this.onEscalation) {
      this.onEscalation(message, event);
    }

    // Always log to stderr as a fallback
    process.stderr.write(`[AUDIT_ESCALATION] ${message}\n`);
  }

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
