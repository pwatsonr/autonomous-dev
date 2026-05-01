// SPEC-013-2-05 §Task 4 — Unit tests for the request-id middleware.
//
// Verifies UUID generation, valid-input echo, header-injection rejection,
// the c.var.requestId accessor, and the lowercase response-header name.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { requestIdMiddleware } from "../../server/middleware/request-id";

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function buildApp(): Hono {
    const app = new Hono();
    app.use("*", requestIdMiddleware());
    app.get("/", (c) => c.text(c.var.requestId));
    return app;
}

describe("requestIdMiddleware", () => {
    test("issues a UUIDv4-shaped id when no incoming header", async () => {
        const app = buildApp();
        const res = await app.request("/");
        const id = res.headers.get("x-request-id");
        expect(id).not.toBeNull();
        expect(UUID_RE.test(id ?? "")).toBe(true);
    });

    test("echoes a valid UUID provided in the request header", async () => {
        const app = buildApp();
        const provided = "12345678-1234-1234-1234-123456789012";
        const res = await app.request("/", {
            headers: { "x-request-id": provided },
        });
        expect(res.headers.get("x-request-id")).toBe(provided);
    });

    test("rejects script-injection-shaped header and issues a fresh UUID", async () => {
        const app = buildApp();
        const malicious = "<script>alert(1)</script>";
        const res = await app.request("/", {
            headers: { "x-request-id": malicious },
        });
        const id = res.headers.get("x-request-id");
        expect(id).not.toBe(malicious);
        expect(UUID_RE.test(id ?? "")).toBe(true);
    });

    test("rejects a bare numeric header and issues a fresh UUID", async () => {
        const app = buildApp();
        const res = await app.request("/", {
            headers: { "x-request-id": "12345" },
        });
        const id = res.headers.get("x-request-id");
        expect(id).not.toBe("12345");
        expect(UUID_RE.test(id ?? "")).toBe(true);
    });

    test("c.var.requestId is set inside handlers", async () => {
        const app = buildApp();
        const res = await app.request("/");
        const body = await res.text();
        expect(UUID_RE.test(body)).toBe(true);
        const headerId = res.headers.get("x-request-id") ?? "";
        expect(body).toBe(headerId);
    });

    test("response header name is exactly x-request-id (lowercase)", async () => {
        const app = buildApp();
        const res = await app.request("/");
        // Headers are case-insensitive, so check both spellings work and the
        // canonical lowercase form matches.
        expect(res.headers.get("x-request-id")).not.toBeNull();
        expect(res.headers.get("X-Request-ID")).not.toBeNull();
        expect(res.headers.get("x-request-id")).toBe(
            res.headers.get("X-Request-ID"),
        );
    });

    test("each request gets a distinct UUID", async () => {
        const app = buildApp();
        const r1 = await app.request("/");
        const r2 = await app.request("/");
        expect(r1.headers.get("x-request-id")).not.toBe(
            r2.headers.get("x-request-id"),
        );
    });
});
