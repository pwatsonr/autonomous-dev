/**
 * SHA-256 Hash Chain Computer (SPEC-009-5-2, Task 3).
 *
 * Computes a SHA-256 hash chain over audit events, providing cryptographic
 * proof that the event log has not been modified after the fact. Events
 * cannot be inserted, deleted, reordered, or altered without breaking the
 * chain.
 *
 * Algorithm:
 *   1. Canonical serialization: deep-sort all object keys, JSON.stringify
 *      with no whitespace.
 *   2. Concatenate canonical string with the previous event's hash.
 *   3. SHA-256 hash the concatenation, hex-encode the result.
 *
 * The first event in the log uses "GENESIS" as its prev_hash.
 *
 * In disabled mode (Phase 1/2), both hash and prev_hash are empty strings.
 */

import { createHash } from 'crypto';
import { AuditEvent } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sentinel value for the first event's prev_hash. */
export const GENESIS_HASH = 'GENESIS';

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------

/**
 * Recursively sort all object keys at every nesting level.
 *
 * - Objects: keys sorted lexicographically, values recursed.
 * - Arrays: elements recursed in original order (not sorted).
 * - Primitives: returned as-is.
 *
 * This ensures deterministic JSON serialization regardless of property
 * insertion order.
 */
export function deepSortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(deepSortKeys);
  }
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = deepSortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

/**
 * Produce a canonical JSON string for an audit event (excluding hash fields).
 *
 * Determinism guarantees:
 * - All object keys sorted lexicographically at every nesting level.
 * - No whitespace in JSON output.
 * - Numbers serialized with JSON.stringify (IEEE 754).
 * - Dates serialized as ISO 8601 strings (already strings in the event).
 * - undefined values excluded (JSON.stringify handles this).
 */
export function canonicalize(
  event: Omit<AuditEvent, 'hash' | 'prev_hash'>,
): string {
  const sorted = deepSortKeys(event);
  return JSON.stringify(sorted);
}

// ---------------------------------------------------------------------------
// HashChainComputer
// ---------------------------------------------------------------------------

export class HashChainComputer {
  /**
   * @param enabled  When false (Phase 1/2), computeHash returns empty strings.
   *                 When true (Phase 3+), full SHA-256 chain is computed.
   */
  constructor(private enabled: boolean) {}

  /**
   * Compute the SHA-256 hash for an event, chaining to the previous hash.
   *
   * @param event     The audit event without hash/prev_hash fields.
   * @param prevHash  The hash of the previous event, or "GENESIS" for the
   *                  first event in the log.
   * @returns         An object with `hash` (hex-encoded SHA-256) and
   *                  `prev_hash` (the prevHash that was chained).
   */
  computeHash(
    event: Omit<AuditEvent, 'hash' | 'prev_hash'>,
    prevHash: string,
  ): { hash: string; prev_hash: string } {
    if (!this.enabled) {
      return { hash: '', prev_hash: '' };
    }

    // Step 1: Canonical serialization (sorted keys, no whitespace)
    const canonical = canonicalize(event);

    // Step 2: SHA-256 of canonical + prevHash
    const hash = createHash('sha256')
      .update(canonical + prevHash)
      .digest('hex');

    // Step 3: Return hex-encoded hash and the chained prev_hash
    return { hash, prev_hash: prevHash };
  }

  /** Whether hash chain computation is enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }
}
