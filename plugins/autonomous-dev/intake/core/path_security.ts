/**
 * Path validation for the two-phase commit handoff (SPEC-012-1-01 §Task 2).
 *
 * Two layers of defense:
 *   1. `validateRequestId` — reject anything not matching `^REQ-\d{6}$`.
 *   2. `buildRequestPath`  — resolve via `realpath`, allowlist-check the
 *      repo, and verify the candidate is a descendant of the resolved repo
 *      (catches symlink escapes that survive layer 1).
 *
 * The allowlist is read from environment / config. Tests override via
 * {@link setAllowedRepositoriesForTest}.
 *
 * @module core/path_security
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  InvalidRequestIdError,
  SecurityError,
} from './types';

// ---------------------------------------------------------------------------
// Request ID validation
// ---------------------------------------------------------------------------

/** Canonical request ID format: REQ- followed by exactly 6 ASCII digits. */
const REQUEST_ID_RE = /^REQ-\d{6}$/;

/**
 * Throw {@link InvalidRequestIdError} if `id` is not a canonical request ID.
 *
 * Rejects: empty string, leading/trailing whitespace, traversal sequences
 * (`..`), path separators, anything outside `REQ-NNNNNN`.
 *
 * `untrusted` is forwarded to the error; pass `true` for adapter-sourced
 * inputs so the message gets path-sanitized at the boundary.
 */
export function validateRequestId(
  id: string,
  opts?: { untrusted?: boolean },
): void {
  if (typeof id !== 'string' || id.length === 0) {
    throw new InvalidRequestIdError('request id must be a non-empty string', opts);
  }
  if (!REQUEST_ID_RE.test(id)) {
    throw new InvalidRequestIdError(
      `invalid request id: must match ^REQ-\\d{6}$`,
      opts,
    );
  }
}

// ---------------------------------------------------------------------------
// Repository allowlist
// ---------------------------------------------------------------------------

/**
 * Configured allowlist of repository roots. Populated lazily on first
 * access from the env var `AUTONOMOUS_DEV_ALLOWED_REPOS` (colon-separated
 * absolute paths). Tests override via {@link setAllowedRepositoriesForTest}.
 *
 * An empty allowlist means "deny all" — there is no implicit "any repo"
 * fallback. Production deployments MUST configure the allowlist explicitly.
 */
let allowedRepos: string[] | null = null;

/**
 * Load the allowlist from `AUTONOMOUS_DEV_ALLOWED_REPOS` if not already
 * initialized. Each entry is realpath-normalized once at load time. Empty
 * env var ⇒ empty allowlist (deny all).
 */
function ensureAllowlistLoaded(): string[] {
  if (allowedRepos !== null) return allowedRepos;

  const raw = process.env.AUTONOMOUS_DEV_ALLOWED_REPOS;
  if (!raw || raw.trim() === '') {
    allowedRepos = [];
    return allowedRepos;
  }

  const out: string[] = [];
  for (const entry of raw.split(':')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    try {
      out.push(fs.realpathSync(trimmed));
    } catch {
      // Skip entries that don't resolve. Operators see the warning at the
      // first attempted submission to a missing repo (the per-call check
      // catches it). We deliberately do NOT throw here so a single bad
      // env entry doesn't break the whole intake layer at import time.
    }
  }
  allowedRepos = out;
  return out;
}

/**
 * Test-only: override the allowlist. Pass `null` to reset to env-loaded.
 *
 * Tests MUST call this in `beforeEach` and reset (`null`) in `afterEach` to
 * avoid leakage. The function is synchronous and cheap.
 */
export function setAllowedRepositoriesForTest(repos: string[] | null): void {
  if (repos === null) {
    allowedRepos = null;
    return;
  }
  // Realpath-normalize at set-time (mirrors env loader semantics).
  const normalized: string[] = [];
  for (const r of repos) {
    try {
      normalized.push(fs.realpathSync(r));
    } catch {
      // For tests that intentionally pass non-existent paths, store the
      // input so the per-call check trips on the realpath of `repo`.
      normalized.push(r);
    }
  }
  allowedRepos = normalized;
}

// ---------------------------------------------------------------------------
// Build request path
// ---------------------------------------------------------------------------

/**
 * Compute the secure, realpath-resolved path to a request directory.
 *
 * Steps (per SPEC-012-1-01 §Task 2):
 *   1. Validate `requestId`.
 *   2. Realpath-resolve `repo`. Throw {@link SecurityError} on failure.
 *   3. Verify resolved repo is in the allowlist. Throw {@link SecurityError}.
 *   4. Compute `candidate = realpath(repo)/.autonomous-dev/requests/<requestId>`.
 *   5. Realpath the parent (`requests/`) to defeat symlink escape; the
 *      request dir itself MAY not yet exist.
 *   6. Verify resolved candidate is a descendant of resolved repo. Throw
 *      on escape (.. or symlink jump).
 *
 * Returns the resolved absolute path. The caller may safely create the
 * directory (`mkdir -p`) afterwards.
 *
 * @param repo        Absolute path to the repository root (allowlisted).
 * @param requestId   `REQ-NNNNNN` request ID.
 * @param opts        Forwarded to thrown errors (untrusted source flag).
 */
export function buildRequestPath(
  repo: string,
  requestId: string,
  opts?: { untrusted?: boolean },
): string {
  validateRequestId(requestId, opts);

  let resolvedRepo: string;
  try {
    resolvedRepo = fs.realpathSync(repo);
  } catch {
    throw new SecurityError(
      'REPO_NOT_ALLOWED',
      `repository does not exist or is not accessible`,
      opts,
    );
  }

  const allow = ensureAllowlistLoaded();
  if (!allow.includes(resolvedRepo)) {
    throw new SecurityError(
      'REPO_NOT_ALLOWED',
      `repository is not in the configured allowlist`,
      opts,
    );
  }

  // Build candidate path. The parent (`.autonomous-dev/requests/`) MUST
  // realpath cleanly; the request dir itself MAY be created later.
  const requestsDir = path.join(resolvedRepo, '.autonomous-dev', 'requests');
  // Make sure parent exists so realpath works (idempotent — created with
  // mode 0700 to mirror the request-dir mode in the protocol).
  try {
    fs.mkdirSync(requestsDir, { recursive: true, mode: 0o700 });
  } catch {
    // mkdirSync recursive is idempotent; only an EACCES would land here.
    // Surface as security failure so the caller doesn't silently retry.
    throw new SecurityError(
      'REPO_NOT_ALLOWED',
      `repository requests directory is not writable`,
      opts,
    );
  }

  let resolvedRequestsDir: string;
  try {
    resolvedRequestsDir = fs.realpathSync(requestsDir);
  } catch {
    throw new SecurityError(
      'REPO_NOT_ALLOWED',
      `repository requests directory is not accessible`,
      opts,
    );
  }

  const candidate = path.join(resolvedRequestsDir, requestId);

  // The request dir may already exist (from a prior submit). If so,
  // realpath it to detect symlink escape. If not, the candidate is built
  // from a realpath-resolved parent + a known-safe leaf (passed regex), so
  // it's safe to use as-is.
  let resolved = candidate;
  try {
    resolved = fs.realpathSync(candidate);
  } catch {
    // Candidate dir doesn't exist yet — keep `candidate` as the resolved
    // path. The known-safe leaf concatenation above guarantees no escape.
  }

  // Final escape check: resolved path MUST be a descendant of the
  // resolved repo. `path.relative` returning `..`-prefixed string indicates
  // escape. Equality (relative === '') is fine — that's the repo itself,
  // which we allow as a defensive corner case.
  const rel = path.relative(resolvedRepo, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SecurityError(
      'PATH_ESCAPE',
      `resolved request path escapes the repository root`,
      opts,
    );
  }

  return resolved;
}
