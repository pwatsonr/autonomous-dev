// SPEC-014-2-01 §Acceptance Criteria — CSRF protection smoke suite.
//
// The full attack matrix lives in tests/security/csrf-attack-tests.spec.ts
// (SPEC-014-2-05). These cases pin the headline acceptance criteria so
// regressions surface in the unit suite before the slower security suite
// runs.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
    CSRFProtection,
    OriginValidator,
    buildCSRFConfig,
    buildCSRFCookie,
    csrfMiddleware,
    csrfTokenIssuer,
} from "../../server/security/csrf-protection";
import { SecurityError } from "../../server/security/types";
import {
    randomToken,
    timingSafeCompare,
} from "../../server/security/crypto-utils";

describe("buildCSRFConfig", () => {
    test("rejects placeholder secret in production", () => {
        let caught: unknown = null;
        try {
            buildCSRFConfig(
                {},
                { NODE_ENV: "production" } as NodeJS.ProcessEnv,
            );
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(SecurityError);
        expect((caught as SecurityError).code).toBe(
            "CSRF_SECRET_NOT_CONFIGURED",
        );
    });

    test("accepts placeholder in non-production", () => {
        const cfg = buildCSRFConfig({}, { NODE_ENV: "test" } as NodeJS.ProcessEnv);
        expect(cfg.secretKey).toBe("change-me-in-production");
    });

    test("excludes documented public paths by default", () => {
        const cfg = buildCSRFConfig(
            {},
            { NODE_ENV: "development" } as NodeJS.ProcessEnv,
        );
        expect(cfg.excludePaths).toContain("/csp-violation-report");
        expect(cfg.excludePaths).toContain("/health");
    });
});

describe("CSRFProtection token lifecycle", () => {
    function build() {
        return new CSRFProtection(
            buildCSRFConfig(
                { secretKey: "test-secret" },
                { NODE_ENV: "test" } as NodeJS.ProcessEnv,
            ),
        );
    }

    test("generates 64-char hex tokens and matching HMAC signature", async () => {
        const csrf = build();
        const { token, signature } = await csrf.generateTokenForSession("s1");
        expect(token).toMatch(/^[0-9a-f]{64}$/);
        expect(signature).toMatch(/^[0-9a-f]{64}$/);
    });

    test("validates a freshly issued token", async () => {
        const csrf = build();
        const { token, signature } = await csrf.generateTokenForSession("s1");
        expect(await csrf.validateToken(token, signature, "s1")).toBe(true);
    });

    test("rejects unknown token", async () => {
        const csrf = build();
        const fakeToken = randomToken(32);
        expect(await csrf.validateToken(fakeToken, "0".repeat(64), "s1")).toBe(
            false,
        );
    });

    test("rejects mismatched session", async () => {
        const csrf = build();
        const { token, signature } = await csrf.generateTokenForSession("s1");
        expect(await csrf.validateToken(token, signature, "s2")).toBe(false);
    });

    test("rejects modified signature without throwing", async () => {
        const csrf = build();
        const { token, signature } = await csrf.generateTokenForSession("s1");
        const tampered = "0" + signature.slice(1);
        expect(await csrf.validateToken(token, tampered, "s1")).toBe(false);
    });

    test("rejects mismatched-length signature without throwing", async () => {
        const csrf = build();
        const { token } = await csrf.generateTokenForSession("s1");
        expect(await csrf.validateToken(token, "abcd", "s1")).toBe(false);
    });

    test("invalidateToken removes the token", async () => {
        const csrf = build();
        const { token, signature } = await csrf.generateTokenForSession("s1");
        csrf.invalidateToken(token);
        expect(await csrf.validateToken(token, signature, "s1")).toBe(false);
    });

    test("LRU evicts oldest 10% beyond maxTokensInMemory", async () => {
        const csrf = new CSRFProtection(
            buildCSRFConfig(
                { secretKey: "x", maxTokensInMemory: 10 },
                { NODE_ENV: "test" } as NodeJS.ProcessEnv,
            ),
        );
        for (let i = 0; i < 11; i += 1) {
            await csrf.generateTokenForSession(`s${String(i)}`);
        }
        expect(csrf.storeSize).toBeLessThan(11);
    });
});

describe("OriginValidator", () => {
    test("safe methods always pass", () => {
        const v = new OriginValidator({
            allowedOrigins: ["http://localhost:3000"],
            nodeEnv: "production",
        });
        expect(v.validateRequest("GET", undefined, undefined).valid).toBe(true);
    });

    test("missing both Origin and Referer on POST is rejected", () => {
        const v = new OriginValidator({
            allowedOrigins: ["http://localhost:3000"],
            nodeEnv: "test",
        });
        const r = v.validateRequest("POST", undefined, undefined);
        expect(r.valid).toBe(false);
        expect(r.reason).toBe("missing-origin-and-referer");
    });

    test("malformed Origin rejected", () => {
        const v = new OriginValidator({
            allowedOrigins: ["http://localhost:3000"],
            nodeEnv: "test",
        });
        const r = v.validateRequest("POST", "not-a-url", undefined);
        expect(r.valid).toBe(false);
        expect(r.reason).toBe("malformed-origin");
    });

    test("Referer fallback when Origin absent", () => {
        const v = new OriginValidator({
            allowedOrigins: ["http://localhost:3000"],
            nodeEnv: "test",
        });
        const r = v.validateRequest(
            "POST",
            undefined,
            "http://localhost:3000/page",
        );
        expect(r.valid).toBe(true);
    });

    test("wildcard rejected in production", () => {
        const v = new OriginValidator({
            allowedOrigins: ["*.example.com"],
            nodeEnv: "production",
        });
        const r = v.validateRequest("POST", "https://app.example.com", undefined);
        expect(r.valid).toBe(false);
        expect(r.reason).toBe("wildcard-rejected-in-production");
    });

    test("wildcard accepted in development", () => {
        const v = new OriginValidator({
            allowedOrigins: ["*.example.com"],
            nodeEnv: "development",
        });
        const r = v.validateRequest("POST", "https://app.example.com", undefined);
        expect(r.valid).toBe(true);
    });

    test("non-allowed origin rejected", () => {
        const v = new OriginValidator({
            allowedOrigins: ["http://localhost:3000"],
            nodeEnv: "production",
        });
        const r = v.validateRequest("POST", "https://evil.example", undefined);
        expect(r.valid).toBe(false);
        expect(r.reason).toBe("origin-not-allowed");
    });
});

describe("timingSafeCompare", () => {
    test("equal hex strings compare true", () => {
        expect(timingSafeCompare("abcd", "abcd")).toBe(true);
    });
    test("unequal strings compare false", () => {
        expect(timingSafeCompare("abcd", "abce")).toBe(false);
    });
    test("differing lengths compare false (no throw)", () => {
        expect(timingSafeCompare("abcd", "abcdef")).toBe(false);
    });
    test("invalid hex rejects gracefully", () => {
        expect(timingSafeCompare("zz", "zz")).toBe(false);
    });
});

describe("buildCSRFCookie", () => {
    test("includes HttpOnly, SameSite=Strict, Path=/", () => {
        const cfg = buildCSRFConfig(
            { secretKey: "x" },
            { NODE_ENV: "test" } as NodeJS.ProcessEnv,
        );
        const cookie = buildCSRFCookie(cfg, "deadbeef", "production");
        expect(cookie).toContain("__csrf_signature=deadbeef");
        expect(cookie).toContain("HttpOnly");
        expect(cookie).toContain("SameSite=Strict");
        expect(cookie).toContain("Path=/");
        expect(cookie).toContain("Secure");
        expect(cookie).toContain("Max-Age=86400");
    });

    test("omits Secure outside production", () => {
        const cfg = buildCSRFConfig(
            { secretKey: "x" },
            { NODE_ENV: "test" } as NodeJS.ProcessEnv,
        );
        const cookie = buildCSRFCookie(cfg, "deadbeef", "development");
        expect(cookie).not.toContain("Secure");
    });
});

describe("csrfMiddleware on Hono app", () => {
    function buildApp(opts: { sessionId?: string } = {}) {
        const app = new Hono();
        const config = buildCSRFConfig(
            { secretKey: "test-secret" },
            { NODE_ENV: "test" } as NodeJS.ProcessEnv,
        );
        const csrf = new CSRFProtection(config);
        const origin = new OriginValidator({
            allowedOrigins: ["http://localhost:3000"],
            nodeEnv: "test",
        });
        const deps = {
            csrf,
            origin,
            config,
            getSessionId: () => opts.sessionId ?? "session-1",
        };
        app.use("*", csrfMiddleware(deps));
        app.get("/page", (c) => c.text("ok"));
        app.post("/protected", (c) => c.text("ok"));
        return { app, csrf };
    }

    test("GET passes without token", async () => {
        const { app } = buildApp();
        const r = await app.request("/page");
        expect(r.status).toBe(200);
    });

    test("POST without token returns JSON 403 for HTMX", async () => {
        const { app } = buildApp();
        const r = await app.request("/protected", {
            method: "POST",
            headers: {
                Origin: "http://localhost:3000",
                "HX-Request": "true",
            },
        });
        expect(r.status).toBe(403);
        const body = (await r.json()) as { error: string; code: string };
        expect(body.error).toBe("CSRF_TOKEN_INVALID");
        expect(body.code).toBe("SECURITY_VIOLATION");
    });

    test("POST without token returns HTML 403 for browsers", async () => {
        const { app } = buildApp();
        const r = await app.request("/protected", {
            method: "POST",
            headers: {
                Origin: "http://localhost:3000",
                Accept: "text/html",
            },
        });
        expect(r.status).toBe(403);
        expect(r.headers.get("content-type") ?? "").toContain("text/html");
        const body = await r.text();
        expect(body).toContain("Security Error");
    });

    test("POST with valid token + signature passes", async () => {
        const { app, csrf } = buildApp();
        const { token, signature } = await csrf.generateTokenForSession(
            "session-1",
        );
        const r = await app.request("/protected", {
            method: "POST",
            headers: {
                Origin: "http://localhost:3000",
                "X-CSRF-Token": token,
                Cookie: `__csrf_signature=${signature}`,
            },
        });
        expect(r.status).toBe(200);
    });

    test("POST with bad Origin rejected before token check", async () => {
        const { app, csrf } = buildApp();
        const { token, signature } = await csrf.generateTokenForSession(
            "session-1",
        );
        const r = await app.request("/protected", {
            method: "POST",
            headers: {
                Origin: "https://evil.example",
                "X-CSRF-Token": token,
                Cookie: `__csrf_signature=${signature}`,
                "HX-Request": "true",
            },
        });
        expect(r.status).toBe(403);
    });

    test("excluded path /health POST passes", async () => {
        const app = new Hono();
        const config = buildCSRFConfig(
            { secretKey: "x", excludePaths: ["/health"] },
            { NODE_ENV: "test" } as NodeJS.ProcessEnv,
        );
        const csrf = new CSRFProtection(config);
        const origin = new OriginValidator({
            allowedOrigins: ["http://localhost:3000"],
            nodeEnv: "test",
        });
        app.use(
            "*",
            csrfMiddleware({
                csrf,
                origin,
                config,
                getSessionId: () => "s",
            }),
        );
        app.post("/health", (c) => c.text("ok"));
        const r = await app.request("/health", { method: "POST" });
        expect(r.status).toBe(200);
    });
});

describe("csrfTokenIssuer", () => {
    test("sets csrfToken on context and Set-Cookie on response for GET", async () => {
        const app = new Hono();
        const config = buildCSRFConfig(
            { secretKey: "x" },
            { NODE_ENV: "test" } as NodeJS.ProcessEnv,
        );
        const csrf = new CSRFProtection(config);
        const origin = new OriginValidator({
            allowedOrigins: ["*"],
            nodeEnv: "test",
        });
        app.use(
            "*",
            csrfTokenIssuer({
                csrf,
                origin,
                config,
                getSessionId: () => "session-x",
            }),
        );
        app.get("/page", (c) => c.text(c.get("csrfToken")));
        const r = await app.request("/page");
        expect(r.status).toBe(200);
        const setCookie = r.headers.get("set-cookie") ?? "";
        expect(setCookie).toContain("__csrf_signature=");
        const body = await r.text();
        expect(body).toMatch(/^[0-9a-f]{64}$/);
    });

    test("does not issue when no session", async () => {
        const app = new Hono();
        const config = buildCSRFConfig(
            { secretKey: "x" },
            { NODE_ENV: "test" } as NodeJS.ProcessEnv,
        );
        const csrf = new CSRFProtection(config);
        const origin = new OriginValidator({
            allowedOrigins: ["*"],
            nodeEnv: "test",
        });
        app.use(
            "*",
            csrfTokenIssuer({
                csrf,
                origin,
                config,
                getSessionId: () => undefined,
            }),
        );
        app.get("/page", (c) => c.text(c.get("csrfToken") ?? "none"));
        const r = await app.request("/page");
        expect(await r.text()).toBe("none");
    });
});
