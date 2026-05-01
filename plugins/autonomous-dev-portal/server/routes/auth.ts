// SPEC-014-1-04 §Task 4.8 — OAuth + session HTTP routes.
//
// Registers the three public endpoints required for the
// `auth_mode='oauth-pkce'` flow:
//
//   GET  /auth/login    — mint state + verifier; redirect to provider
//   GET  /auth/callback — exchange code for token; create session;
//                         regenerate session_id (defeats fixation);
//                         set the signed cookie; redirect to return_to
//   POST /auth/logout   — destroy session; clear cookie; redirect /
//
// The handlers are registered via registerAuthRoutes(app, deps) so that:
//   1. server.ts can wire them only when auth_mode === 'oauth-pkce',
//      which keeps the localhost / tailscale builds free of OAuth code
//      paths.
//   2. tests can supply stub deps without touching real fetch / fs.
//
// /auth/logout MUST be POST to mitigate logout-via-image-tag CSRF.
// A GET to /auth/logout returns 405 Method Not Allowed.

import type { Context, Hono } from "hono";

import { deriveCodeChallenge } from "../auth/oauth/pkce-utils";
import type { OAuthStateStore } from "../auth/oauth/oauth-state";
import type { OAuthProviderAdapter, OAuthTokens } from "../auth/oauth/providers/types";
import {
    SESSION_COOKIE_NAME,
    buildSetCookieHeader,
    encodeCookie,
    parseSessionCookie,
} from "../auth/session/session-cookie";
import type { SessionManager } from "../auth/session/session-manager";
import { sanitizeReturnTo } from "../auth/oauth/oauth-state";

/**
 * Function returned to the route layer that performs the token exchange.
 * Mocked in tests so we don't need a real fetch.
 */
export type TokenExchangeFn = (
    code: string,
    codeVerifier: string,
) => Promise<OAuthTokens>;

/** Optional renderer for the user-facing error page. */
export type ErrorPageRenderer = (
    c: Context,
    code: string,
    message: string,
) => Response;

export interface AuthRouteDeps {
    /** True iff auth_mode === 'oauth-pkce'. Login returns 404 otherwise. */
    enabled: boolean;
    stateStore: OAuthStateStore;
    providerAdapter: OAuthProviderAdapter;
    sessionManager: SessionManager;
    tokenExchange: TokenExchangeFn;
    /** Cookie secret resolved from the env var named in config. */
    cookieSecret: string;
    /** Mirrors `config.bind_host !== '127.0.0.1'`. Toggles cookie `Secure`. */
    isSecure: boolean;
    /** Override the default JSON error page. */
    errorPage?: ErrorPageRenderer;
}

const STATUS_400 = 400;
const STATUS_403 = 403;
const STATUS_404 = 404;
const STATUS_405 = 405;

function defaultErrorPage(c: Context, code: string, message: string): Response {
    const status = code === "OAUTH_DISABLED" ? STATUS_404 : STATUS_403;
    return c.json(
        { error: { code, message } },
        // The Hono types accept ContentfulStatusCode; cast safe because
        // every code we use here is a documented HTTP status.
        status as 400 | 403 | 404 | 405,
    );
}

export function registerAuthRoutes(app: Hono, deps: AuthRouteDeps): void {
    const renderError = deps.errorPage ?? defaultErrorPage;

    app.get("/auth/login", (c) => {
        if (!deps.enabled) {
            // Don't leak that OAuth exists when it isn't configured.
            return renderError(c, "OAUTH_DISABLED", "OAuth is not configured");
        }
        const returnTo = sanitizeReturnTo(c.req.query("return_to"));
        const { state, code_verifier } = deps.stateStore.generate(returnTo);
        const challenge = deriveCodeChallenge(code_verifier);
        const url = deps.providerAdapter.buildAuthorizeUrl(state, challenge);
        return c.redirect(url, 302);
    });

    app.get("/auth/callback", async (c) => {
        if (!deps.enabled) {
            return renderError(c, "OAUTH_DISABLED", "OAuth is not configured");
        }
        const stateParam = c.req.query("state");
        const codeParam = c.req.query("code");
        const errorParam = c.req.query("error");
        if (typeof errorParam === "string" && errorParam.length > 0) {
            return renderError(c, "OAUTH_PROVIDER_ERROR", errorParam);
        }
        if (
            typeof stateParam !== "string" ||
            stateParam.length === 0 ||
            typeof codeParam !== "string" ||
            codeParam.length === 0
        ) {
            return c.json(
                {
                    error: {
                        code: "OAUTH_BAD_CALLBACK",
                        message: "Missing state or code parameter",
                    },
                },
                STATUS_400,
            );
        }
        const rec = deps.stateStore.consume(stateParam);
        if (rec === null) {
            return renderError(
                c,
                "OAUTH_STATE_INVALID",
                "OAuth state is missing, expired, or already used",
            );
        }

        // Token exchange — token-exchange.ts throws SecurityError on
        // failure; the error-handler middleware turns that into a JSON
        // envelope using the SecurityError's `code` and message.
        const tokens = await deps.tokenExchange(codeParam, rec.code_verifier);
        const profile = await deps.providerAdapter.fetchUserProfile(tokens.access_token);

        // Fresh session, then immediately regenerate to defeat any
        // attacker who pre-set a cookie before authentication.
        const created = await deps.sessionManager.create(profile);
        const regenerated = await deps.sessionManager.regenerate(created.session_id);

        const cookieValue = encodeCookie(regenerated.session_id, deps.cookieSecret);
        c.header(
            "Set-Cookie",
            buildSetCookieHeader(cookieValue, { isSecure: deps.isSecure }),
        );
        return c.redirect(rec.return_to, 302);
    });

    // Reject GET /auth/logout to defeat logout-via-image-tag CSRF.
    app.get("/auth/logout", (c) =>
        c.json(
            {
                error: {
                    code: "METHOD_NOT_ALLOWED",
                    message: "POST required for /auth/logout",
                },
            },
            STATUS_405,
        ),
    );

    app.post("/auth/logout", async (c) => {
        const cookieHeader = c.req.header("cookie") ?? "";
        const sessionId = parseSessionCookie(cookieHeader, deps.cookieSecret);
        if (sessionId !== null) {
            await deps.sessionManager.destroy(sessionId);
        }
        // Always clear the cookie even if no session was found.
        c.header(
            "Set-Cookie",
            buildSetCookieHeader("", {
                isSecure: deps.isSecure,
                maxAgeSeconds: 0,
            }),
        );
        return c.redirect("/", 302);
    });
}

/**
 * Re-exported so callers can use the same constant (tests and routes
 * that need to clear the cookie on auth failure).
 */
export { SESSION_COOKIE_NAME };
