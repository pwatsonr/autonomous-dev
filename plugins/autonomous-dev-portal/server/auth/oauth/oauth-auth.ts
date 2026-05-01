// SPEC-014-1-04 §Task 4.9 — OAuthAuthProvider.
//
// Per-request gate for `auth_mode='oauth-pkce'`. Looks up the signed
// session cookie, asks the SessionManager whether the cookie still maps
// to a live session, and either:
//   - allows the request with a populated AuthContext, or
//   - redirects to /auth/login (the route handler in routes/auth.ts then
//     mints fresh state + verifier and bounces the user to the provider).
//
// The provider deliberately does NOT mutate any response state — it
// returns an AuthDecision (allow | redirect) and the auth-context
// middleware (auth-context.ts) translates that into the actual response.
//
// init() validates the cookie secret entropy. Per acceptance criteria
// (SPEC-014-1-04) we reject `cookie_secret_env` values shorter than 32
// bytes. We accept either a raw 32-byte string OR a base64-encoded
// string whose decoded length is >= 32 bytes — operators commonly use
// `openssl rand -base64 32` for this value, which yields 44 chars of
// base64 that decode to 32 bytes.

import type { PortalConfig } from "../../lib/config";
import { BaseAuthProvider, defaultAuthLogger } from "../base-auth";
import type { AuthLogger } from "../base-auth";
import { SecurityError } from "../types";
import type { AuthDecision, AuthMode } from "../types";
import type { SessionManager } from "../session/session-manager";
import { parseSessionCookie } from "../session/session-cookie";

/** Minimum cookie-secret entropy in bytes (256 bits). */
export const COOKIE_SECRET_MIN_BYTES = 32;

export interface OAuthAuthProviderOptions {
    config: PortalConfig;
    sessionManager: SessionManager;
    /** Resolved cookie secret value (NEVER the env var name). */
    cookieSecret: string;
    /** Optional logger override. */
    logger?: AuthLogger;
}

/**
 * Decode a candidate cookie secret as either:
 *   - raw UTF-8 bytes (length >= COOKIE_SECRET_MIN_BYTES), OR
 *   - base64 / base64url string whose decoded length >= COOKIE_SECRET_MIN_BYTES
 *
 * Returns the byte length whichever is greater, or 0 when neither path
 * meets the threshold.
 */
export function effectiveCookieSecretBytes(secret: string): number {
    if (typeof secret !== "string" || secret.length === 0) return 0;
    const rawBytes = Buffer.byteLength(secret, "utf8");
    let decodedBytes = 0;
    // Accept either base64 or base64url; the URL-safe variant has -/_ in
    // place of +/. We try the standard form first.
    try {
        const cleaned = secret.replace(/-/g, "+").replace(/_/g, "/");
        decodedBytes = Buffer.from(cleaned, "base64").length;
    } catch {
        decodedBytes = 0;
    }
    return Math.max(rawBytes, decodedBytes);
}

export class OAuthAuthProvider extends BaseAuthProvider {
    readonly mode: AuthMode = "oauth-pkce";
    private readonly config: PortalConfig;
    private readonly sessionManager: SessionManager;
    private readonly cookieSecret: string;
    private readonly logger: AuthLogger;

    constructor(opts: OAuthAuthProviderOptions) {
        super();
        this.config = opts.config;
        this.sessionManager = opts.sessionManager;
        this.cookieSecret = opts.cookieSecret;
        this.logger = opts.logger ?? defaultAuthLogger();
    }

    async init(): Promise<void> {
        // Cookie-secret entropy gate (acceptance criteria).
        if (effectiveCookieSecretBytes(this.cookieSecret) < COOKIE_SECRET_MIN_BYTES) {
            throw new SecurityError(
                "OAUTH_WEAK_COOKIE_SECRET",
                `oauth_auth.cookie_secret_env value must decode to >= ${String(
                    COOKIE_SECRET_MIN_BYTES,
                )} bytes; ` +
                    `consider 'openssl rand -base64 32' to generate one. ` +
                    `(The secret value itself is never logged.)`,
            );
        }
        this.logger.info("oauth.auth.initialized", {
            provider: this.config.oauth_auth?.provider,
        });
    }

    async evaluate(request: Request, _peerIp: string): Promise<AuthDecision> {
        const cookieHeader = request.headers.get("cookie") ?? "";
        const sessionId = parseSessionCookie(cookieHeader, this.cookieSecret);
        if (sessionId === null) {
            // Tampered, missing, or malformed cookie. Send the user to the
            // login route which mints a fresh state and bounces to the IDP.
            return this.redirect("/auth/login");
        }
        const session = await this.sessionManager.validate(sessionId);
        if (session === null) {
            // Cookie referenced an expired or unknown session.
            return this.redirect("/auth/login");
        }
        return this.allow(session.user_id, session.display_name, {
            email: session.email,
            provider: session.provider,
            session_id: session.session_id,
        });
    }
}
