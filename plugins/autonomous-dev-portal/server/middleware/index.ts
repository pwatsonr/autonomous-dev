// SPEC-013-2-02 §Task 6 — Chain orchestrator.
//
// Wires the cross-cutting middleware in a fixed, contractual order:
//
//   1. request-id        (correlation; sets c.var.requestId)
//   2. structured logger (access-log emission; stores startTimeMs on context)
//   3. timing            (Server-Timing header)
//   4. security-headers  (HSTS, X-Frame-Options, Referrer-Policy, etc.)
//   5. csp-middleware    (per-request nonce + Content-Security-Policy)
//   6. cors              (origin allowlist driven by auth_mode)
//   7. error boundary    (last; wraps every handler in try/catch)
//
// SPEC-013-2-04 prepends a connection-counter middleware as position 0.
// SPEC-013-2-03 inserts an OAuth extension attach call at the EXTENSION
// POINT comment. TDD-014 plans insert auth/CSRF middleware at the same
// extension point. Do not move the comment.
//
// SPEC-014-2-04 swaps Hono's `secureHeaders` for a pair of bespoke
// middleware (`securityHeaders` + `cspMiddleware`) so we can generate a
// per-request CSP nonce that templates can read via `c.get('cspNonce')`.

import { cors } from "hono/cors";
import type { Hono } from "hono";

import type { PortalConfig } from "../lib/config";
import { connectionCounter } from "../lib/connection-tracker";
import { getOAuthExtension } from "../lib/oauth-extension";
import { cspMiddleware } from "../security/csp-middleware";
import { defaultCSPConfig, type CSPEnvironment } from "../security/csp-config";
import { securityHeaders } from "../security/security-headers";
import { compression } from "./compression";
import { errorHandler } from "./error-handler";
import { requestIdMiddleware } from "./request-id";
import { structuredLogger } from "./logging";
import { timingMiddleware } from "./timing";

function resolveCspEnvironment(env: NodeJS.ProcessEnv = process.env): CSPEnvironment {
    const v = env["NODE_ENV"];
    if (v === "production") return "production";
    if (v === "test") return "test";
    return "development";
}

export function applyMiddlewareChain(app: Hono, config: PortalConfig): void {
    // Order is contractual; do not reorder.
    app.use("*", connectionCounter()); // 0. drain tracking (SPEC-013-2-04)
    app.use("*", requestIdMiddleware()); // 1. correlation
    app.use("*", structuredLogger(config.logging.level)); // 2. access logs
    app.use("*", timingMiddleware()); // 3. Server-Timing
    app.use("*", securityHeaders()); // 4. HSTS / X-Frame-Options / etc. (SPEC-014-2-04)
    app.use(
        "*",
        cspMiddleware(defaultCSPConfig(resolveCspEnvironment())),
    ); // 5. CSP w/ per-request nonce (SPEC-014-2-04)
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
    ); // 6. CORS

    // EXTENSION POINT: TDD-014 auth + CSRF middleware are inserted here.
    // SPEC-013-2-03 adds the OAuth extension attach hook here.
    const oauth = getOAuthExtension();
    if (oauth !== null && config.oauth !== undefined) {
        oauth.attach(app, config.oauth);
    }

    // SPEC-013-4-01: compression wraps every response (incl. static
    // assets). Must come BEFORE the error boundary so error bodies are
    // also eligible for compression.
    app.use("*", compression()); // 6. response compression
    app.use("*", errorHandler()); // 7. error boundary
}
