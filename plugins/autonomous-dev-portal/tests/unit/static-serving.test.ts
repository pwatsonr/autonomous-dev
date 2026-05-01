// SPEC-013-4-04 §Static-asset serving — MIME, cache, ETag, 304, range,
// path-traversal blocking, X-Content-Type-Options.
//
// Tests construct an in-memory Hono with `app.get('/static/*', staticAssets(...))`
// pointed at a tmpdir fixture so they don't touch the real plugin assets.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Hono } from "hono";

import { staticAssets } from "../../server/middleware/static-assets";

let tmp: string;
let app: Hono;

function buildApp(rootDir: string): Hono {
    const a = new Hono();
    a.get("/static/*", staticAssets({ rootDir, urlPrefix: "/static" }));
    return a;
}

beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "portal-static-"));
    writeFileSync(join(tmp, "portal.css"), "body{color:red}");
    writeFileSync(join(tmp, "htmx.min.js"), "console.log('htmx');");
    mkdirSync(join(tmp, "icons"));
    writeFileSync(
        join(tmp, "icons", "daemon-running.svg"),
        "<svg></svg>",
    );
    app = buildApp(tmp);
});

afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// MIME types
// ---------------------------------------------------------------------------

describe("MIME-type detection", () => {
    test(".css → text/css", async () => {
        const res = await app.request("/static/portal.css");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/css");
    });

    test(".js → application/javascript", async () => {
        const res = await app.request("/static/htmx.min.js");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain(
            "application/javascript",
        );
    });

    test(".svg → image/svg+xml", async () => {
        const res = await app.request("/static/icons/daemon-running.svg");
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("image/svg+xml");
    });
});

// ---------------------------------------------------------------------------
// X-Content-Type-Options
// ---------------------------------------------------------------------------

describe("Security headers", () => {
    test("X-Content-Type-Options: nosniff is set on every response", async () => {
        const res = await app.request("/static/portal.css");
        expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    });
});

// ---------------------------------------------------------------------------
// ETag + 304
// ---------------------------------------------------------------------------

describe("ETag and 304 handling", () => {
    test("response has an ETag header", async () => {
        const res = await app.request("/static/portal.css");
        expect(res.headers.get("etag") ?? "").toMatch(/^W?\/?".+"$/);
    });

    test("If-None-Match with matching ETag returns 304 with empty body", async () => {
        const first = await app.request("/static/portal.css");
        const etag = first.headers.get("etag") ?? "";
        const second = await app.request("/static/portal.css", {
            headers: { "If-None-Match": etag },
        });
        expect(second.status).toBe(304);
        const body = await second.text();
        expect(body).toBe("");
    });

    test("If-None-Match with stale ETag still returns 200", async () => {
        const res = await app.request("/static/portal.css", {
            headers: { "If-None-Match": '"stale-1"' },
        });
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// Cache-Control
// ---------------------------------------------------------------------------

describe("Cache-Control policy", () => {
    test("unhashed asset gets max-age=86400", async () => {
        const res = await app.request("/static/portal.css");
        expect(res.headers.get("cache-control") ?? "").toContain(
            "max-age=86400",
        );
    });

    test("hashed asset (suffix -<hex>.<ext>) gets immutable + 1-year max-age", async () => {
        writeFileSync(join(tmp, "portal-abcd1234.css"), "body{color:blue}");
        const res = await app.request("/static/portal-abcd1234.css");
        expect(res.status).toBe(200);
        const cc = res.headers.get("cache-control") ?? "";
        expect(cc).toContain("immutable");
        expect(cc).toContain("max-age=31536000");
    });
});

// ---------------------------------------------------------------------------
// Range requests
// ---------------------------------------------------------------------------

describe("Range requests", () => {
    beforeEach(() => {
        writeFileSync(
            join(tmp, "big.css"),
            "abcdefghijklmnopqrstuvwxyz".repeat(40), // 1040 bytes
        );
    });

    test("valid bytes=0-9 returns 206 with first 10 bytes", async () => {
        const res = await app.request("/static/big.css", {
            headers: { Range: "bytes=0-9" },
        });
        expect(res.status).toBe(206);
        const body = await res.text();
        expect(body.length).toBe(10);
    });

    test("malformed range falls back to 200 with full body", async () => {
        const res = await app.request("/static/big.css", {
            headers: { Range: "totally-not-a-range" },
        });
        expect(res.status).toBe(200);
    });
});

// ---------------------------------------------------------------------------
// Path-traversal blocking
// ---------------------------------------------------------------------------

describe("Path-traversal blocking", () => {
    test("../etc/passwd is rejected", async () => {
        const res = await app.request("/static/../etc/passwd");
        expect([400, 403, 404]).toContain(res.status);
    });

    test("encoded ..%2fetc%2fpasswd is rejected", async () => {
        const res = await app.request("/static/..%2fetc%2fpasswd");
        expect([400, 403, 404]).toContain(res.status);
    });

    test("absolute path /etc/passwd is rejected", async () => {
        const res = await app.request("/static//etc/passwd");
        expect([400, 403, 404]).toContain(res.status);
    });

    test("missing file returns 404", async () => {
        const res = await app.request("/static/does-not-exist.css");
        expect(res.status).toBe(404);
    });
});
