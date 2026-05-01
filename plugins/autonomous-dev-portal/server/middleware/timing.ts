// SPEC-013-2-02 §Task 3 — Server-Timing middleware.
//
// Measures total request duration and emits the W3C `Server-Timing` header.
// Reads the start time from `startTimeMs` set by the structured logger;
// falls back to its own `performance.now()` if the logger is suppressed
// at the configured level.

import type { MiddlewareHandler } from "hono";

export function timingMiddleware(): MiddlewareHandler {
    return async (c, next) => {
        const start = c.var.startTimeMs ?? performance.now();
        await next();
        const dur = (performance.now() - start).toFixed(1);
        c.header("Server-Timing", `total;dur=${dur}`);
    };
}
