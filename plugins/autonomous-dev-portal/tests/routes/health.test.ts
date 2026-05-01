// SPEC-013-3-04 §Task 3 — `/health` JSON shape and status codes.
//
// The health endpoint returns:
//   { status: "ok" | "degraded", uptime_ms: number, ... }
// Status 200 when healthy; 503 when degraded.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

describe("/health JSON contract", () => {
    test("returns 200 in default conditions", async () => {
        const app = freshApp();
        const res = await app.request("/health");
        expect(res.status).toBe(200);
    });

    test("body parses as JSON", async () => {
        const app = freshApp();
        const res = await app.request("/health");
        const body = await res.json();
        expect(typeof body).toBe("object");
        expect(body).not.toBeNull();
    });

    test("body has a `status` field", async () => {
        const app = freshApp();
        const res = await app.request("/health");
        const body = (await res.json()) as { status?: string };
        expect(typeof body.status).toBe("string");
        expect(["ok", "degraded"]).toContain(body.status ?? "");
    });

    test("Content-Type is application/json", async () => {
        const app = freshApp();
        const res = await app.request("/health");
        const ct = res.headers.get("content-type") ?? "";
        expect(ct.toLowerCase()).toContain("application/json");
    });
});
