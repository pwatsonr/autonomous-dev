// SPEC-013-2-01 stub — minimal middleware orchestrator so server.ts
// type-checks. SPEC-013-2-02 replaces this with the full chain
// (request-id, structured logger, timing, security headers, CORS,
// error boundary). SPEC-013-2-04 prepends the connection counter.

import type { Hono } from "hono";
import type { PortalConfig } from "../lib/config";

export function applyMiddlewareChain(_app: Hono, _config: PortalConfig): void {
    // No-op stub. Full chain ships in SPEC-013-2-02.
}
