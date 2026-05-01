// SPEC-014-1-04 §Task 4.2 — Short-lived OAuth state store.
//
// Pairs each `state` parameter with the matching `code_verifier` and
// `return_to` for the lifetime of an in-flight OAuth handshake. Backed by
// an in-memory Map because:
//   1. State records survive only between /auth/login and /auth/callback
//      (single-process, sub-minute TTL).
//   2. The portal is single-process; multi-replica session sharing is out
//      of scope for the homelab deployment target.
//
// Security rules implemented here (see acceptance criteria in SPEC-014-1-04):
//   - state is 256 bits of entropy (32 random bytes → 43 char base64url)
//   - state is one-time-use; consume() flips `used=true` BEFORE returning
//     the record and a queueMicrotask schedules deletion
//   - 10-minute TTL; expired records return undefined and are evicted
//   - `return_to` is sanitized: only paths starting with `/` and free of
//     `//`, `\`, `:`, `?` are accepted; everything else collapses to `/`
//
// The store is intentionally tiny: a Map of state → record plus four
// methods (generate, consume, cleanupExpired, size). No IO, no async; the
// hourly cleanup sweep calls cleanupExpired() from session-cleanup.ts.

import { generateCodeVerifier, base64UrlEncode } from "./pkce-utils";
import { randomBytes } from "node:crypto";

/** Default TTL — RFC 6749 §10.12 recommends short-lived state values. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Sanitize the `return_to` query parameter to defeat open-redirect attacks.
 *
 * Acceptance rule (SPEC-014-1-04 §Task 4.8): only paths beginning with `/`
 * and containing none of `//`, `\`, `:`, `?` are accepted; everything else
 * collapses to `/`. The most common bypass attempts blocked here:
 *
 *   /        → /
 *   /repo/x  → /repo/x
 *   //evil   → /     (protocol-relative URL)
 *   https:// → /     (absolute URL)
 *   /foo?x=1 → /     (query stripping protects layered redirects)
 *   undefined→ /
 */
export function sanitizeReturnTo(input: string | null | undefined): string {
    if (typeof input !== "string" || input.length === 0) return "/";
    if (!input.startsWith("/")) return "/";
    if (
        input.includes("//") ||
        input.includes("\\") ||
        input.includes(":") ||
        input.includes("?")
    ) {
        return "/";
    }
    return input;
}

export interface OAuthStateRecord {
    /** PKCE code_verifier paired with this state. */
    code_verifier: string;
    /** Sanitized post-callback redirect target. */
    return_to: string;
    /** Wall-clock millis at insert time; used for TTL calculations. */
    created_at: number;
    /** Set true on first consume() to defeat replay. */
    used: boolean;
}

export interface OAuthStateGenerated {
    state: string;
    code_verifier: string;
}

export interface OAuthStateStoreOptions {
    /** Override the default TTL. Used by tests for fast-expiry assertions. */
    ttlMs?: number;
    /** Test seam: deterministic clock. */
    now?: () => number;
}

export class OAuthStateStore {
    private readonly records = new Map<string, OAuthStateRecord>();
    private readonly ttlMs: number;
    private readonly now: () => number;

    constructor(opts: OAuthStateStoreOptions = {}) {
        this.ttlMs = opts.ttlMs ?? OAUTH_STATE_TTL_MS;
        this.now = opts.now ?? (() => Date.now());
    }

    /**
     * Mint a fresh `(state, code_verifier)` pair and remember the
     * `return_to`. The verifier is the secret half of the PKCE pair and
     * MUST stay inside this store until consume().
     */
    generate(returnTo: string): OAuthStateGenerated {
        const state = base64UrlEncode(randomBytes(32));
        const code_verifier = generateCodeVerifier();
        this.records.set(state, {
            code_verifier,
            return_to: sanitizeReturnTo(returnTo),
            created_at: this.now(),
            used: false,
        });
        return { state, code_verifier };
    }

    /**
     * One-time-use lookup. Returns the record on the first call; on every
     * subsequent call (or for unknown / expired state) returns null AND
     * removes the record so a parallel replay attempt cannot succeed.
     *
     * The "mark used BEFORE returning" ordering is deliberate: it means a
     * concurrent second consume() observes `used === true` and is rejected.
     */
    consume(state: string): OAuthStateRecord | null {
        if (typeof state !== "string" || state.length === 0) return null;
        const rec = this.records.get(state);
        if (rec === undefined) return null;
        if (rec.used) {
            // Replay attempt; remove and reject.
            this.records.delete(state);
            return null;
        }
        if (this.now() - rec.created_at > this.ttlMs) {
            this.records.delete(state);
            return null;
        }
        rec.used = true;
        // Schedule actual removal asynchronously so any parallel consume()
        // racing through `get()` still observes used=true and rejects.
        queueMicrotask(() => {
            this.records.delete(state);
        });
        return rec;
    }

    /** Remove all records past the TTL window. Called from the hourly sweep. */
    cleanupExpired(): number {
        const cutoff = this.now() - this.ttlMs;
        let removed = 0;
        for (const [state, rec] of this.records) {
            if (rec.created_at <= cutoff || rec.used) {
                this.records.delete(state);
                removed += 1;
            }
        }
        return removed;
    }

    /** Diagnostic helper; not part of the public auth contract. */
    size(): number {
        return this.records.size;
    }
}
