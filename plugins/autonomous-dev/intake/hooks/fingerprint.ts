/**
 * Verdict + input fingerprinting primitives (SPEC-019-4-02, Task 4).
 *
 * Implements the canonical SHA-256 fingerprint format from TDD-019 §11.3:
 * keys sorted lexicographically at every nesting level, no whitespace, no
 * trailing newline; NaN/Infinity rejected; circular references rejected.
 *
 * The fingerprint is used by the gate aggregator to detect verdict drift
 * across iterations and by the audit-writer (SPEC-019-4-04) to stamp every
 * `reviewer_verdict` audit entry. It MUST exclude any per-run timestamps
 * or request IDs so determinism holds across reruns.
 *
 * @module intake/hooks/fingerprint
 */

import { createHash } from 'node:crypto';
import type { Verdict } from './types';

/**
 * Canonical JSON serialization.
 *
 * - Object keys sorted lexicographically at every nesting level.
 * - No whitespace anywhere.
 * - `NaN` and `Infinity` rejected (would round-trip as `null` in
 *   `JSON.stringify` and silently break determinism).
 * - Circular references throw (otherwise infinite recursion).
 * - Functions, symbols, and `undefined` values are dropped at object
 *   level by the standard `Object.keys` walk; `undefined` at the top
 *   level produces the literal string `undefined` (matches JSON.stringify).
 *
 * @throws Error on NaN, Infinity, or circular reference.
 */
export function canonicalize(value: unknown): string {
  return canonicalizeImpl(value, new WeakSet<object>());
}

function canonicalizeImpl(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(
        `canonicalize: non-finite number rejected (${value}); refusing to silently coerce to null`,
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    // string | boolean | bigint(=> stringify will throw, fine) | symbol | function | undefined
    return JSON.stringify(value);
  }
  if (seen.has(value as object)) {
    throw new Error('canonicalize: circular reference detected');
  }
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      const parts = value.map((v) => canonicalizeImpl(v, seen));
      return '[' + parts.join(',') + ']';
    }
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map(
      (k) => JSON.stringify(k) + ':' + canonicalizeImpl(obj[k], seen),
    );
    return '{' + parts.join(',') + '}';
  } finally {
    seen.delete(value as object);
  }
}

/**
 * SHA-256 of the canonicalized input. Same input (semantically) yields the
 * same hash regardless of source key ordering or insertion order.
 *
 * Returns a 64-character lowercase hex string.
 */
export function inputFingerprint(input: unknown): string {
  return createHash('sha256').update(canonicalize(input)).digest('hex');
}

/**
 * Verdict fingerprint per TDD-019 §11.3.
 *
 *   sha256(canonicalize({
 *     plugin_id, plugin_version, agent_name,
 *     input_fingerprint, output_verdict,
 *   }))
 *
 * `output_verdict` is the verdict shape EXCLUDING the `fingerprint` field
 * itself (set after) and EXCLUDING the plugin/agent identity fields (those
 * are hashed at the top level so the fingerprint is plugin-bound but the
 * `verdict` projection stays drift-detectable on its own).
 *
 * Returns a 64-character lowercase hex string.
 */
export function verdictFingerprint(args: {
  plugin_id: string;
  plugin_version: string;
  agent_name: string;
  input_fingerprint: string;
  verdict: Omit<Verdict, 'fingerprint' | 'plugin_id' | 'plugin_version' | 'agent_name'>;
}): string {
  return createHash('sha256')
    .update(
      canonicalize({
        plugin_id: args.plugin_id,
        plugin_version: args.plugin_version,
        agent_name: args.agent_name,
        input_fingerprint: args.input_fingerprint,
        output_verdict: args.verdict,
      }),
    )
    .digest('hex');
}
