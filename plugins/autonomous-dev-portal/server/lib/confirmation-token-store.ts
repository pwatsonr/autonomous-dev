// SPEC-015-2-04 §Confirmation Token Store
//
// In-process, single-use, TTL-bounded token store specifically for the
// gate-action typed-CONFIRM modal flow. Distinct from the general-purpose
// TypedConfirmationService in server/security/confirmation-tokens.ts:
//
//   - This store carries only the operator + scope (e.g.
//     "reject_REQ-20260428-a1b2") so the gate handler can verify the token
//     was minted FOR this specific request and operator pair.
//   - Tokens are minted by POST /repo/:repo/request/:id/gate/confirm-token
//     and consumed exactly once by the gate POST handler.
//   - 60-second TTL by default; loss across restart is acceptable since the
//     modal flow is bounded and the worst case is the operator retypes
//     "REJECT".
//
// Token bytes come from `crypto.randomBytes(16) → hex` to match the
// CSRF / TypedConfirmationService convention (32 hex chars).

import { randomBytes } from "node:crypto";

export type ConsumeReason =
    | "unknown_token"
    | "already_consumed"
    | "expired"
    | "operator_mismatch"
    | "scope_mismatch";

export interface ConsumeResult {
    valid: boolean;
    reason?: ConsumeReason;
}

interface TokenEntry {
    token: string;
    operatorId: string;
    scope: string;
    expiresAt: number;
    consumed: boolean;
}

/** Default TTL for a freshly minted gate-confirmation token. */
export const DEFAULT_GATE_CONFIRM_TTL_MS = 60_000;

/**
 * Single-use token store with operator + scope binding.
 *
 * The store is process-local; multi-instance portals would need to hoist
 * this to a shared cache (Redis), but production portals are single-process
 * by design (see PLAN-013-1).
 */
export class ConfirmationTokenStore {
    private readonly tokens = new Map<string, TokenEntry>();
    private readonly ttlMs: number;

    constructor(opts: { ttlMs?: number } = {}) {
        this.ttlMs = opts.ttlMs ?? DEFAULT_GATE_CONFIRM_TTL_MS;
    }

    /**
     * Mint a fresh token bound to (operatorId, scope). Triggers an
     * opportunistic GC of expired/consumed entries.
     */
    issue(operatorId: string, scope: string): {
        token: string;
        expiresAt: number;
    } {
        const token = randomBytes(16).toString("hex");
        const expiresAt = Date.now() + this.ttlMs;
        this.tokens.set(token, {
            token,
            operatorId,
            scope,
            expiresAt,
            consumed: false,
        });
        this.cleanup();
        return { token, expiresAt };
    }

    /**
     * Consume a token. Returns `{valid: true}` exactly once per token; all
     * subsequent attempts (or attempts with mismatched operator / scope /
     * expired TTL) return `{valid: false, reason}`.
     *
     * Operator and scope mismatches do NOT consume the token — that would
     * let an attacker DoS a victim's token by guessing IDs. Only successful
     * consumption marks the entry consumed.
     */
    consume(token: string, operatorId: string, scope: string): ConsumeResult {
        const entry = this.tokens.get(token);
        if (entry === undefined) {
            return { valid: false, reason: "unknown_token" };
        }
        if (entry.consumed) {
            return { valid: false, reason: "already_consumed" };
        }
        if (Date.now() > entry.expiresAt) {
            this.tokens.delete(token);
            return { valid: false, reason: "expired" };
        }
        if (entry.operatorId !== operatorId) {
            return { valid: false, reason: "operator_mismatch" };
        }
        if (entry.scope !== scope) {
            return { valid: false, reason: "scope_mismatch" };
        }
        entry.consumed = true;
        return { valid: true };
    }

    /** Drop any token whose TTL has elapsed or that was already consumed. */
    cleanup(): void {
        const now = Date.now();
        for (const [k, v] of this.tokens.entries()) {
            if (v.consumed || v.expiresAt < now) {
                this.tokens.delete(k);
            }
        }
    }

    /** Test introspection. */
    get size(): number {
        return this.tokens.size;
    }

    /** Test introspection. */
    has(token: string): boolean {
        return this.tokens.has(token);
    }
}
