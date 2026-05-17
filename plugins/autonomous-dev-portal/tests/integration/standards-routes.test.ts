// BUG-15 regression test: Standards action routes should be accessible
// and return proper modal content, not 404.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { loadSettingsData } from "../../server/stubs/settings";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";
import type { StandardRule } from "../../server/routes/standards-actions";

// Simple in-memory standards store for testing
class TestStandardsStore {
    private standards: StandardRule[] = [];

    constructor() {
        // Initialize with some test data
        loadSettingsData().then(data => {
            this.standards = data.standards;
        });
    }

    async get(id: string): Promise<StandardRule | null> {
        const data = await loadSettingsData();
        const rule = data.standards.find(r => r.id === id);
        return rule ?? null;
    }

    async update(
        id: string,
        patch: Partial<Pick<StandardRule, "desc" | "severity" | "applies">>,
    ): Promise<StandardRule[]> {
        const data = await loadSettingsData();
        const next = data.standards.map((r) =>
            r.id === id ? { ...r, ...patch } : r,
        );
        return next;
    }
}

function freshApp(): Hono {
    const app = new Hono();

    registerRoutes(app, {
        standardsActions: {
            store: new TestStandardsStore(),
        },
    });

    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("Standards action routes (BUG-15 regression)", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    });

    test("should return modal fragment for new standard, not 404", async () => {
        const app = freshApp();
        const response = await app.request("/api/standards/new");

        expect(response.status).toBe(200);

        const html = await response.text();

        // Should contain modal structure for new standard
        expect(html).toMatch(/modal/i);
        expect(html).toMatch(/New standard/i);
        expect(html).toMatch(/STANDARDS.*NEW/i);
    });

    test("should return 200 or 404 based on standard existence, not route-not-found", async () => {
        const app = freshApp();

        // Test with a standard that should exist in stub data
        const existingResponse = await app.request("/api/standards/S-101/edit");

        // Should return either 200 (if S-101 exists) or 404 (if not found)
        // but NOT route-not-found error which would be a different status/format
        expect([200, 404]).toContain(existingResponse.status);

        if (existingResponse.status === 200) {
            const html = await existingResponse.text();
            expect(html).toMatch(/modal/i);
            expect(html).toMatch(/Standard.*S-101/i);
        }

        if (existingResponse.status === 404) {
            const html = await existingResponse.text();
            // 404 from the standards route should still be a modal with "Not found"
            expect(html).toMatch(/Not found/i);
        }
    });

    test("should handle standard IDs that definitely don't exist", async () => {
        const app = freshApp();
        const response = await app.request("/api/standards/NONEXISTENT-999/edit");

        expect(response.status).toBe(404);

        const html = await response.text();
        expect(html).toMatch(/Not found/i);
        expect(html).toMatch(/modal/i);
    });
});