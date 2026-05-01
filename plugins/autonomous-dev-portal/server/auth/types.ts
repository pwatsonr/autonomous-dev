// SPEC-014-1-01 §Task 1.1 — Core auth types.
//
// Shared shape for the three authentication modes (`localhost`,
// `tailscale`, `oauth-pkce`). Each `AuthProvider` implementation lives in
// its own module and is wired through `createAuthMiddleware` in
// middleware-factory.ts. Per-request handlers read the `AuthContext` via
// `c.get('auth')`; FR-S05 audit attribution depends on `source_user_id`
// being populated for every authenticated request.
//
// SecurityError extends PortalError so the existing error-handler chain
// emits the documented JSON envelope (`{error: {code, message,
// request_id}}`) without bespoke wiring. Thrown only from `init()` paths;
// per-request denials surface as `AuthDecision { kind: 'deny' }` and are
// converted to JSON responses by authContextMiddleware.
//
// `oauth-pkce` (with hyphen) is the canonical literal for OAuth mode.
// The pre-existing `oauth` literal in config.ts remains for backward
// compatibility with config files written before this spec; loadPortalConfig
// callers should treat both as equivalent until SPEC-014-1-04 renames the
// on-disk value.

import { PortalError } from "../middleware/error-handler";

export type AuthMode = "localhost" | "tailscale" | "oauth-pkce";

/**
 * Per-request authentication state propagated via Hono's context. The
 * `details` map carries mode-specific extras (peer IP for tailscale, email
 * for OAuth, session id for OAuth) and is treated as opaque by every layer
 * other than the originating provider.
 */
export interface AuthContext {
    authenticated: boolean;
    mode: AuthMode;
    /**
     * Stable identifier used for FR-S05 audit attribution.
     * - localhost: literal "localhost"
     * - tailscale: tailnet login (e.g. "alice@example.com") or
     *   "tailnet-peer:<ip>" for unauthenticated read-only peers
     * - oauth-pkce: OAuth provider's user identifier (login or sub)
     */
    source_user_id: string;
    /** Human-readable display name; falls back to source_user_id. */
    display_name: string;
    /** Mode-specific extras; opaque to other layers. */
    details: Record<string, unknown>;
}

export type AuthDecision =
    | { kind: "allow"; context: AuthContext }
    | {
          kind: "deny";
          status: 401 | 403;
          error_code: string;
          message: string;
      }
    | { kind: "redirect"; location: string };

export interface AuthProvider {
    readonly mode: AuthMode;
    /** Called once at startup. Throws SecurityError on misconfiguration. */
    init(): Promise<void>;
    /**
     * Per-request decision. MUST be a pure function of `(request, peerIp)`
     * with respect to authentication state — providers MAY consult their
     * own injected dependencies (session store, Tailscale client) but MUST
     * NOT mutate the response object.
     */
    evaluate(request: Request, peerIp: string): Promise<AuthDecision>;
}

/**
 * Surfaced for misconfiguration that prevents the server from coming up
 * safely (or for fatal per-request security failures). Extends PortalError
 * so the existing error-handler middleware emits the standard JSON
 * envelope for any thrown SecurityError.
 */
export class SecurityError extends PortalError {
    constructor(code: string, message: string) {
        super(code, message, 500);
        this.name = "SecurityError";
    }
}

declare module "hono" {
    interface ContextVariableMap {
        auth: AuthContext;
    }
}
