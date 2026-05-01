// SPEC-013-4-04 §Compression — Brotli-preferred / gzip-fallback negotiation,
// minBytes threshold, and the precompressed-extension allowlist.
//
// Tests run the compression middleware in isolation against synthetic
// Hono apps. We do NOT rely on the static-assets middleware here so the
// compression contract is exercised directly.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { compression } from "../../server/middleware/compression";

const LARGE_BODY = "a".repeat(2048); // > default minBytes (1024)
const SMALL_BODY = "a".repeat(512); //  < default minBytes

function appReturning(body: string, contentType: string): Hono {
    const a = new Hono();
    a.use("*", compression());
    a.get("*", (c) => {
        c.header("content-type", contentType);
        c.header("content-length", String(Buffer.byteLength(body)));
        return c.body(body);
    });
    return a;
}

// ---------------------------------------------------------------------------
// Encoding negotiation
// ---------------------------------------------------------------------------

describe("Accept-Encoding negotiation", () => {
    test("br is preferred when client accepts both br and gzip", async () => {
        const app = appReturning(LARGE_BODY, "text/css");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "br, gzip" },
        });
        expect(res.headers.get("content-encoding")).toBe("br");
    });

    test("gzip is used when br is not in Accept-Encoding", async () => {
        const app = appReturning(LARGE_BODY, "text/css");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "gzip" },
        });
        expect(res.headers.get("content-encoding")).toBe("gzip");
    });

    test("no Accept-Encoding → no compression", async () => {
        const app = appReturning(LARGE_BODY, "text/css");
        const res = await app.request("/");
        expect(res.headers.get("content-encoding")).toBeNull();
    });

    test("compression sets Vary: Accept-Encoding", async () => {
        const app = appReturning(LARGE_BODY, "text/css");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "br" },
        });
        const vary = res.headers.get("vary") ?? "";
        expect(vary.toLowerCase()).toContain("accept-encoding");
    });
});

// ---------------------------------------------------------------------------
// Size threshold
// ---------------------------------------------------------------------------

describe("Size threshold", () => {
    test("body smaller than minBytes is NOT compressed", async () => {
        const app = appReturning(SMALL_BODY, "text/css");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "br, gzip" },
        });
        expect(res.headers.get("content-encoding")).toBeNull();
    });

    test("body larger than minBytes IS compressed", async () => {
        const app = appReturning(LARGE_BODY, "text/css");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "br" },
        });
        expect(res.headers.get("content-encoding")).toBe("br");
    });
});

// ---------------------------------------------------------------------------
// Compressible-type allowlist
// ---------------------------------------------------------------------------

describe("Compressible-type allowlist", () => {
    test("text/css is compressed", async () => {
        const app = appReturning(LARGE_BODY, "text/css");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "br" },
        });
        expect(res.headers.get("content-encoding")).toBe("br");
    });

    test("application/json is compressed", async () => {
        const json = JSON.stringify({ data: "a".repeat(2048) });
        const app = appReturning(json, "application/json");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "br" },
        });
        expect(res.headers.get("content-encoding")).toBe("br");
    });

    test("image/png (precompressed) is NOT compressed", async () => {
        const app = appReturning(LARGE_BODY, "image/png");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "br" },
        });
        expect(res.headers.get("content-encoding")).toBeNull();
    });

    test("font/woff2 (precompressed) is NOT compressed", async () => {
        const app = appReturning(LARGE_BODY, "font/woff2");
        const res = await app.request("/", {
            headers: { "Accept-Encoding": "br" },
        });
        expect(res.headers.get("content-encoding")).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Pre-set Content-Encoding
// ---------------------------------------------------------------------------

describe("Pre-set Content-Encoding", () => {
    test("downstream-set Content-Encoding is preserved (no double-compress)", async () => {
        const a = new Hono();
        a.use("*", compression());
        a.get("*", (c) => {
            c.header("content-type", "text/css");
            c.header("content-encoding", "gzip");
            c.header("content-length", String(LARGE_BODY.length));
            return c.body(LARGE_BODY);
        });
        const res = await a.request("/", {
            headers: { "Accept-Encoding": "br" },
        });
        expect(res.headers.get("content-encoding")).toBe("gzip");
    });
});
