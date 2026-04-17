/**
 * AuditTrailEngine facade (SPEC-009-5-7, Task 18).
 *
 * Main entry point for the audit trail subsystem. Implements the AuditTrail
 * interface consumed by all other PLAN-009 subsystems, plus replay and
 * verification capabilities.
 *
 * Composes:
 *   - AuditEventWriter: append-only JSONL writer
 *   - HashChainComputer: optional SHA-256 hash chain
 *   - DecisionReplay: per-request event filtering
 *   - HashChainVerifier: tamper-evidence verification
 */

import type { AuditEvent, VerificationResult } from './types';
import type { AuditEventWriter, PartialAuditEvent } from './event-writer';
import type { HashChainComputer } from './hash-chain';
import type { DecisionReplay } from './decision-replay';
import type { HashChainVerifier } from './hash-verifier';

// ---------------------------------------------------------------------------
// AuditTrail interface (consumed by other PLAN-009 subsystems)
// ---------------------------------------------------------------------------

/**
 * Minimal interface that other plans depend on.
 * Only exposes append -- replay and verification are engine-only.
 */
export interface AuditTrail {
  append(
    event: Omit<AuditEvent, 'event_id' | 'timestamp' | 'hash' | 'prev_hash'>,
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// AuditTrailEngine
// ---------------------------------------------------------------------------

export class AuditTrailEngine implements AuditTrail {
  constructor(
    private writer: AuditEventWriter,
    private hashChain: HashChainComputer,
    private replayEngine: DecisionReplay,
    private verifier: HashChainVerifier,
    private logPath: string,
  ) {}

  /**
   * Append an event to the audit log.
   *
   * Used by all other subsystems via the AuditTrail interface.
   * Auto-generates event_id, timestamp, hash, and prev_hash.
   */
  async append(
    event: Omit<AuditEvent, 'event_id' | 'timestamp' | 'hash' | 'prev_hash'>,
  ): Promise<void> {
    await this.writer.append(event as PartialAuditEvent);
  }

  /**
   * Replay events for a specific request ID.
   *
   * Returns all audit events associated with the given request in
   * chronological order.
   */
  async replay(requestId: string): Promise<AuditEvent[]> {
    return this.replayEngine.replay(requestId);
  }

  /**
   * Verify the hash chain integrity of the entire audit log.
   *
   * Returns a VerificationResult with validity status, total events,
   * any integrity errors, and the chain head hash.
   */
  async verify(): Promise<VerificationResult> {
    return this.verifier.verify(this.logPath);
  }
}
