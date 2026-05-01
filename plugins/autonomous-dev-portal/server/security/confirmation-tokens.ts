// SPEC-014-2-02 §TypedConfirmationService — Server-authoritative typed-CONFIRM
// flow for destructive operations.
//
// Two-step protocol:
//   1. Client posts {action} to /api/security/confirmation/request and
//      receives {token, phrase, ttl}. The phrase is server-issued from
//      the allowlist; client cannot pick it.
//   2. Client posts {token, userInput} to /api/security/confirmation/validate.
//      Strict equality (case-sensitive, no trim) is the only acceptance
//      criterion. Tokens are one-time-use and session-bound.
//
// Tokens live in-process with a 60s TTL and a 30s rate-limit window per
// session. State is module-instance — multi-instance moves to Redis in
// PLAN-014-3.
//
// CSRF guard runs IN FRONT of the routes (registered AFTER the CSRF
// middleware in security-middleware.ts). Confirmation does NOT bypass
// CSRF.

import { randomToken } from "./crypto-utils";
import {
    getConfirmationPhrase,
    isConfirmableAction,
} from "./confirmation-phrases";

export interface ConfirmationConfig {
    /** Token TTL in ms. Default: 60_000 (60s). */
    tokenTTL: number;
    /** Max active confirmation tokens per session within `rateLimitWindow`. */
    maxTokensPerSession: number;
    /** Rate-limit window in ms. Default: 60_000 (60s). */
    rateLimitWindow: number;
    /** Server-side cap on validation input length. Default: 100. */
    maxConfirmationLength: number;
    /** LRU cap on overall stored tokens. Default: 5_000. */
    maxTokensInMemory: number;
}

interface ConfirmationToken {
    token: string;
    createdAt: number;
    sessionId: string;
    action: string;
    /** Denormalized at issue time so phrase changes don't affect live tokens. */
    confirmationPhrase: string;
    metadata: Record<string, unknown>;
}

/** Stable error codes returned to callers. */
export type ConfirmationError =
    | "unknown-action"
    | "rate-limit-exceeded"
    | "invalid-or-expired-token"
    | "session-mismatch"
    | "token-expired"
    | "input-too-long"
    | "phrase-mismatch";

export interface RequestResult {
    success: boolean;
    token?: string;
    phrase?: string;
    ttl?: number;
    error?: ConfirmationError;
}

export interface ValidationResult {
    valid: boolean;
    action?: string;
    metadata?: Record<string, unknown>;
    error?: ConfirmationError;
}

/** Test-friendly logger (matches CSRFLogger / AuthLogger surface). */
export interface ConfirmationLogger {
    info(event: string, fields?: Record<string, unknown>): void;
    warn(event: string, fields?: Record<string, unknown>): void;
}

function noopLogger(): ConfirmationLogger {
    return { info: () => undefined, warn: () => undefined };
}

export const DEFAULT_CONFIRMATION_CONFIG: ConfirmationConfig = Object.freeze({
    tokenTTL: 60_000,
    maxTokensPerSession: 3,
    rateLimitWindow: 60_000,
    maxConfirmationLength: 100,
    maxTokensInMemory: 5_000,
});

/**
 * Service singleton — one per portal process. Tests construct their own.
 *
 * Race-condition note (from SPEC-014-2-02 §Notes): generation, validation,
 * and the 30-second cleanup all run on the single Node/Bun thread; no
 * locking required. `entries()` snapshot iteration is safe under in-loop
 * mutation.
 */
export class TypedConfirmationService {
    private readonly config: ConfirmationConfig;
    private readonly logger: ConfirmationLogger;
    private readonly tokenStore = new Map<string, ConfirmationToken>();
    private readonly rateLimitStore = new Map<string, number[]>();
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    constructor(
        config: Partial<ConfirmationConfig> = {},
        logger: ConfirmationLogger = noopLogger(),
    ) {
        this.config = { ...DEFAULT_CONFIRMATION_CONFIG, ...config };
        this.logger = logger;
    }

    /**
     * Issue a fresh confirmation token. Returns `success=false` with one
     * of the documented error codes for unknown actions or when the
     * session has hit the per-window quota.
     */
    generateConfirmationToken(
        sessionId: string,
        request: { action: string; metadata?: Record<string, unknown> },
    ): RequestResult {
        if (!isConfirmableAction(request.action)) {
            return { success: false, error: "unknown-action" };
        }
        if (!this.checkRateLimit(sessionId)) {
            return { success: false, error: "rate-limit-exceeded" };
        }
        const token = randomToken(16); // 32 hex chars per spec
        const phrase = getConfirmationPhrase(request.action);
        // Re-checked here for type narrowing; isConfirmableAction guarantees
        // a non-null phrase at this point.
        if (phrase === null) {
            return { success: false, error: "unknown-action" };
        }
        this.tokenStore.set(token, {
            token,
            createdAt: Date.now(),
            sessionId,
            action: request.action,
            confirmationPhrase: phrase,
            metadata: request.metadata ?? {},
        });
        this.recordAttempt(sessionId);
        if (this.tokenStore.size > this.config.maxTokensInMemory) {
            this.evictOldest();
        }
        this.logger.info("confirmation_token_issued", {
            sessionId,
            action: request.action,
        });
        return {
            success: true,
            token,
            phrase,
            ttl: Math.floor(this.config.tokenTTL / 1000),
        };
    }

    /**
     * Validate a confirmation. The token MUST match the issuing session,
     * MUST not have expired, and the typed phrase MUST equal the issued
     * phrase exactly. Failed phrase comparisons do NOT delete the token —
     * the user may retry within the TTL. Successful validations DO delete
     * the token (one-time use) and emit the confirmation event for the
     * downstream `requireConfirmation` middleware to consume.
     */
    validateConfirmation(
        token: string,
        sessionId: string,
        userInput: string,
    ): ValidationResult {
        const stored = this.tokenStore.get(token);
        if (stored === undefined) {
            return { valid: false, error: "invalid-or-expired-token" };
        }
        // SPEC §Acceptance: do NOT delete on session mismatch — could be a
        // guess attack on a victim's token; deletion would be a DoS vector.
        if (stored.sessionId !== sessionId) {
            return { valid: false, error: "session-mismatch" };
        }
        if (Date.now() - stored.createdAt > this.config.tokenTTL) {
            this.tokenStore.delete(token);
            return { valid: false, error: "token-expired" };
        }
        if (userInput.length > this.config.maxConfirmationLength) {
            return { valid: false, error: "input-too-long" };
        }
        // Strict equality — case-sensitive, no trim, no normalization.
        if (userInput !== stored.confirmationPhrase) {
            return { valid: false, error: "phrase-mismatch" };
        }
        this.tokenStore.delete(token);
        this.logger.info("confirmation_validated", {
            sessionId,
            action: stored.action,
        });
        return {
            valid: true,
            action: stored.action,
            metadata: stored.metadata,
        };
    }

    /** Returns true if the session has remaining quota in the rate window. */
    checkRateLimit(sessionId: string): boolean {
        const now = Date.now();
        const attempts = this.rateLimitStore.get(sessionId) ?? [];
        const valid = attempts.filter(
            (t) => now - t < this.config.rateLimitWindow,
        );
        return valid.length < this.config.maxTokensPerSession;
    }

    /**
     * Clean expired tokens AND expired rate-limit entries. Called every
     * 30 seconds by the interval started in {@link startCleanup}; tests
     * may invoke directly.
     */
    cleanupExpired(): void {
        const now = Date.now();
        const tokenCutoff = now - this.config.tokenTTL;
        for (const [k, v] of this.tokenStore.entries()) {
            if (v.createdAt < tokenCutoff) this.tokenStore.delete(k);
        }
        const rateCutoff = now - this.config.rateLimitWindow;
        for (const [sessionId, attempts] of this.rateLimitStore.entries()) {
            const valid = attempts.filter((t) => t > rateCutoff);
            if (valid.length === 0) {
                this.rateLimitStore.delete(sessionId);
            } else {
                this.rateLimitStore.set(sessionId, valid);
            }
        }
    }

    startCleanup(): void {
        if (this.cleanupTimer !== null) return;
        this.cleanupTimer = setInterval(() => this.cleanupExpired(), 30_000);
        const t = this.cleanupTimer as { unref?: () => void };
        if (typeof t.unref === "function") t.unref();
    }

    stopCleanup(): void {
        if (this.cleanupTimer !== null) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    /** Test introspection. */
    get storeSize(): number {
        return this.tokenStore.size;
    }

    /** Test introspection. */
    has(token: string): boolean {
        return this.tokenStore.has(token);
    }

    private recordAttempt(sessionId: string): void {
        const list = this.rateLimitStore.get(sessionId) ?? [];
        list.push(Date.now());
        this.rateLimitStore.set(sessionId, list);
    }

    private evictOldest(): void {
        const target = Math.ceil(this.config.maxTokensInMemory * 0.1);
        const entries = Array.from(this.tokenStore.entries()).sort(
            (a, b) => a[1].createdAt - b[1].createdAt,
        );
        for (let i = 0; i < target && i < entries.length; i += 1) {
            const entry = entries[i];
            if (entry !== undefined) this.tokenStore.delete(entry[0]);
        }
    }
}
