// BUG-12 regression test: Ops page "Refresh" button should be wired with HTMX
//
// Before the fix, the Refresh button on /ops had no hx-get, onclick, or other
// interactive attributes. After the fix, it should have HTMX attributes to
// trigger a manual refresh.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("BUG-12: Ops page Refresh button should be wired", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    });

    it("should render Refresh button with proper HTMX attributes", async () => {
        const app = freshApp();
        const response = await app.request("/ops");
        expect(response.status).toBe(200);

        const html = await response.text();

        // Refresh button should have HTMX attributes
        expect(html).toMatch(/hx-get="\/ops"/);
        expect(html).toMatch(/hx-target="#ops-body"/);
        expect(html).toMatch(/hx-swap="outerHTML"/);
        expect(html).toMatch(/hx-select="#ops-body"/);

        // Should still contain the button text
        expect(html).toMatch(/>Refresh</);
    });

    it("should respond to manual refresh requests", async () => {
        const app = freshApp();

        // Simulate HTMX request (manual refresh)
        const refreshResponse = await app.request("/ops", {
            headers: { "HX-Request": "true" },
        });

        expect(refreshResponse.status).toBe(200);
        const html = await refreshResponse.text();

        // Should return the ops-body content
        expect(html).toMatch(/id="ops-body"/);
    });
});