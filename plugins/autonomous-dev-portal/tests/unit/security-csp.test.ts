// PLAN-041 §Follow-ups F-041-01 — unit coverage for the strict
// report-only CSP variant and the existing per-request nonce machinery.
//
// The exhaustive directive-builder coverage lives next to the source in
// {@link ../../server/security/csp-config.ts} (pure helpers). This file
// pins the integration contract — middleware wiring, header name,
// nonce reuse — so a regression in the chain surfaces as a fast test
// failure.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
    defaultCSPConfig,
    strictReportOnlyCSPConfig,
} from "../../server/security/csp-config";
import {
    cspMiddleware,
    strictCspReportOnlyMiddleware,
} from "../../server/security/csp-middleware";

function buildApp() {
    const app = new Hono();
    const env = "test" as const;
    app.use("*", cspMiddleware(defaultCSPConfig(env)));
    app.use("*", strictCspReportOnlyMiddleware(strictReportOnlyCSPConfig(env)));
    app.get("/", (c) => c.text("ok"));
    return app;
}

describe("strictReportOnlyCSPConfig", () => {
    test("is always report-only regardless of environment", () => {
        for (const env of ["development", "production", "test"] as const) {
            expect(strictReportOnlyCSPConfig(env).reportOnly).toBe(true);
        }
    });

    test("disables `unsafe-inline` on style-src (the F-041-01 tightening)", () => {
        const cfg = strictReportOnlyCSPConfig("production");
        expect(cfg.allowUnsafeInlineStyles).toBe(false);
    });

    test("keeps nonce generation enabled (script-src 'nonce-...' must stay)", () => {
        expect(strictReportOnlyCSPConfig("production").enableNonce).toBe(true);
    });
});

describe("strictCspReportOnlyMiddleware — header emission", () => {
    test("emits Content-Security-Policy-Report-Only on a GET response", async () => {
        const app = buildApp();
        const res = await app.request("/");
        const header = res.headers.get("content-security-policy-report-only");
        expect(header).not.toBeNull();
        expect(header).toBeTruthy();
    });

    test("strict header policy contains the required directive set", async () => {
        const app = buildApp();
        const res = await app.request("/");
        const all = res.headers.get("content-security-policy-report-only") ?? "";
        // Browsers AND multiple report-only headers; bun's Headers
        // collapses repeats into a single comma-separated string. Either
        // way, the strict policy's tokens must appear somewhere.
        expect(all).toContain("default-src 'self'");
        expect(all).toContain("script-src");
        expect(all).toContain("style-src");
        expect(all).toContain("img-src 'self' data:");
        expect(all).toContain("connect-src");
        expect(all).toContain("frame-ancestors 'none'");
        expect(all).toContain("base-uri 'self'");
        expect(all).toContain("form-action 'self'");
        expect(all).toContain("object-src 'none'");
    });

    test("strict policy excludes 'unsafe-inline' from its style-src directive", async () => {
        // Drive the strict middleware in isolation so the assertion
        // doesn't have to disentangle the lenient baseline that DOES
        // still carry 'unsafe-inline' on style-src.
        const app = new Hono();
        app.use(
            "*",
            strictCspReportOnlyMiddleware(strictReportOnlyCSPConfig("test")),
        );
        app.get("/", (c) => c.text("ok"));
        const res = await app.request("/");
        const header = res.headers.get("content-security-policy-report-only") ?? "";
        // Pick the style-src directive token and assert no unsafe-inline.
        const styleSrc = header
            .split(";")
            .map((s) => s.trim())
            .find((s) => s.startsWith("style-src "));
        expect(styleSrc).toBeDefined();
        expect(styleSrc).not.toContain("'unsafe-inline'");
        // Still must allow nonce-bearing inline styles.
        expect(styleSrc).toContain("'nonce-");
    });

    test("strict nonce matches the request's cspNonce context value", async () => {
        let observedNonce = "";
        const app = new Hono();
        app.use("*", cspMiddleware(defaultCSPConfig("test")));
        app.use(
            "*",
            strictCspReportOnlyMiddleware(strictReportOnlyCSPConfig("test")),
        );
        app.get("/", (c) => {
            observedNonce = (c.get("cspNonce") as string) ?? "";
            return c.text("ok");
        });
        const res = await app.request("/");
        const header = res.headers.get("content-security-policy-report-only") ?? "";
        expect(observedNonce.length).toBeGreaterThan(0);
        // The nonce stamped into <script nonce="..."> in templates must
        // appear in the strict header — otherwise the strict policy
        // would FALSELY flag legit inline scripts as violations.
        expect(header).toContain(`'nonce-${observedNonce}'`);
    });

    test("downgrades an enforcing config to report-only (defensive guard)", async () => {
        const app = new Hono();
        // Operator misconfiguration: pass an enforcing config to the
        // strict middleware. It MUST refuse to enforce.
        const enforcing = { ...strictReportOnlyCSPConfig("test"), reportOnly: false };
        app.use("*", strictCspReportOnlyMiddleware(enforcing));
        app.get("/", (c) => c.text("ok"));
        const res = await app.request("/");
        expect(res.headers.get("content-security-policy")).toBeNull();
        expect(
            res.headers.get("content-security-policy-report-only"),
        ).not.toBeNull();
    });

    test("when run without primary CSP, generates its own nonce", async () => {
        const app = new Hono();
        app.use(
            "*",
            strictCspReportOnlyMiddleware(strictReportOnlyCSPConfig("test")),
        );
        app.get("/", (c) => c.text("ok"));
        const res = await app.request("/");
        const header = res.headers.get("content-security-policy-report-only") ?? "";
        // Defensive: even alone, the strict header must carry a nonce so
        // templates that rely on `c.get('cspNonce')` continue to work.
        expect(header).toMatch(/'nonce-[A-Za-z0-9+/=]+'/);
    });

    test("does NOT enforce — never emits Content-Security-Policy from the strict middleware", async () => {
        const app = new Hono();
        app.use(
            "*",
            strictCspReportOnlyMiddleware(strictReportOnlyCSPConfig("test")),
        );
        app.get("/", (c) => c.text("ok"));
        const res = await app.request("/");
        // Enforcing variant must remain absent — this is the F-041-01
        // report-only-first contract.
        expect(res.headers.get("content-security-policy")).toBeNull();
    });
});
