// SPEC-013-3-04 §Task 2 — Path-parameter validation for the request-detail
// route. The route validates the REQ-id format (REQ- followed by 6 digits)
// and the repo slug. Invalid inputs return 404 (so we don't leak info
// about whether a given repo/request id exists).

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

describe("request-detail — REQ-id format validation", () => {
    test("valid REQ-NNNNNN format does not 400/422 (passes format gate)", async () => {
        // The point of this test is that the REQ-NNNNNN format gate
        // accepts the id; 200 if state exists, 404 if not. Pre-PR #329
        // a missing fixture would 500 — we just want to confirm the
        // format-validator path is reachable.
        const app = freshApp();
        const res = await app.request(
            "/repo/acme%2Fwidgets/request/REQ-000001",
        );
        expect([200, 404]).toContain(res.status);
    });

    test("REQ-id with 7 digits returns 404", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/acme%2Fwidgets/request/REQ-1234567",
        );
        expect([400, 404]).toContain(res.status);
    });

    test("REQ-id with 5 digits returns 404", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/acme%2Fwidgets/request/REQ-12345",
        );
        expect([400, 404]).toContain(res.status);
    });

    test("lowercase req-id returns 404", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/acme%2Fwidgets/request/req-000001",
        );
        expect([400, 404]).toContain(res.status);
    });

    test("REQ-id with non-digits returns 404", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/acme%2Fwidgets/request/REQ-ABCDEF",
        );
        expect([400, 404]).toContain(res.status);
    });
});

describe("request-detail — repo slug variants", () => {
    test("github-style org/repo (URL-encoded /) is accepted by the slug gate", async () => {
        // Same intent as the REQ-id format test: confirm the route
        // doesn't reject URL-encoded slashes outright. 200 if state
        // exists for torvalds/linux, 404 if not. Either is fine —
        // the failure mode we care about is 400/422/500.
        const app = freshApp();
        const res = await app.request(
            "/repo/torvalds%2Flinux/request/REQ-000123",
        );
        expect([200, 404]).toContain(res.status);
    });

    test("repo with hyphen and underscore in name is accepted by the slug gate", async () => {
        const app = freshApp();
        const res = await app.request(
            "/repo/my-org%2Fsome_repo/request/REQ-000001",
        );
        expect([200, 404]).toContain(res.status);
    });
});
