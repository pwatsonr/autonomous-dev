// SPEC-015-1-02 — `GET /portal/events` Hono route.
//
// Thin delegation: the bus owns connection lifecycle, headers, and the
// 429 backpressure path. Mounted by registerRoutes() at portal-server
// init time (SPEC-013-3-01).

import { Hono } from "hono";

import type { SSEEventBus } from "../sse/SSEEventBus";

export function eventsRoute(bus: SSEEventBus): Hono {
    const app = new Hono();
    app.get("/portal/events", (c) => bus.handleConnection(c));
    return app;
}
