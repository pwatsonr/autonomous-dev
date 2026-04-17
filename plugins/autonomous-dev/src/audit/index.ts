/**
 * Audit module barrel exports (SPEC-009-5-7, Task 20).
 */

export { AuditTrailEngine } from './audit-trail-engine';
export type { AuditTrail } from './audit-trail-engine';
export { AuditEventWriter } from './event-writer';
export type { PartialAuditEvent, EscalationCallback } from './event-writer';
export type { HashChainComputer as HashChainComputerInterface } from './event-writer';
export { HashChainComputer } from './hash-chain';
export { GENESIS_HASH, canonicalize, deepSortKeys } from './hash-chain';
export { HashChainVerifier } from './hash-verifier';
export { DecisionReplay, formatNarrative } from './decision-replay';
export { LogArchival } from './log-archival';
export type { ArchiveResult, ArchiveInfo } from './log-archival';
export { loadAuditConfig } from './audit-config';
export type { AuditConfig } from './audit-config';
export * from './types';

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

import type { AuditConfig } from './audit-config';
import { AuditEventWriter } from './event-writer';
import { HashChainComputer as HashChainComputerClass } from './hash-chain';
import { HashChainVerifier } from './hash-verifier';
import { DecisionReplay } from './decision-replay';
import { AuditTrailEngine } from './audit-trail-engine';

/**
 * Create a fully-wired AuditTrailEngine from config.
 *
 * Instantiates all dependencies and connects them:
 *   - HashChainComputer with enabled flag from config
 *   - AuditEventWriter with log path and hash chain
 *   - DecisionReplay with log path
 *   - HashChainVerifier with hash chain computer
 *   - AuditTrailEngine composing all of the above
 */
export function createAuditTrailEngine(config: AuditConfig): AuditTrailEngine {
  const hashChain = new HashChainComputerClass(
    config.integrity.hash_chain_enabled,
  );

  const writer = new AuditEventWriter(config.log_path, hashChain);
  const replay = new DecisionReplay(config.log_path);

  const integrityLogPath = config.log_path.replace(
    /\.jsonl$/,
    '.integrity.jsonl',
  );
  const verifier = new HashChainVerifier(hashChain, integrityLogPath);

  return new AuditTrailEngine(writer, hashChain, replay, verifier, config.log_path);
}
