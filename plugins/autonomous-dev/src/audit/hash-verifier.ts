/**
 * Hash Chain Verifier (SPEC-009-5-2, Task 4).
 *
 * Validates the entire audit event log for tamper evidence by replaying
 * the SHA-256 hash chain. Detects three classes of tampering:
 *
 *   - Modified payload   -> hash_mismatch (recomputed hash differs)
 *   - Deleted event      -> prev_hash_mismatch (chain link broken)
 *   - Reordered events   -> prev_hash_mismatch (chain link broken)
 *
 * Design constraints:
 *   - Streaming verification: reads line-by-line via readline, never loads
 *     the entire file into memory.
 *   - Integrity failures do NOT halt the pipeline (TDD Section 6). The
 *     verifier returns a VerificationResult and logs failures to a separate
 *     integrity log file.
 *   - Integrity failures emit immediate-urgency notifications.
 */

import { createReadStream, existsSync, appendFileSync, mkdirSync } from 'fs';
import { createInterface } from 'readline';
import { createHash } from 'crypto';
import { dirname } from 'path';
import { AuditEvent, VerificationResult, IntegrityError } from './types';
import { HashChainComputer, GENESIS_HASH, canonicalize } from './hash-chain';

// ---------------------------------------------------------------------------
// HashChainVerifier
// ---------------------------------------------------------------------------

export class HashChainVerifier {
  /**
   * @param hashComputer      A HashChainComputer instance (must be enabled
   *                          for verification to be meaningful).
   * @param integrityLogPath  Optional path to a separate log file for
   *                          integrity failure records. If not provided,
   *                          failures are only returned in the result.
   */
  constructor(
    private hashComputer: HashChainComputer,
    private integrityLogPath?: string,
  ) {}

  /**
   * Verify the entire event log at the given path.
   *
   * Reads the JSONL file line-by-line (streaming) and replays the hash
   * chain, collecting all integrity errors found. Returns a full
   * VerificationResult -- never throws for integrity failures.
   *
   * @param logPath  Path to the events.jsonl file to verify.
   * @returns        VerificationResult with validity, error details, and
   *                 the chain head hash.
   */
  async verify(logPath: string): Promise<VerificationResult> {
    const errors: IntegrityError[] = [];
    let prevHash = GENESIS_HASH;
    let totalEvents = 0;
    let chainHeadHash = GENESIS_HASH;

    // Handle missing or empty file
    if (!existsSync(logPath)) {
      return {
        valid: true,
        totalEvents: 0,
        errors: [],
        chainHeadHash: GENESIS_HASH,
      };
    }

    // Stream line-by-line to avoid loading entire file into memory
    const fileStream = createReadStream(logPath, { encoding: 'utf-8' });
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lineNumber = 0;

    for await (const line of rl) {
      // Skip blank lines
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      lineNumber++;
      totalEvents++;

      let event: AuditEvent;
      try {
        event = JSON.parse(trimmed) as AuditEvent;
      } catch {
        errors.push({
          lineNumber,
          eventId: 'PARSE_ERROR',
          errorType: 'hash_mismatch',
          expected: 'valid JSON',
          actual: trimmed.substring(0, 80),
          message: `Line ${lineNumber}: failed to parse JSON`,
        });
        continue;
      }

      // Check 1: prev_hash chain continuity
      if (event.prev_hash !== prevHash) {
        errors.push({
          lineNumber,
          eventId: event.event_id ?? 'unknown',
          errorType: 'prev_hash_mismatch',
          expected: prevHash,
          actual: event.prev_hash,
          message: `Line ${lineNumber}: prev_hash mismatch -- expected "${prevHash}", got "${event.prev_hash}"`,
        });
      }

      // Check 2: recompute hash and compare
      // Extract the event fields without hash and prev_hash
      const { hash: _hash, prev_hash: _prevHash, ...eventWithoutHash } = event;
      const expectedHash = createHash('sha256')
        .update(canonicalize(eventWithoutHash) + event.prev_hash)
        .digest('hex');

      if (event.hash !== expectedHash) {
        errors.push({
          lineNumber,
          eventId: event.event_id ?? 'unknown',
          errorType: 'hash_mismatch',
          expected: expectedHash,
          actual: event.hash,
          message: `Line ${lineNumber}: hash mismatch -- recomputed hash does not match stored hash`,
        });
      }

      // Advance chain pointer
      prevHash = event.hash;
      chainHeadHash = event.hash;
    }

    const result: VerificationResult = {
      valid: errors.length === 0,
      totalEvents,
      errors,
      chainHeadHash,
    };

    // If errors found, log to integrity log and emit notification
    if (errors.length > 0) {
      this.logIntegrityFailure(errors, logPath);
      // Do NOT halt pipeline (TDD Section 6) -- return normally
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Log integrity failures to a separate log file (not the main events.jsonl,
   * since that file may be compromised).
   *
   * Each failure record is a JSONL line with timestamp, source log path,
   * and the error details.
   */
  private logIntegrityFailure(
    errors: IntegrityError[],
    sourceLogPath: string,
  ): void {
    if (!this.integrityLogPath) return;

    try {
      // Ensure directory exists
      const dir = dirname(this.integrityLogPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      const record = {
        timestamp: new Date().toISOString(),
        event_type: 'hash_chain_integrity_failure',
        urgency: 'immediate',
        source_log: sourceLogPath,
        error_count: errors.length,
        errors,
      };

      appendFileSync(
        this.integrityLogPath,
        JSON.stringify(record) + '\n',
        'utf-8',
      );
    } catch (err) {
      // Never crash on integrity log write failure -- log to stderr
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[INTEGRITY_LOG_ERROR] Failed to write integrity failure: ${message}\n`,
      );
    }
  }
}
