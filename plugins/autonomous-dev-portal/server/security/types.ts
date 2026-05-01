// SPEC-014-2-01 §Files — Shared security types.
//
// Spec text references Express request augmentation; the portal runs on Hono,
// so this module instead extends Hono's ContextVariableMap with the per-request
// security state (csrf token, csp nonce). Providers / middleware read through
// `c.get('csrfToken')` and `c.get('cspNonce')`. The `SecurityError` class
// extends PortalError so the existing error envelope (`{error: {code, message,
// request_id}}`) is reused by the error-handler middleware without bespoke
// wiring.
//
// The token store is in-memory and single-instance. Multi-instance deployments
// will move to a shared store in PLAN-014-3 — see SPEC-014-2-01 §Notes.

import { PortalError } from "../middleware/error-handler";

/**
 * Configuration for {@link CSRFProtection}. All times in milliseconds.
 *
 * `secretKey` MUST be set to a cryptographically strong value — startup
 * REJECTS the literal placeholder `change-me-in-production` when
 * NODE_ENV === 'production' (see SPEC-014-2-01 acceptance criteria).
 */
export interface CSRFConfig {
    /** Token TTL in ms. Default: 24h. */
    tokenTTL: number;
    /** Cookie name for the double-submit signature. Default: __csrf_signature. */
    cookieName: string;
    /** Header name for the CSRF token. Default: X-CSRF-Token. */
    headerName: string;
    /** Path prefixes excluded from CSRF enforcement. */
    excludePaths: string[];
    /** HMAC secret. MUST NOT be the placeholder in production. */
    secretKey: string;
    /** LRU cap for the in-memory token store. Default: 10_000. */
    maxTokensInMemory: number;
}

/**
 * Internal token shape stored in the {@link CSRFProtection} map. `value` is
 * the raw 64-char hex token; `signature` is computed at issue time and
 * round-tripped via the double-submit cookie.
 */
export interface CSRFToken {
    value: string;
    createdAt: number;
    sessionId: string;
}

/**
 * Outcome of {@link OriginValidator.validateRequest}. `reason` is one of the
 * stable error codes documented in SPEC-014-2-01 §Origin Validation:
 * - missing-origin-and-referer
 * - malformed-origin
 * - wildcard-rejected-in-production
 * - origin-not-allowed
 */
export interface OriginValidationResult {
    valid: boolean;
    reason?: string;
}

/**
 * Surfaced for misconfiguration that prevents the security layer from
 * starting (e.g. placeholder secret in production). Mirrors
 * `auth/types.ts:SecurityError` so both layers throw the same typed error
 * and the error-handler middleware emits one envelope shape.
 */
export class SecurityError extends PortalError {
    constructor(code: string, message: string) {
        super(code, message, 500);
        this.name = "SecurityError";
    }
}

// ---------------------------------------------------------------------------
// SPEC-014-3-01 — PathValidator + ToctouGuard shared types.
// ---------------------------------------------------------------------------

/**
 * Configuration for {@link PathValidator}. Each entry in `allowed_roots`
 * is canonicalized once at construction time and used for prefix-with-
 * separator containment checks. Empty list throws SecurityError.
 */
export interface PathPolicy {
    allowed_roots: string[];
}

/**
 * Cached file-descriptor metadata captured at `openSafe()` time. Re-stat
 * during `readSafe()` compares `(deviceId, inodeId)` to detect symlink/
 * inode swaps that bypass canonicalization.
 */
export interface FileDescriptorInfo {
    fd: number;
    deviceId: number;
    inodeId: number;
    path: string;
    openTime: number;
}

// ---------------------------------------------------------------------------
// SPEC-014-3-02 — RegexSandbox worker contract.
// ---------------------------------------------------------------------------

/**
 * Inputs carried to the regex worker via `workerData`. The worker has no
 * filesystem or network access — only this serialized payload.
 */
export interface RegexTask {
    pattern: string;
    flags: string;
    input: string;
}

/**
 * Outcome surfaced to the main thread. Callers MUST distinguish three
 * outcomes — match (matches:true), timeout (timedOut:true), and execution
 * error (error set, matches:false). The sandbox NEVER throws for these
 * cases; only pre-flight validation errors are thrown as SecurityError.
 */
export interface RegexResult {
    matches: boolean;
    groups?: string[];
    error?: string;
    timedOut?: boolean;
    executionTime?: number;
}

declare module "hono" {
    interface ContextVariableMap {
        /** SPEC-014-2-01 — current request's signed CSRF token (raw value). */
        csrfToken: string;
        /** SPEC-014-2-04 — per-request CSP nonce, base64. */
        cspNonce: string;
    }
}
