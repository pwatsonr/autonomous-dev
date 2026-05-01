// SPEC-013-2-03 §Task 5 — Type and range validators for PortalConfig.
//
// Pure synchronous validation; throws PortalError('INVALID_CONFIG', ...)
// on the first failure. Called by loadPortalConfig after the merge step.
//
// SPEC-014-1-01 §Task 1.3 adds validateAuthConfig: a stricter
// auth-mode-specific gate (loopback enforcement, OAuth secret presence,
// HTTPS / proxy requirements) invoked from the startup checks pipeline
// before validateBindingConfig. Both validators run on the merged config;
// neither mutates its argument.

import { PortalError } from "../middleware/error-handler";
import { SecurityError } from "../auth/types";
import type { PortalConfig } from "./config";

const AUTH_MODES = ["localhost", "tailscale", "oauth", "oauth-pkce"] as const;
const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;

export function validateConfig(c: PortalConfig): void {
    if (!Number.isInteger(c.port) || c.port < 1024 || c.port > 65535) {
        throw new PortalError(
            "INVALID_CONFIG",
            `port must be integer in [1024, 65535], got ${String(c.port)}`,
            500,
        );
    }
    if (!(AUTH_MODES as readonly string[]).includes(c.auth_mode)) {
        throw new PortalError(
            "INVALID_CONFIG",
            "auth_mode must be one of localhost|tailscale|oauth|oauth-pkce",
            500,
        );
    }
    if (!(LOG_LEVELS as readonly string[]).includes(c.logging.level)) {
        throw new PortalError(
            "INVALID_CONFIG",
            "logging.level invalid",
            500,
        );
    }
    if (
        !Array.isArray(c.allowed_origins) ||
        c.allowed_origins.some((o) => typeof o !== "string")
    ) {
        throw new PortalError(
            "INVALID_CONFIG",
            "allowed_origins must be string[]",
            500,
        );
    }
    if (
        c.shutdown.grace_period_ms <= 0 ||
        c.shutdown.force_timeout_ms <= c.shutdown.grace_period_ms
    ) {
        throw new PortalError(
            "INVALID_CONFIG",
            "shutdown.force_timeout_ms must exceed grace_period_ms",
            500,
        );
    }
}

/**
 * SPEC-014-1-01 §Task 1.3 — Auth-mode-specific safety gate.
 *
 * Runs after validateConfig (which already enforced enum membership of
 * `auth_mode`) and before any network binding. Throws SecurityError on
 * the first failure with an actionable, field-named message; never logs
 * the values of `*_env` secrets.
 *
 * The localhost/tailscale checks are intentionally redundant with
 * `enforceBinding` from SPEC-014-1-02: defense-in-depth. If a future
 * refactor weakens one layer the other still holds the line.
 */
export function validateAuthConfig(c: PortalConfig): void {
    if (
        c.auth_mode !== "localhost" &&
        c.auth_mode !== "tailscale" &&
        c.auth_mode !== "oauth-pkce" &&
        c.auth_mode !== "oauth"
    ) {
        throw new SecurityError(
            "INVALID_AUTH_MODE",
            `auth_mode must be one of: localhost, tailscale, oauth-pkce. Got: '${String(
                c.auth_mode,
            )}'`,
        );
    }

    if (c.auth_mode === "localhost") {
        // bind_host=null is the recommended default; resolveBindHostname
        // substitutes 127.0.0.1. Any explicit override is rejected.
        if (
            c.bind_host !== null &&
            c.bind_host !== undefined &&
            c.bind_host !== "127.0.0.1"
        ) {
            throw new SecurityError(
                "LOCALHOST_REQUIRES_LOOPBACK",
                `auth_mode='localhost' requires bind_host='127.0.0.1' or null (got '${c.bind_host}'). ` +
                    `Switch to auth_mode='tailscale' or 'oauth-pkce' for network exposure.`,
            );
        }
        return;
    }

    if (c.auth_mode === "tailscale") {
        if (c.bind_host === "0.0.0.0") {
            throw new SecurityError(
                "INSECURE_BIND",
                `auth_mode='tailscale' refuses bind_host='0.0.0.0'. ` +
                    `Set bind_host='auto' (resolves to the Tailscale interface IP) or the explicit Tailnet IP.`,
            );
        }
        // The richer interface-IP gate lives in enforceBinding (SPEC-014-1-03).
        return;
    }

    // OAuth path. Both legacy `oauth` and canonical `oauth-pkce` land here.
    const oa = c.oauth_auth;
    if (oa === undefined) {
        throw new SecurityError(
            "OAUTH_MISSING_CONFIG",
            `auth_mode='${c.auth_mode}' requires the 'oauth_auth' config block ` +
                `(provider, client_id, client_secret_env, redirect_url, cookie_secret_env).`,
        );
    }
    if (
        typeof oa.provider !== "string" ||
        (oa.provider !== "github" && oa.provider !== "google")
    ) {
        throw new SecurityError(
            "OAUTH_INVALID_PROVIDER",
            `oauth_auth.provider must be 'github' or 'google' (got '${String(oa.provider)}').`,
        );
    }
    if (typeof oa.client_id !== "string" || oa.client_id.length === 0) {
        throw new SecurityError(
            "OAUTH_MISSING_CLIENT_ID",
            "oauth_auth.client_id must be a non-empty string.",
        );
    }
    if (
        typeof oa.client_secret_env !== "string" ||
        oa.client_secret_env.length === 0
    ) {
        throw new SecurityError(
            "OAUTH_MISSING_SECRET_ENV",
            "oauth_auth.client_secret_env must name an environment variable.",
        );
    }
    if (
        typeof oa.cookie_secret_env !== "string" ||
        oa.cookie_secret_env.length === 0
    ) {
        throw new SecurityError(
            "OAUTH_MISSING_SECRET_ENV",
            "oauth_auth.cookie_secret_env must name an environment variable.",
        );
    }
    if (typeof oa.redirect_url !== "string" || oa.redirect_url.length === 0) {
        throw new SecurityError(
            "OAUTH_MISSING_REDIRECT_URL",
            "oauth_auth.redirect_url must be a non-empty URL string.",
        );
    }
    const isLoopbackBind =
        c.bind_host === "127.0.0.1" || c.bind_host === null;
    if (
        oa.redirect_url.startsWith("http://") &&
        !isLoopbackBind
    ) {
        throw new SecurityError(
            "OAUTH_REQUIRES_HTTPS",
            `oauth_auth.redirect_url must use https:// unless bind_host='127.0.0.1' (got '${oa.redirect_url}').`,
        );
    }
    const clientSecret = process.env[oa.client_secret_env];
    if (clientSecret === undefined || clientSecret.length === 0) {
        throw new SecurityError(
            "OAUTH_MISSING_SECRET",
            `Environment variable '${oa.client_secret_env}' (named by oauth_auth.client_secret_env) is not set.`,
        );
    }
    const cookieSecret = process.env[oa.cookie_secret_env];
    if (cookieSecret === undefined || cookieSecret.length === 0) {
        throw new SecurityError(
            "OAUTH_MISSING_SECRET",
            `Environment variable '${oa.cookie_secret_env}' (named by oauth_auth.cookie_secret_env) is not set.`,
        );
    }
    if (
        !isLoopbackBind &&
        c.tls === undefined &&
        c.trusted_reverse_proxy !== true
    ) {
        throw new SecurityError(
            "OAUTH_REQUIRES_TLS_OR_PROXY",
            `auth_mode='${c.auth_mode}' with bind_host='${String(
                c.bind_host,
            )}' requires either a tls block or trusted_reverse_proxy=true.`,
        );
    }
    if (
        c.bind_host === "0.0.0.0" &&
        c.tls === undefined &&
        c.trusted_reverse_proxy !== true
    ) {
        throw new SecurityError(
            "INSECURE_BIND",
            `bind_host='0.0.0.0' requires either a tls block or trusted_reverse_proxy=true.`,
        );
    }
}
