// BUG-7 regression test: DND inputs should not be hardcoded disabled
//
// Before the fix, DND checkbox + start/end time inputs were rendered with
// `disabled=""` unconditionally. After the fix, they should only be disabled
// when `notifyDefault === "none"`.

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

describe("BUG-7: DND inputs not hardcoded disabled", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    });

    it("should not render DND inputs as disabled when notifications are enabled", async () => {
        const app = freshApp();
        const response = await app.request("/settings");
        expect(response.status).toBe(200);

        const html = await response.text();

        // DND inputs should exist
        expect(html).toMatch(/id="dnd-enabled"/);
        expect(html).toMatch(/id="dnd-start"/);
        expect(html).toMatch(/id="dnd-end"/);

        // When notifications are enabled (not "none"), DND inputs should NOT have disabled=""
        // Check that they don't have the hardcoded disabled attribute
        const dndEnabledMatch = html.match(/<input[^>]+id="dnd-enabled"[^>]*>/);
        const dndStartMatch = html.match(/<input[^>]+id="dnd-start"[^>]*>/);
        const dndEndMatch = html.match(/<input[^>]+id="dnd-end"[^>]*>/);

        if (dndEnabledMatch && !dndEnabledMatch[0].includes('notifyDefault') || !dndEnabledMatch[0].includes('none')) {
            // If notifications are not disabled, DND inputs should not be disabled
            expect(dndEnabledMatch[0]).not.toMatch(/disabled=""/);
        }
        if (dndStartMatch) {
            expect(dndStartMatch[0]).not.toMatch(/disabled=""/);
        }
        if (dndEndMatch) {
            expect(dndEndMatch[0]).not.toMatch(/disabled=""/);
        }
    });
});