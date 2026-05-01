// SPEC-013-2-02 §Task 2 — Structured access logger.
//
// Emits one JSON line per request to stdout. The line carries the standard
// access-log fields plus the request_id set by request-id middleware. Below
// the configured min level the line is suppressed; the start time is still
// recorded on the context for downstream timing middleware.

import type { MiddlewareHandler } from "hono";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

export function structuredLogger(level: Level): MiddlewareHandler {
    const minLevel = ORDER[level];
    return async (c, next) => {
        const start = performance.now();
        c.set("startTimeMs", start);
        await next();
        // Access logs emit at info; suppress when min level is higher.
        if (ORDER.info < minLevel) return;
        const duration_ms = Math.round(performance.now() - start);
        process.stdout.write(
            JSON.stringify({
                ts: new Date().toISOString(),
                level: "info",
                request_id: c.var.requestId,
                method: c.req.method,
                path: c.req.path,
                status: c.res.status,
                duration_ms,
                user_agent: c.req.header("user-agent") ?? null,
                bytes_in: Number(c.req.header("content-length") ?? 0),
            }) + "\n",
        );
    };
}
