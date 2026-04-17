/**
 * Scrubbing Audit Logger — SPEC-007-2-2, Task 5.
 *
 * Writes a JSON audit entry for every `scrub()` invocation, matching
 * the format from TDD section 3.4.5.
 *
 * Each entry records per-type redaction counts, processing time,
 * validation status, and any SCRUB_FAILED fields.
 */

import type {
  AuditLogger,
  ScrubAuditEntry,
  ScrubContext,
  ScrubResult,
} from './types';

// ---------------------------------------------------------------------------
// ScrubAuditLogger
// ---------------------------------------------------------------------------

/**
 * Writes structured audit entries for every scrub invocation.
 *
 * Delegates to an `AuditLogger` backend for actual persistence
 * (file, stdout, remote, etc.).
 */
export class ScrubAuditLogger {
  constructor(private auditLog: AuditLogger) {}

  /**
   * Build and write a single audit entry from a `ScrubResult` and context.
   *
   * Aggregates per-type redaction counts from the redaction list and
   * produces a JSON entry matching the TDD 3.4.5 format.
   *
   * @param result   The result of a `scrub()` invocation.
   * @param context  The invocation context (runId, service, source, lineCount).
   */
  logScrub(result: ScrubResult, context: ScrubContext): void {
    const counts: Record<string, number> = {};
    for (const r of result.redactions) {
      counts[r.type] = (counts[r.type] || 0) + 1;
    }

    const entry: ScrubAuditEntry = {
      run_id: context.runId,
      service: context.service,
      source: context.source,
      lines_processed: context.lineCount,
      redactions: counts,
      processing_time_ms: result.processing_time_ms,
      validation_passed: result.validation_passed,
      scrub_failed_fields: result.scrub_failed_fields,
      timestamp: new Date().toISOString(),
    };

    this.auditLog.appendJson(entry);
  }

  /**
   * Log a scrub timeout error.
   *
   * @param context  The invocation context.
   * @param timeoutMs  The timeout threshold that was exceeded.
   */
  logTimeout(context: ScrubContext, timeoutMs: number): void {
    this.auditLog.error(
      `Scrubbing timeout for ${context.service}/${context.source}. ` +
        `Exceeded ${timeoutMs}ms. Data discarded.`,
    );

    const entry: ScrubAuditEntry = {
      run_id: context.runId,
      service: context.service,
      source: context.source,
      lines_processed: context.lineCount,
      redactions: {},
      processing_time_ms: timeoutMs,
      validation_passed: false,
      scrub_failed_fields: ['*'],
      timestamp: new Date().toISOString(),
    };

    this.auditLog.appendJson(entry);
  }
}

// ---------------------------------------------------------------------------
// In-memory audit logger (for testing)
// ---------------------------------------------------------------------------

/**
 * A simple in-memory `AuditLogger` that stores entries in arrays.
 * Useful for testing without file I/O.
 */
export class InMemoryAuditLogger implements AuditLogger {
  readonly entries: ScrubAuditEntry[] = [];
  readonly errors: string[] = [];

  appendJson(entry: ScrubAuditEntry): void {
    this.entries.push(entry);
  }

  error(message: string): void {
    this.errors.push(message);
  }

  /** Clear all stored entries and errors. */
  clear(): void {
    this.entries.length = 0;
    this.errors.length = 0;
  }
}
