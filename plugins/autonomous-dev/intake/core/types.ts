/**
 * Shared types for the two-phase commit handoff (PLAN-012-1).
 *
 * IMPORTANT — see header note on `intake/core/handoff_manager.ts` and the
 * "Mismatch 1" section of the implementation runbook:
 *
 * `RequestSource` and `AdapterMetadata` are defined CANONICALLY in
 * `intake/types/request_source.ts` (landed by SPEC-012-2-03). The literal
 * union in `request_source.ts` is the persistence-layer discriminator and is
 * mirrored by the SQLite CHECK constraint in `002_add_source_metadata.sql`.
 *
 * Earlier draft of SPEC-012-1-01 §Task 1 listed a different RequestSource
 * union (`'cli'|'discord'|'slack'|'github'|'jira'|'cron'`). That draft is
 * superseded — we re-export the canonical type here so PLAN-012-1 callers
 * have a single import location for handoff-flavoured code.
 *
 * Only types unique to PLAN-012-1 (`SubmitRequest`, `HandoffOptions`,
 * `HandoffResult`, error class hierarchy) live in this module.
 *
 * @module core/types
 */

import type {
  AdapterMetadata,
  RequestSource,
} from '../types/request_source';

// ---------------------------------------------------------------------------
// Re-exports of canonical types so PLAN-012-1 callers have one import path
// ---------------------------------------------------------------------------

export type { AdapterMetadata, RequestSource } from '../types/request_source';

// ---------------------------------------------------------------------------
// PLAN-012-1-specific types
// ---------------------------------------------------------------------------

/**
 * Input to `submitRequest`. Constructed by the producer (intake-router /
 * adapter) before invoking the two-phase commit protocol.
 *
 * `requestId` MUST match `^REQ-\d{6}$` — enforced by `validateRequestId`.
 * `repository` MUST be an absolute path that resolves to a directory in the
 * configured allowlist.
 */
export interface SubmitRequest {
  requestId: string;
  description: string;
  priority: 'high' | 'normal' | 'low';
  repository: string;
  source: RequestSource;
  adapterMetadata: AdapterMetadata;
  /** Optional human-readable title (defaults to first 80 chars of description). */
  title?: string;
  /** Optional requester identity (defaults to source-derived value). */
  requesterId?: string;
}

/**
 * Tunables for a single handoff. All fields are optional with defaults:
 *  - `lockTimeoutMs`        : 10000
 *  - `fsync`                : true   (set false ONLY in tests / fixtures)
 *  - `recoverOnConflict`    : true   (currently informational; recovery is
 *                                     opt-in at daemon startup)
 */
export interface HandoffOptions {
  lockTimeoutMs?: number;
  fsync?: boolean;
  recoverOnConflict?: boolean;
}

/**
 * Failure mode classification per SPEC-012-1-01 §"Failure modes":
 *  - F1 — validation/lock; nothing committed anywhere.
 *  - F2 — temp write; SQLite untouched, temp may exist (cleanup).
 *  - F3 — SQLite commit; rolled back, temp must be unlinked.
 *  - F4 — rename after SQLite commit; SQLite has the row, temp marked
 *         `.needs_promotion` for forward-recovery.
 */
export type FailureMode = 'F1' | 'F2' | 'F3' | 'F4';

/**
 * Outcome of a two-phase commit handoff. Discriminated on `ok`.
 *
 * On `ok: true`, `statePath` is the final atomic-rename target; the daemon
 * read path observes this (or the previous) version, never partial.
 *
 * On `ok: false`, `error` is a sanitized human-readable message safe for
 * external surfaces (no FS paths) when the call site sets `untrusted`.
 * `recoverable: true` indicates an operator-actionable transient (F2/F3/F4);
 * `recoverable: false` indicates a programmer error (F1, malformed input).
 */
export type HandoffResult =
  | {
      ok: true;
      requestId: string;
      statePath: string;
      committedAt: string;
    }
  | {
      ok: false;
      requestId: string;
      failureMode: FailureMode;
      error: string;
      recoverable: boolean;
    };

// ---------------------------------------------------------------------------
// Error hierarchy
// ---------------------------------------------------------------------------

/** Discriminator codes for HandoffError subclasses. */
export type HandoffErrorCode =
  | 'PATH_INVALID'
  | 'PATH_ESCAPE'
  | 'REPO_NOT_ALLOWED'
  | 'LOCK_TIMEOUT'
  | 'TEMP_WRITE_FAILED'
  | 'SQLITE_COMMIT_FAILED'
  | 'RENAME_FAILED'
  | 'STATE_NOT_FOUND'
  | 'INVALID_TRANSITION';

/**
 * Base error for handoff-protocol failures.
 *
 * Carries a `code` discriminator + an `untrusted` flag that the path
 * sanitizer consults when constructing user-facing messages. When
 * `untrusted === true`, callers MUST strip filesystem paths from any
 * surfaced error string (see `sanitizeErrorMessage`).
 */
export class HandoffError extends Error {
  readonly code: HandoffErrorCode;
  /**
   * When true, the call site originated from an external/untrusted source
   * (Discord, Slack, GitHub webhooks). Path-revealing details MUST be
   * stripped before surfacing the message to that source.
   */
  readonly untrusted: boolean;

  constructor(code: HandoffErrorCode, message: string, opts?: { untrusted?: boolean }) {
    super(message);
    this.name = 'HandoffError';
    this.code = code;
    this.untrusted = opts?.untrusted ?? false;
  }
}

/** `requestId` does not match `^REQ-\d{6}$`. Always F1, never recoverable. */
export class InvalidRequestIdError extends HandoffError {
  constructor(message: string, opts?: { untrusted?: boolean }) {
    super('PATH_INVALID', message, opts);
    this.name = 'InvalidRequestIdError';
  }
}

/**
 * Path validation failed: symlink escape, traversal, or repo not in allowlist.
 * Always F1, never recoverable.
 */
export class SecurityError extends HandoffError {
  constructor(code: 'PATH_ESCAPE' | 'REPO_NOT_ALLOWED', message: string, opts?: { untrusted?: boolean }) {
    super(code, message, opts);
    this.name = 'SecurityError';
  }
}

/** Per-request advisory lock could not be acquired within `timeoutMs`. */
export class LockTimeoutError extends HandoffError {
  constructor(message: string, opts?: { untrusted?: boolean }) {
    super('LOCK_TIMEOUT', message, opts);
    this.name = 'LockTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Path sanitization (used by both producer and consumer error reporting)
// ---------------------------------------------------------------------------

/** Regex matching POSIX-style absolute paths (best-effort, may over-match). */
const PATH_RE = /\/[A-Za-z0-9_./-]+/g;

/**
 * Strip filesystem paths from `message` for safe surfacing to untrusted
 * consumers (Discord/Slack/GitHub). Replaces every match of {@link PATH_RE}
 * with `<path>`. NOT a security boundary — defense in depth only; the real
 * boundary is the caller's choice not to surface raw exceptions.
 */
export function sanitizeErrorMessage(message: string): string {
  return message.replace(PATH_RE, '<path>');
}
