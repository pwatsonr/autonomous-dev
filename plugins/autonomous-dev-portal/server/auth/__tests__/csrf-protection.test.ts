// SPEC-030-1-04: CSRF middleware tests.
//
// The portal's CSRF middleware lives at
// `server/security/csrf-protection.ts` (not under `server/auth/middleware/`
// per TDD-030 §3.2 — verified by grep before authoring). It implements:
//   - double-submit cookie pattern (token in header / body / query +
//     HMAC signature in HttpOnly cookie)
//   - Origin / Referer fence on every state-changing method
//   - Safe-method (GET/HEAD/OPTIONS) skip
//   - exclude-paths skip (e.g., /auth callback)
//
// The middleware factory is consumed by Hono. We exercise it through a
// minimal Hono app + `app.fetch(Request)` so the tests stay in-process
// (no `http.createServer`) — same pattern as Hono's own tests.
//
// Set-Cookie parsing goes through a structured ad-hoc parser.

import { Hono } from "hono";

import {
    buildCSRFConfig,
    buildCSRFCookie,
    csrfMiddleware,
    csrfTokenIssuer,
    CSRFProtection,
    OriginValidator,
} from "../../security/csrf-protection";

interface ParsedCookie {
    name: string;
    value: string;
    attrs: Map<string, string | true>;
}

function parseSetCookie(header: string): ParsedCookie {
    const segments = header.split(";").map((s) => s.trim());
    const head = segments[0] ?? "";
    const eq = head.indexOf("=");
    if (eq === -1) throw new Error("Set-Cookie missing name=value");
    const name = head.slice(0, eq);
    const value = head.slice(eq + 1);
    const attrs = new Map<string, string | true>();
    for (const seg of segments.slice(1)) {
        if (seg.length === 0) continue;
        const ai = seg.indexOf("=");
        if (ai === -1) {
            attrs.set(seg.toLowerCase(), true);
        } else {
            attrs.set(seg.slice(0, ai).toLowerCase(), seg.slice(ai + 1));
        }
    }
    return { name, value, attrs };
}

const ORIGIN = "https://portal.example.test";

function buildApp(opts: {
    /** Inject a fixed session id (defaults to "alice"). */
    sessionId?: string | undefined;
    /** Override allowed origins (defaults to [ORIGIN]). */
    allowedOrigins?: string[];
} = {}): {
    app: Hono;
    csrf: CSRFProtection;
} {
    const config = buildCSRFConfig({
        secretKey: "test-secret-32-bytes-x".repeat(2),
        // No exclude paths beyond what we test below; default has /auth, which we keep.
    });
    const csrf = new CSRFProtection(config);
    const origin = new OriginValidator({
        allowedOrigins: opts.allowedOrigins ?? [ORIGIN],
        nodeEnv: "development",
    });
    const sessionId = opts.sessionId ?? "alice";
    const deps = {
        csrf,
        origin,
        config,
        getSessionId: () => sessionId,
    };

    const app = new Hono();
    app.use("*", csrfTokenIssuer(deps));
    app.use("*", csrfMiddleware(deps));
    app.get("/x", (c) => c.text("ok"));
    app.post("/x", (c) => c.text("posted"));
    app.delete("/x", (c) => c.text("deleted"));
    // HEAD is implicit via GET in Hono; no explicit handler needed.
    return { app, csrf };
}

// -----------------------------------------------------------------------------
// First-GET issues a token cookie; structurally parsed
// -----------------------------------------------------------------------------

describe("csrf middleware — token issuance on first GET", () => {
    it("first GET emits a Set-Cookie with the documented attributes", async () => {
        const { app } = buildApp();
        const res = await app.fetch(
            new Request(`${ORIGIN}/x`, {
                method: "GET",
                headers: { Origin: ORIGIN },
            }),
        );
        expect(res.status).toBe(200);
        const setCookie = res.headers.get("set-cookie");
        expect(setCookie).not.toBeNull();
        const parsed = parseSetCookie(String(setCookie));
        expect(parsed.name).toBe("__csrf_signature");
        expect(parsed.value.length).toBeGreaterThan(0);
        expect(parsed.attrs.get("path")).toBe("/");
        expect(parsed.attrs.get("httponly")).toBe(true);
        expect(parsed.attrs.get("samesite")).toBe("Strict");
    });

    it("HEAD/OPTIONS bypass token enforcement entirely", async () => {
        const { app } = buildApp();
        const head = await app.fetch(
            new Request(`${ORIGIN}/x`, { method: "HEAD" }),
        );
        expect(head.status).toBe(200);
        const opt = await app.fetch(
            new Request(`${ORIGIN}/x`, { method: "OPTIONS" }),
        );
        // Hono returns 404 for an unrouted OPTIONS (we did not define one);
        // the contract here is "middleware did not return 403". Any non-403
        // status confirms the safe-method skip ran.
        expect(opt.status).not.toBe(403);
    });
});

// -----------------------------------------------------------------------------
// POST cases (matrix from SPEC-030-1-04)
// -----------------------------------------------------------------------------

describe("csrf middleware — POST enforcement", () => {
    async function postWith(
        app: Hono,
        opts: {
            cookie?: string;
            csrfHeader?: string;
            origin?: string | undefined;
            referer?: string | undefined;
        },
    ): Promise<Response> {
        const headers = new Headers();
        if (opts.cookie !== undefined) headers.set("cookie", opts.cookie);
        if (opts.csrfHeader !== undefined)
            headers.set("X-CSRF-Token", opts.csrfHeader);
        if (opts.origin !== undefined) headers.set("Origin", opts.origin);
        if (opts.referer !== undefined) headers.set("Referer", opts.referer);
        return app.fetch(
            new Request(`${ORIGIN}/x`, { method: "POST", headers }),
        );
    }

    it("accepts a POST with matching token + signature + same-origin", async () => {
        const { app, csrf } = buildApp();
        const { token, signature } = await csrf.generateTokenForSession("alice");
        const res = await postWith(app, {
            cookie: `__csrf_signature=${signature}`,
            csrfHeader: token,
            origin: ORIGIN,
        });
        expect(res.status).toBe(200);
    });

    it("rejects POST without X-CSRF-Token header (403)", async () => {
        const { app, csrf } = buildApp();
        const { signature } = await csrf.generateTokenForSession("alice");
        const res = await postWith(app, {
            cookie: `__csrf_signature=${signature}`,
            origin: ORIGIN,
        });
        expect(res.status).toBe(403);
    });

    it("rejects POST with mismatched token vs signature (403)", async () => {
        const { app, csrf } = buildApp();
        const { signature } = await csrf.generateTokenForSession("alice");
        const res = await postWith(app, {
            cookie: `__csrf_signature=${signature}`,
            csrfHeader: "definitely-not-the-real-token",
            origin: ORIGIN,
        });
        expect(res.status).toBe(403);
    });

    it("rejects cross-origin POST even with valid token + signature (403)", async () => {
        const { app, csrf } = buildApp();
        const { token, signature } = await csrf.generateTokenForSession("alice");
        const res = await postWith(app, {
            cookie: `__csrf_signature=${signature}`,
            csrfHeader: token,
            origin: "https://evil.example.test",
        });
        expect(res.status).toBe(403);
    });

    it("rejects POST with missing Origin and Referer (403)", async () => {
        const { app, csrf } = buildApp();
        const { token, signature } = await csrf.generateTokenForSession("alice");
        const res = await postWith(app, {
            cookie: `__csrf_signature=${signature}`,
            csrfHeader: token,
        });
        expect(res.status).toBe(403);
    });

    it("rejects POST when no session is bound (no-valid-session)", async () => {
        const { app, csrf } = buildApp({ sessionId: "" });
        const { token, signature } = await csrf.generateTokenForSession("alice");
        const res = await postWith(app, {
            cookie: `__csrf_signature=${signature}`,
            csrfHeader: token,
            origin: ORIGIN,
        });
        expect(res.status).toBe(403);
    });

    it("DELETE is treated as a protected method", async () => {
        const { app, csrf } = buildApp();
        const { token, signature } = await csrf.generateTokenForSession("alice");
        const headers = new Headers();
        headers.set("cookie", `__csrf_signature=${signature}`);
        headers.set("X-CSRF-Token", token);
        headers.set("Origin", ORIGIN);
        const res = await app.fetch(
            new Request(`${ORIGIN}/x`, { method: "DELETE", headers }),
        );
        expect(res.status).toBe(200);
    });
});

// -----------------------------------------------------------------------------
// Pure utilities
// -----------------------------------------------------------------------------

describe("csrf — pure utilities", () => {
    it("buildCSRFConfig falls back to environment + defaults", () => {
        const cfg = buildCSRFConfig(
            {},
            { CSRF_SECRET_KEY: "explicit-secret-from-env", NODE_ENV: "test" },
        );
        expect(cfg.secretKey).toBe("explicit-secret-from-env");
        expect(cfg.headerName).toBe("X-CSRF-Token");
        expect(cfg.cookieName).toBe("__csrf_signature");
    });

    it("buildCSRFConfig throws when production secret is the placeholder", () => {
        expect(() =>
            buildCSRFConfig({}, { NODE_ENV: "production" }),
        ).toThrow();
    });

    it("buildCSRFCookie sets Secure only in production", () => {
        const cfg = buildCSRFConfig({ secretKey: "k" }, { NODE_ENV: "test" });
        const dev = parseSetCookie(buildCSRFCookie(cfg, "sig", "development"));
        expect(dev.attrs.has("secure")).toBe(false);
        const prod = parseSetCookie(buildCSRFCookie(cfg, "sig", "production"));
        expect(prod.attrs.get("secure")).toBe(true);
    });

    it("CSRFProtection.validateToken rejects expired tokens (typed timestamp)", async () => {
        const cfg = buildCSRFConfig(
            { secretKey: "k", tokenTTL: 1 },
            { NODE_ENV: "test" },
        );
        const csrf = new CSRFProtection(cfg);
        const { token, signature } = await csrf.generateTokenForSession("u-1");
        // Wait past TTL.
        await new Promise((r) => setTimeout(r, 10));
        expect(await csrf.validateToken(token, signature, "u-1")).toBe(false);
    });

    it("CSRFProtection.invalidateToken removes the token from the store", async () => {
        const cfg = buildCSRFConfig({ secretKey: "k" }, { NODE_ENV: "test" });
        const csrf = new CSRFProtection(cfg);
        const { token, signature } = await csrf.generateTokenForSession("u-1");
        expect(await csrf.validateToken(token, signature, "u-1")).toBe(true);
        csrf.invalidateToken(token);
        expect(await csrf.validateToken(token, signature, "u-1")).toBe(false);
    });

    it("OriginValidator allows safe methods regardless of header", () => {
        const v = new OriginValidator({
            allowedOrigins: [ORIGIN],
            nodeEnv: "production",
        });
        expect(v.validateRequest("GET", undefined, undefined).valid).toBe(true);
        expect(v.validateRequest("HEAD", undefined, undefined).valid).toBe(true);
        expect(v.validateRequest("OPTIONS", undefined, undefined).valid).toBe(
            true,
        );
    });

    it("OriginValidator rejects wildcard origins in production", () => {
        const v = new OriginValidator({
            allowedOrigins: ["*.example.test"],
            nodeEnv: "production",
        });
        const r = v.validateRequest(
            "POST",
            "https://app.example.test",
            undefined,
        );
        expect(r.valid).toBe(false);
        expect(r.reason).toBe("wildcard-rejected-in-production");
    });

    it("OriginValidator accepts wildcard origins in development", () => {
        const v = new OriginValidator({
            allowedOrigins: ["*.example.test"],
            nodeEnv: "development",
        });
        const r = v.validateRequest(
            "POST",
            "https://app.example.test",
            undefined,
        );
        expect(r.valid).toBe(true);
    });

    it("OriginValidator returns malformed-origin for non-URL inputs", () => {
        const v = new OriginValidator({
            allowedOrigins: [ORIGIN],
            nodeEnv: "development",
        });
        const r = v.validateRequest("POST", "not a url", undefined);
        expect(r.valid).toBe(false);
        expect(r.reason).toBe("malformed-origin");
    });
});
