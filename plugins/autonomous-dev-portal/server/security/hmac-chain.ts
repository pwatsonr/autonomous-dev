// SPEC-014-3-03 §Task 2 — hmac-chain (pure functions).
//
// Two zero-I/O, zero-state primitives that form the verification
// contract for AuditLogger:
//
//   canonicalEntryJson(entry) -> deterministic JSON bytes
//   computeEntryHmac(key, prevHmac, entry) -> hex HMAC-SHA256
//
// Both are pure so the verifier (and any external auditor) can reproduce
// the chain off-line by reading the same NDJSON file, in any process.
//
// Canonical key order: timestamp, sequence, action, user, resource,
// details, previous_hmac, key_id. The `entry_hmac` field is excluded
// from the canonical bytes (it is the OUTPUT of the HMAC). Any key
// reorder breaks reproducibility — this is the same property that
// makes JWS payloads byte-stable.

import { createHmac } from "node:crypto";

/**
 * Audit log entry shape — written to the NDJSON file one per line.
 * `entry_hmac` is computed AFTER the rest of the fields and is the
 * only field that is NOT part of the canonical HMAC input.
 */
export interface AuditEntry {
    timestamp: string; // ISO-8601 UTC, ms precision
    sequence: number; // monotonic, starts at 1
    action: string; // e.g. "request.submit"
    user: string; // operator identity
    resource: string; // affected resource (e.g. "REQ-000123")
    details: Record<string, unknown>;
    previous_hmac: string; // hex string, "" for sequence=1
    key_id: string;
    entry_hmac: string; // hex string of HMAC-SHA256
}

/** Fields hashed into the chain, in the canonical (fixed) order. */
const CANONICAL_FIELD_ORDER: ReadonlyArray<keyof Omit<AuditEntry, "entry_hmac">> = [
    "timestamp",
    "sequence",
    "action",
    "user",
    "resource",
    "details",
    "previous_hmac",
    "key_id",
];

/**
 * Produce a deterministic JSON serialisation of `entry`. Keys are
 * emitted in the fixed CANONICAL_FIELD_ORDER. Values are serialised
 * with the platform's `JSON.stringify` — caller is responsible for
 * ensuring no NaN / Infinity values are present (HMAC over those
 * would be non-portable).
 */
export function canonicalEntryJson(
    entry: Omit<AuditEntry, "entry_hmac">,
): string {
    // Build a fresh object in canonical order so JSON.stringify emits
    // keys in that order (V8 preserves insertion order for string keys).
    const ordered: Record<string, unknown> = {};
    for (const k of CANONICAL_FIELD_ORDER) {
        ordered[k] = entry[k];
    }
    return JSON.stringify(ordered);
}

/**
 * Compute the chained HMAC for one entry.
 *   data   = prev_hmac || canonical_entry_json
 *   result = hex(HMAC-SHA256(key, data))
 *
 * `key` is a Buffer of the raw symmetric key (32 bytes). `prevHmac`
 * is the hex string of the prior entry's HMAC, or "" for sequence 1.
 */
export function computeEntryHmac(
    key: Buffer,
    prevHmac: string,
    entry: Omit<AuditEntry, "entry_hmac">,
): string {
    const data = prevHmac + canonicalEntryJson(entry);
    return createHmac("sha256", key).update(data, "utf8").digest("hex");
}
