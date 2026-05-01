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
