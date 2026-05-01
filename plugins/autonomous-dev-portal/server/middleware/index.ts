// SPEC-013-2-02 §Task 6 — Chain orchestrator.
//
// Wires the cross-cutting middleware in a fixed, contractual order:
//
//   1. request-id        (correlation; sets c.var.requestId)
//   2. structured logger (access-log emission; stores startTimeMs on context)
//   3. timing            (Server-Timing header)
//   4. secure-headers    (CSP, Referrer-Policy, X-Frame-Options, etc.)
//   5. cors              (origin allowlist driven by auth_mode)
//   6. error boundary    (last; wraps every handler in try/catch)
//
// SPEC-013-2-04 prepends a connection-counter middleware as position 0.
// SPEC-013-2-03 inserts an OAuth extension attach call at the EXTENSION
// POINT comment. TDD-014 plans insert auth/CSRF middleware at the same
// extension point. Do not move the comment.

import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { Hono } from "hono";

import type { PortalConfig } from "../lib/config";
import { getOAuthExtension } from "../lib/oauth-extension";
import { errorHandler } from "./error-handler";
import { requestIdMiddleware } from "./request-id";
import { structuredLogger } from "./logging";
import { timingMiddleware } from "./timing";

// CSP as Hono's structured options. Resulting header is the documented
// `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
// img-src 'self' data:; font-src 'self'; object-src 'none';
// frame-ancestors 'none'`.
function buildCspOptions(): {
    defaultSrc: string[];
    scriptSrc: string[];
    styleSrc: string[];
    imgSrc: string[];
    fontSrc: string[];
    objectSrc: string[];
    frameAncestors: string[];
} {
    return {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
    };
}

export function applyMiddlewareChain(app: Hono, config: PortalConfig): void {
    // Order is contractual; do not reorder.
    app.use("*", requestIdMiddleware()); // 1. correlation
    app.use("*", structuredLogger(config.logging.level)); // 2. access logs
    app.use("*", timingMiddleware()); // 3. Server-Timing
    app.use(
        "*",
        secureHeaders({
            contentSecurityPolicy: buildCspOptions(),
            referrerPolicy: "strict-origin-when-cross-origin",
        }),
    ); // 4. security headers
    app.use(
        "*",
        cors({
            origin:
                config.auth_mode === "localhost"
                    ? [
                          `http://127.0.0.1:${String(config.port)}`,
                          `https://127.0.0.1:${String(config.port)}`,
                      ]
                    : (config.allowed_origins ?? []),
            credentials: true,
            allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            allowHeaders: [
                "Content-Type",
                "Authorization",
                "X-Requested-With",
                "X-CSRF-Token",
            ],
        }),
    ); // 5. CORS

    // EXTENSION POINT: TDD-014 auth + CSRF middleware are inserted here.
    // SPEC-013-2-03 adds the OAuth extension attach hook here.
    const oauth = getOAuthExtension();
    if (oauth !== null && config.oauth !== undefined) {
        oauth.attach(app, config.oauth);
    }

    app.use("*", errorHandler()); // 6. error boundary
}
