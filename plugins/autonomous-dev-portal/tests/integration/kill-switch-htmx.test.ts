// BUG-18 regression test — KillSwitch Confirm form uses HTMX swap.
//
// This test verifies that the armed kill-switch form includes the HTMX
// attributes necessary for proper panel swapping rather than full page
// navigation. The bug was that the Confirm form had method="POST" action="..."
// but no hx-post, causing a full page reload that showed an orphan fragment.

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { buildKillSwitchRoutes } from "../../server/routes/kill-switch";

// Minimal CSRF simulation for this regression test
function simulateCsrfChain(): import("hono").MiddlewareHandler {
    return async (c, next) => {
        const setLoose = c.set as (k: string, v: unknown) => void;
        if (c.req.method === "GET") {
            setLoose("csrfToken", "test-csrf");
            return next();
        }
        return next();
    };
}

function buildTestApp(): Hono {
    const app = new Hono();
    app.use("*", simulateCsrfChain());
    app.route("/", buildKillSwitchRoutes());
    return app;
}

describe("Kill-switch HTMX attributes (BUG-18 regression)", () => {
    test("GET /ops/kill-switch?step=arm → armed form has hx-post attributes", async () => {
        const app = buildTestApp();
        const res = await app.request("/ops/kill-switch?step=arm", {
            method: "GET",
        });

        expect(res.status).toBe(200);
        const body = await res.text();

        // Should contain armed panel
        expect(body).toContain('<div class="ks-panel armed">');

        // The Confirm form should have HTMX attributes
        expect(body).toContain('hx-post="/ops/kill-switch"');
        expect(body).toContain('hx-target="closest .ks-panel"');
        expect(body).toContain('hx-swap="outerHTML"');

        // Should still have fallback attributes for no-JS
        expect(body).toContain('method="POST"');
        expect(body).toContain('action="/ops/kill-switch"');

        // Should contain the Confirm button
        expect(body).toContain('<button class="btn destructive" type="submit">');
        expect(body).toContain('Confirm engage');
    });

    test("armed form structure is valid HTMX", async () => {
        const app = buildTestApp();
        const res = await app.request("/ops/kill-switch?step=arm", {
            method: "GET",
        });

        const body = await res.text();

        // Verify complete form structure with HTMX attributes
        const formMatch = body.match(
            /<form[^>]*hx-post="[^"]*"[^>]*hx-target="[^"]*"[^>]*hx-swap="[^"]*"[^>]*>/
        );
        expect(formMatch).not.toBeNull();

        // Confirm button should be inside the form
        expect(body).toMatch(
            /<form[^>]*hx-post[^>]*>[\s\S]*<button[^>]*type="submit"[^>]*>[\s\S]*Confirm engage[\s\S]*<\/button>[\s\S]*<\/form>/
        );
    });
});