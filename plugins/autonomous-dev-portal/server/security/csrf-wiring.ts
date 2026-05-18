// CSRF middleware wiring — assembles the CSRFProtection store, the
// OriginValidator, and the per-request middleware pair (issuer + enforcer)
// for the portal HTTP app.
//
// Why this module exists: the CSRF building blocks in `csrf-protection.ts`
// are pure / single-purpose (per SPEC-014-2-01). This file is the one
// place that knows about portal-level shape — how to derive a session id
// when auth_mode === 'localhost' (no real auth context), which origins to
// allow, and how PORTAL_TEST_MODE relaxes enforcement for Cypress.
//
// Trust model for the default `getSessionId`:
//
//   When the auth context is absent (e.g. localhost auth_mode), every
//   client on this machine is treated as the same logical session. CSRF
//   still protects against cross-origin forgery because:
//     (1) the Origin / Referer fence rejects requests from foreign origins
//     (2) the double-submit signature lives in an HttpOnly SameSite=Strict
//         cookie that a foreign-origin attacker cannot read or set.
//   The single shared session-id just means the token store keys collide,
//   which is fine — only one user is supposed to be there.
//
// Test-mode bypass: when PORTAL_TEST_MODE is set, requests that carry
// `X-Cypress-Test: 1` skip CSRF entirely. The bypass is opt-in via env
// so production deploys cannot honor the header by accident.

import type { Context, MiddlewareHandler } from "hono";

import type { PortalConfig } from "../lib/config";
import {
    buildCSRFConfig,
    CSRFProtection,
    csrfMiddleware,
    csrfTokenIssuer,
    OriginValidator,
    type CSRFLogger,
    type CSRFMiddlewareDeps,
} from "./csrf-protection";

/** Fallback session id for environments without an auth context. */
const LOCALHOST_SESSION_ID = "localhost-user";

/** Header opted-in via PORTAL_TEST_MODE to bypass CSRF for Cypress. */
const TEST_BYPASS_HEADER = "x-cypress-test";

/**
 * Compute the list of allowed Origin/Referer values for the portal. Mirrors
 * (and slightly extends) the CORS allowlist in `applyMiddlewareChain`:
 *
 *   - localhost auth_mode:
 *       http(s)://127.0.0.1:PORT  AND  http(s)://localhost:PORT
 *     Cypress addresses the portal via `localhost`, so the loopback variant
 *     must be accepted — `127.0.0.1` and `localhost` are different origins
 *     by the spec even though they resolve to the same socket.
 *
 *   - non-localhost: the operator-supplied `allowed_origins` list. Empty
 *     list ⇒ no state-mutating request will pass origin validation. That
 *     is the documented safe default per SPEC-014-1-02.
 */
export function buildAllowedOrigins(config: PortalConfig): string[] {
    if (config.auth_mode === "localhost") {
        const port = String(config.port);
        return [
            `http://127.0.0.1:${port}`,
            `https://127.0.0.1:${port}`,
            `http://localhost:${port}`,
            `https://localhost:${port}`,
        ];
    }
    return config.allowed_origins ?? [];
}

/** Read PORTAL_TEST_MODE from the env, accepting common truthy strings. */
function isTestModeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const v = env["PORTAL_TEST_MODE"];
    if (v === undefined) return false;
    const norm = v.trim().toLowerCase();
    return norm === "1" || norm === "true" || norm === "yes";
}

/**
 * Default session-id resolver: prefer the authenticated user when present,
 * otherwise fall back to the shared {@link LOCALHOST_SESSION_ID}. The
 * fallback is what lets the CSRF middleware operate before / without auth
 * being wired in.
 */
export function defaultGetSessionId(c: Context): string | undefined {
    const auth = c.get("auth") as { source_user_id?: unknown } | undefined;
    if (auth !== undefined && typeof auth.source_user_id === "string" && auth.source_user_id.length > 0) {
        return auth.source_user_id;
    }
    return LOCALHOST_SESSION_ID;
}

/** Build the {@link CSRFMiddlewareDeps} bundle for the portal app. */
export interface BuildPortalCsrfOptions {
    /** Override the portal config-derived allowed-origins list. */
    allowedOrigins?: string[];
    /** Override the test-mode env read (tests inject false). */
    testMode?: boolean;
    /** Injectable logger; defaults to no-op. */
    logger?: CSRFLogger;
    /** Override the session-id resolver. */
    getSessionId?: (c: Context) => string | undefined;
}

export interface PortalCsrf {
    deps: CSRFMiddlewareDeps;
    csrf: CSRFProtection;
    origin: OriginValidator;
    testMode: boolean;
}

export function buildPortalCsrf(
    config: PortalConfig,
    options: BuildPortalCsrfOptions = {},
): PortalCsrf {
    const csrfConfig = buildCSRFConfig();
    const csrf = new CSRFProtection(csrfConfig);
    csrf.startCleanup();

    const allowedOrigins = options.allowedOrigins ?? buildAllowedOrigins(config);
    const nodeEnv = process.env["NODE_ENV"] ?? "development";
    const origin = new OriginValidator({ allowedOrigins, nodeEnv });

    const deps: CSRFMiddlewareDeps = {
        csrf,
        origin,
        config: csrfConfig,
        getSessionId: options.getSessionId ?? defaultGetSessionId,
    };
    if (options.logger !== undefined) deps.logger = options.logger;

    return {
        deps,
        csrf,
        origin,
        testMode: options.testMode ?? isTestModeEnabled(),
    };
}

/**
 * Wrap the CSRF middleware pair (issuer on GET, enforcer on state-changing
 * methods) so that PORTAL_TEST_MODE + `X-Cypress-Test: 1` short-circuits
 * both. The two helpers preserve the spec ordering — issuer first so the
 * token cookie is set before any HTML response goes out.
 */
export function portalCsrfIssuer(portal: PortalCsrf): MiddlewareHandler {
    const inner = csrfTokenIssuer(portal.deps);
    return async (c, next) => {
        if (portal.testMode && c.req.header(TEST_BYPASS_HEADER) === "1") {
            return next();
        }
        return inner(c, next);
    };
}

export function portalCsrfEnforcer(portal: PortalCsrf): MiddlewareHandler {
    const inner = csrfMiddleware(portal.deps);
    return async (c, next) => {
        if (portal.testMode && c.req.header(TEST_BYPASS_HEADER) === "1") {
            return next();
        }
        return inner(c, next);
    };
}
