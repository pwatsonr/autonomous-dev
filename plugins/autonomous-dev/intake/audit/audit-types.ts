/**
 * Audit-event type catalog (SPEC-019-4-04, Task 7).
 *
 * The discriminated union of event types every PLAN-019 emitter writes
 * through `AuditWriter.append()`. Adding a new event type is a schema bump
 * — downstream verifier/query CLIs filter on these literal strings.
 *
 * Cross-reference: TDD-019 §14 (audit metadata).
 *
 * @module intake/audit/audit-types
 */

/**
 * Closed-world set of audit event types emitted by PLAN-019 surfaces.
 *
 * - `plugin_registered` / `plugin_rejected` / `plugin_revoked` — trust-validator
 *   lifecycle decisions for third-party plugins.
 * - `trust_decision` — per-plugin trust scoring snapshot.
 * - `hook_invoked` — one entry per `HookResult` (success or non-blocking failure).
 * - `hook_blocked` — emitted just before `HookBlockedError` is thrown.
 * - `reviewer_verdict` — per-reviewer Verdict with fingerprint.
 * - `reviewer_fallback` — built-in PRD-004 reviewer fallback was triggered.
 * - `audit_key_rotated` — first entry after key bootstrap; the only event
 *   permitted to chain `prev_hmac: GENESIS` mid-log.
 */
export type AuditEventType =
  | 'plugin_registered'
  | 'plugin_rejected'
  | 'plugin_revoked'
  | 'trust_decision'
  | 'hook_invoked'
  | 'hook_blocked'
  | 'reviewer_verdict'
  | 'reviewer_fallback'
  | 'audit_key_rotated';

/** Sentinel value for the first entry's `prev_hmac` and post-key-rotation entries. */
export const GENESIS_HMAC = 'GENESIS';

/**
 * Common shape of every entry written to the audit log.
 *
 * `hmac` signs the canonical JSON of `{ts, type, plugin_id, plugin_version,
 * payload}` concatenated AFTER `prev_hmac`. The `prev_hmac` field is part of
 * the signed input via concatenation — it is intentionally NOT inside the
 * canonicalized object so we sign it exactly once per entry.
 *
 * Cross-reference: SPEC-019-4-04 Audit Entry Shape; SPEC-019-4-04 Notes.
 */
export interface AuditEntryCommon {
  /** ISO-8601 UTC timestamp with millisecond precision. */
  ts: string;
  type: AuditEventType;
  /** Payload schema depends on `type`; concrete shapes per emitter. */
  payload: Record<string, unknown>;
  /** Plugin identity; `built-in` for first-party events. */
  plugin_id: string;
  plugin_version: string;
  /** HMAC of the previous entry; literal `GENESIS` for the first line. */
  prev_hmac: string;
  /** HMAC of `prev_hmac + canonicalize({ts, type, plugin_id, plugin_version, payload})`. */
  hmac: string;
}

/** Input shape accepted by `AuditWriter.append` (writer fills `prev_hmac` + `hmac`). */
export type AuditEntryInput = Omit<AuditEntryCommon, 'prev_hmac' | 'hmac'>;

/**
 * Maximum line size in bytes for a single audit entry. Chosen to stay
 * within `PIPE_BUF` (4096 on Linux/macOS) so a single `write(2)` call
 * cannot interleave with concurrent appenders. Payloads that would push
 * the serialized line over this cap are truncated with `_truncated: true`.
 */
export const MAX_ENTRY_BYTES = 4096;

/** Soft cap on the canonicalized payload before truncation. */
export const MAX_PAYLOAD_BYTES = 3800;
