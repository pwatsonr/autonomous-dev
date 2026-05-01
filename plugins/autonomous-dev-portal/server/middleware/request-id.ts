// SPEC-013-2-02 §Task 1 — Request ID middleware.
//
// Issues a UUIDv4 per request, exposed on the response as `x-request-id`
// and on the Hono context as `c.var.requestId`. Trusts upstream-provided
// IDs ONLY when they match a UUIDv4-shaped regex; arbitrary header values
// are rejected to prevent log injection.

import type { MiddlewareHandler } from "hono";

declare module "hono" {
    interface ContextVariableMap {
        requestId: string;
        startTimeMs: number;
    }
}

const HEADER = "x-request-id";
const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requestIdMiddleware(): MiddlewareHandler {
    return async (c, next) => {
        const incoming = c.req.header(HEADER);
        const id =
            incoming && UUID_RE.test(incoming) ? incoming : crypto.randomUUID();
        c.set("requestId", id);
        c.header(HEADER, id);
        await next();
    };
}
