// SPEC-014-2-04 §CSPMiddleware — Hono middleware that generates a
// per-request nonce, builds the CSP directive string, and emits the
// `Content-Security-Policy` (or `Content-Security-Policy-Report-Only`)
// header.
//
// The nonce is exposed via `c.set('cspNonce', value)` so JSX templates can
// read it for `<script nonce="...">` attributes (see
// `templates/layout/base.tsx`). Templates without nonce attributes will
// therefore be blocked in production — by design.
//
// Nonce format: 16 random bytes encoded as base64. Produces a 24-char URL-
// safe string; matches RFC 7636 / W3C CSP §4 nonce requirements (≥128 bits
// of entropy, base64-encoded).

import { randomBytes } from "node:crypto";
import type { MiddlewareHandler } from "hono";

import {
    buildDirectives,
    directivesToString,
    type CSPConfig,
} from "./csp-config";

const NONCE_BYTES = 16;

/**
 * Pure helper: 16 cryptographically random bytes, base64-encoded. Exported
 * for tests; production callers should not need direct access.
 */
export function generateNonce(): string {
    return randomBytes(NONCE_BYTES).toString("base64");
}

/**
 * Build the wire-format CSP header for a request. Pure with respect to
 * `config` and `nonce` — no module state, no IO.
 */
export function buildCSPHeader(config: CSPConfig, nonce: string): string {
    const directives = buildDirectives(config, nonce);
    let header = directivesToString(directives);
    if (config.reportUri !== undefined && config.reportUri.length > 0) {
        header += `; report-uri ${config.reportUri}`;
    }
    return header;
}

/**
 * Returns the response header name the middleware will write. Production
 * uses the enforcing variant; report-only mode (development default) uses
 * `Content-Security-Policy-Report-Only`.
 */
export function cspHeaderName(config: CSPConfig): string {
    return config.reportOnly
        ? "Content-Security-Policy-Report-Only"
        : "Content-Security-Policy";
}

/**
 * Hono middleware factory. Generates a per-request nonce, stores it on the
 * context (for templates), and emits the CSP header.
 *
 * Order requirement (set by SPEC-014-2-04 §Middleware Registration):
 *   request-id → logger → security-headers → CSP → CORS → auth → CSRF
 *
 * The middleware MUST run BEFORE the response body is generated so the
 * nonce is available to templates downstream.
 */
export function cspMiddleware(config: CSPConfig): MiddlewareHandler {
    const headerName = cspHeaderName(config);
    return async (c, next) => {
        const nonce = config.enableNonce ? generateNonce() : "";
        c.set("cspNonce", nonce);
        const header = buildCSPHeader(config, nonce);
        c.header(headerName, header);
        await next();
    };
}

/**
 * PLAN-041 §Follow-ups F-041-01 — strict CSP variant emitted as a SECOND
 * `Content-Security-Policy-Report-Only` header alongside the primary
 * {@link cspMiddleware} output. Purpose: surface (but do not block)
 * inline-style violations the lenient baseline still permits, so the
 * operator can iterate on the last known offenders (notably the
 * `/design-system` route) without breaking the running app.
 *
 * Contract:
 *   - Always emits to `Content-Security-Policy-Report-Only` (NEVER the
 *     enforcing variant — flipping to enforce is an operator decision
 *     made after the violation reports are clean).
 *   - Reuses the per-request nonce set by {@link cspMiddleware} via
 *     `c.get('cspNonce')`. Falls back to its own nonce if the primary
 *     middleware did not run (defensive; the chain wires both).
 *   - Must run AFTER {@link cspMiddleware} so the nonce is available.
 *
 * TODO(F-041-XX, follow-up to F-041-01): once the design-system route
 * and any other inline-style call sites are migrated, retire
 * {@link defaultCSPConfig}'s `allowUnsafeInlineStyles: true` default and
 * fold this strict header into the primary CSP — delete this middleware
 * factory at that point. Tracking issue belongs in the follow-up to
 * F-041-01 (see PLAN-041 §Follow-ups).
 */
export function strictCspReportOnlyMiddleware(
    config: CSPConfig,
): MiddlewareHandler {
    // Guard: this middleware exists specifically to surface violations
    // without blocking. If a caller passes an enforcing config we
    // deliberately downgrade rather than silently enforce.
    const reportOnlyConfig: CSPConfig = config.reportOnly
        ? config
        : { ...config, reportOnly: true };
    return async (c, next) => {
        // Reuse the primary CSP middleware's nonce when available so the
        // strict policy validates against the SAME inline scripts the
        // browser is being asked to load.
        let nonce = c.get("cspNonce") as string | undefined;
        if (nonce === undefined || nonce.length === 0) {
            nonce = reportOnlyConfig.enableNonce ? generateNonce() : "";
            c.set("cspNonce", nonce);
        }
        const header = buildCSPHeader(reportOnlyConfig, nonce);
        // append:true — when the primary CSP middleware is ALSO emitting
        // a report-only header (development default), both policies are
        // sent and the browser ANDs them per W3C CSP §3.2.2. In production
        // the primary header is `Content-Security-Policy` (enforcing), so
        // there is no collision and append is a no-op.
        c.header("Content-Security-Policy-Report-Only", header, {
            append: true,
        });
        await next();
    };
}
