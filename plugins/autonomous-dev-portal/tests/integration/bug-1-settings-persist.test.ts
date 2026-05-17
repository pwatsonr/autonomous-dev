// BUG-1 regression test — Settings reader and writer use different files
// with different shapes. Writer saves to ~/.claude/autonomous-dev.json but
// reader reads ~/.autonomous-dev/portal-settings.json with totally different
// shape. UI says "SAVED" but reload reads from a file no one wrote.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { join } from "node:path";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";
import { FileSettingsStore } from "../../server/wiring/settings-store";
import { buildFileWebhookDispatcher } from "../../server/wiring/notification-dispatcher";
import type { AuditAppender } from "../../server/routes/_action-deps";

function freshApp(): Hono {
    const app = new Hono();

    // Wire up settings actions dependencies with test config path
    const testConfigPath = join(kitParityFixtureRoot(), "autonomous-dev.json");
    const settingsStore = new FileSettingsStore(testConfigPath);
    const notificationDispatcher = buildFileWebhookDispatcher(fetch, testConfigPath);

    // Noop audit appender for testing
    const audit: AuditAppender = {
        async append() {
            // noop for testing
        }
    };

    registerRoutes(app, {
        settingsActions: {
            store: settingsStore,
            notifications: notificationDispatcher,
            audit: audit
        }
    });

    return app;
}

const ORIGINAL_STATE_DIR = process.env["AUTONOMOUS_DEV_STATE_DIR"];

describe("BUG-1 regression test — settings persist properly", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    });

    test("trust level changes persist after save and reload", async () => {
        const app = freshApp();

        // First save a trust level change
        const saveRes = await app.request("/settings", {
            method: "POST",
            headers: { "HX-Request": "true" },
            body: new URLSearchParams({ "trust-level": "L3" }),
        });

        if (saveRes.status !== 200) {
            console.error("Save failed with status:", saveRes.status);
            console.error("Response body:", await saveRes.text());
        }
        expect(saveRes.status).toBe(200);
        const saveHtml = await saveRes.text();
        expect(saveHtml).toContain("SAVED");

        // Then reload the settings page and check if the trust level persists
        const loadRes = await app.request("/settings");
        expect(loadRes.status).toBe(200);
        const loadHtml = await loadRes.text();

        // Should find trust-level select with L3 selected
        expect(loadHtml).toMatch(/value="L3"[^>]*selected/s);
    });

    test("cost cap changes persist after save and reload", async () => {
        const app = freshApp();

        // Save a cost cap change
        const saveRes = await app.request("/settings", {
            method: "POST",
            headers: { "HX-Request": "true" },
            body: new URLSearchParams({ "daily": "150" }),
        });

        expect(saveRes.status).toBe(200);
        const saveHtml = await saveRes.text();
        expect(saveHtml).toContain("SAVED");

        // Reload and check if the cost cap persists
        const loadRes = await app.request("/settings");
        expect(loadRes.status).toBe(200);
        const loadHtml = await loadRes.text();

        // Should find daily cost cap input with value="150"
        expect(loadHtml).toMatch(/name="daily"[^>]*value="150"/);
    });

    test("notification settings persist after save and reload", async () => {
        const app = freshApp();

        // Save notification settings
        const saveRes = await app.request("/settings", {
            method: "POST",
            headers: { "HX-Request": "true" },
            body: new URLSearchParams({
                "discordWebhook": "https://discord.com/api/webhooks/test",
                "dndEnabled": "on",
                "dndStart": "22:00",
                "dndEnd": "08:00"
            }),
        });

        expect(saveRes.status).toBe(200);
        const saveHtml = await saveRes.text();
        expect(saveHtml).toContain("SAVED");

        // Reload and check if notification settings persist
        const loadRes = await app.request("/settings");
        expect(loadRes.status).toBe(200);
        const loadHtml = await loadRes.text();

        expect(loadHtml).toMatch(/name="discordWebhook"[^>]*value="https:\/\/discord\.com\/api\/webhooks\/test"/);
        expect(loadHtml).toMatch(/name="dndEnabled"[^>]*checked/);
        expect(loadHtml).toMatch(/name="dndStart"[^>]*value="22:00"/);
        expect(loadHtml).toMatch(/name="dndEnd"[^>]*value="08:00"/);
    });
});