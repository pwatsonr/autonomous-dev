// BUG-8 regression test — CSRF token rendered as empty string in every form.
// Either wire the middleware correctly or remove the field.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("BUG-8 regression test — CSRF token properly rendered", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    });

    test("settings page has non-empty CSRF tokens", async () => {
        const app = freshApp();

        const res = await app.request("/settings");
        expect(res.status).toBe(200);

        const html = await res.text();

        // Find all CSRF token inputs
        const csrfMatches = html.match(/name="_csrf"\s+value="([^"]*)"/g);

        if (csrfMatches && csrfMatches.length > 0) {
            // If CSRF fields exist, they should have non-empty values
            for (const match of csrfMatches) {
                const valueMatch = match.match(/value="([^"]*)"/);
                if (valueMatch) {
                    const value = valueMatch[1];
                    expect(value.length).toBeGreaterThan(16);
                }
            }
        }
        // If no CSRF fields exist, that's also acceptable (CSRF disabled)
        // The bug is specifically about empty values, not missing fields
    });

    test("forms with CSRF fields have proper token values", async () => {
        const app = freshApp();

        const res = await app.request("/settings");
        expect(res.status).toBe(200);

        const html = await res.text();

        // Check that if _csrf inputs exist, they have proper length values
        const emptyTokenMatches = html.match(/name="_csrf"\s+value=""/g);

        // No CSRF fields should have empty values
        expect(emptyTokenMatches).toBeNull();
    });
});