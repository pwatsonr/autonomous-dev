// SPEC-013-3-04 §Task 1 — Verifies that all 9 portal routes are registered
// via `registerRoutes(app)` and respond with the expected status codes
// for happy-path and missing-resource scenarios.
//
// Tests construct a fresh Hono app per case and use `app.request()` for
// in-memory HTTP testing. No real server is bound. This is fast and
// avoids the per-test port allocation that bootstrap.test.ts requires.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

const PAGE_ROUTES = [
    "/",
    "/approvals",
    "/settings",
    "/costs",
    "/logs",
    "/ops",
    "/audit",
] as const;

describe("registerRoutes — all 9 routes mounted", () => {
    for (const path of PAGE_ROUTES) {
        test(`GET ${path} returns 200`, async () => {
            const app = freshApp();
            const res = await app.request(path);
            expect(res.status).toBe(200);
        });
    }

    test("GET /repo/:repo/request/:id is mounted (not Hono default 404)", async () => {
        const app = freshApp();
        // Goal of this suite is "all routes mounted" — verify the path is
        // routed at all. A bogus repo deterministically yields the
        // handler's notFound(c) (404 emitted by the route, not Hono's
        // default `Not Found` for an unmounted path). Distinguish by
        // body content: Hono's default unmounted-route response is the
        // text "404 Not Found"; the handler's notFound() returns an HTML
        // page.
        const res = await app.request("/repo/acme/request/REQ-999999");
        // 404 is fine (it means the route was hit and the handler ran);
        // the body content disambiguates handler-404 from unmounted-404.
        expect(res.status).toBe(404);
        const ct = res.headers.get("content-type") ?? "";
        // notFound() in response-utils.ts emits an HTML page, NOT the
        // plaintext "404 Not Found" body that Hono ships for unmounted
        // routes.
        expect(ct.toLowerCase()).toContain("text/html");
    });

    test("GET /health returns 200 with JSON body", async () => {
        const app = freshApp();
        const res = await app.request("/health");
        expect(res.status).toBe(200);
        const ct = res.headers.get("content-type") ?? "";
        expect(ct).toContain("application/json");
    });
});

describe("registerRoutes — unknown route", () => {
    test("GET /does-not-exist returns 404 (Hono default)", async () => {
        const app = freshApp();
        const res = await app.request("/does-not-exist");
        expect(res.status).toBe(404);
    });
});

describe("registerRoutes — content type for HTML page routes", () => {
    test("GET / returns text/html", async () => {
        const app = freshApp();
        const res = await app.request("/");
        const ct = res.headers.get("content-type") ?? "";
        expect(ct.toLowerCase()).toContain("text/html");
    });

    test("GET /approvals returns text/html", async () => {
        const app = freshApp();
        const res = await app.request("/approvals");
        const ct = res.headers.get("content-type") ?? "";
        expect(ct.toLowerCase()).toContain("text/html");
    });
});
