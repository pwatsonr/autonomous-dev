// SPEC-014-2-04 §security-headers — Composite middleware that sets all
// non-CSP security response headers. Kept separate from
// {@link cspMiddleware} so the CSP, which depends on per-request nonce
// generation, can iterate independently of the static-header set.
//
// Headers emitted on every response:
//   - Strict-Transport-Security:  ONLY when production AND request is https
//                                 (NEVER on localhost — would brick dev).
//   - X-Frame-Options:           DENY (clickjacking)
//   - X-Content-Type-Options:    nosniff
//   - Referrer-Policy:           strict-origin-when-cross-origin
//   - Permissions-Policy:        camera=(), microphone=(), geolocation=()
//   - X-Permitted-Cross-Domain-Policies: none
//   - X-XSS-Protection:          1; mode=block (legacy browsers)
//
// HSTS preload is opt-in via {@link SecurityHeadersConfig.hstsPreload};
// preloading is a one-way ticket so we leave it off by default.

import type { MiddlewareHandler } from "hono";

export interface SecurityHeadersConfig {
    /** When true (production + https) the HSTS header is emitted. */
    hstsEnabled: boolean;
    /** HSTS max-age in seconds. Default 31_536_000 (1 year). */
    hstsMaxAge: number;
    /** Append `includeSubDomains` to the HSTS header. Default true. */
    hstsIncludeSubdomains: boolean;
    /**
     * Append `preload` to the HSTS header. Default false — submitting to
     * the preload list is hard to reverse, so we make this opt-in.
     */
    hstsPreload: boolean;
    /** X-Frame-Options value. Default DENY. */
    frameOptions: "DENY" | "SAMEORIGIN";
    /** Referrer-Policy value. Default strict-origin-when-cross-origin. */
    referrerPolicy:
        | "no-referrer"
        | "same-origin"
        | "strict-origin"
        | "strict-origin-when-cross-origin";
    /** Permissions-Policy directives joined by `, `. Default disables camera, mic, geolocation. */
    permissionsPolicy: string[];
    /**
     * Test introspection / override hook. When set, treats the request as
     * https regardless of the request URL (used by tests that drive Hono
     * with `app.request('/path')` which yields a non-https URL).
     */
    forceHttps?: boolean;
}

export const DEFAULT_SECURITY_HEADERS_CONFIG: SecurityHeadersConfig =
    Object.freeze({
        hstsEnabled: true,
        hstsMaxAge: 31_536_000,
        hstsIncludeSubdomains: true,
        hstsPreload: false,
        frameOptions: "DENY",
        referrerPolicy: "strict-origin-when-cross-origin",
        permissionsPolicy: [
            "camera=()",
            "microphone=()",
            "geolocation=()",
        ],
    });

/**
 * Build the HSTS header value. Pure: deterministic from config alone.
 */
export function buildHstsValue(config: SecurityHeadersConfig): string {
    const parts = [`max-age=${String(config.hstsMaxAge)}`];
    if (config.hstsIncludeSubdomains) parts.push("includeSubDomains");
    if (config.hstsPreload) parts.push("preload");
    return parts.join("; ");
}

/**
 * Determine whether HSTS should be emitted for this request. HSTS is
 * dangerous on `http://localhost` — once the browser caches it, every
 * subsequent localhost dev session breaks. We require BOTH `hstsEnabled`
 * AND a proven-https URL (or `forceHttps` test override).
 */
function shouldEmitHsts(
    config: SecurityHeadersConfig,
    url: string,
    nodeEnv: string,
): boolean {
    if (!config.hstsEnabled) return false;
    if (nodeEnv !== "production") return false;
    if (config.forceHttps === true) return true;
    return url.startsWith("https://");
}

/**
 * Composite middleware: emits the static security header set on every
 * response. Order requirement: must run BEFORE the CSP middleware so the
 * CSP middleware can layer on top without overwriting these.
 */
export function securityHeaders(
    overrides: Partial<SecurityHeadersConfig> = {},
    env: NodeJS.ProcessEnv = process.env,
): MiddlewareHandler {
    const config: SecurityHeadersConfig = {
        ...DEFAULT_SECURITY_HEADERS_CONFIG,
        ...overrides,
    };
    const nodeEnv = env["NODE_ENV"] ?? "development";

    return async (c, next) => {
        c.header("X-Frame-Options", config.frameOptions);
        c.header("X-Content-Type-Options", "nosniff");
        c.header("Referrer-Policy", config.referrerPolicy);
        c.header("X-XSS-Protection", "1; mode=block");
        c.header("X-Permitted-Cross-Domain-Policies", "none");
        c.header(
            "Permissions-Policy",
            config.permissionsPolicy.join(", "),
        );
        if (shouldEmitHsts(config, c.req.url, nodeEnv)) {
            c.header("Strict-Transport-Security", buildHstsValue(config));
        }
        await next();
    };
}
