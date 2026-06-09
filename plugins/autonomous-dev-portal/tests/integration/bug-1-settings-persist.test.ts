// BUG-1 regression test — Settings reader and writer use different files
// with different shapes. Writer saves to ~/.claude/autonomous-dev.json but
// reader reads ~/.autonomous-dev/portal-settings.json with totally different
// shape. UI says "SAVED" but reload reads from a file no one wrote.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";
import { FileSettingsStore } from "../../server/wiring/settings-store";
import { buildFileWebhookDispatcher } from "../../server/wiring/notification-dispatcher";
import type { AuditAppender } from "../../server/routes/_action-deps";

// Each test gets a fresh ephemeral config file so writes from one test
// can't leak into another, and the committed fixture is never mutated.
let TEST_CONFIG_DIR: string;
let TEST_CONFIG_PATH: string;

function freshApp(): Hono {
    const app = new Hono();

    // Wire up settings actions dependencies with the per-test temp config.
    const settingsStore = new FileSettingsStore(TEST_CONFIG_PATH);
    const notificationDispatcher = buildFileWebhookDispatcher(fetch, TEST_CONFIG_PATH);

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
const ORIGINAL_USER_CONFIG = process.env["AUTONOMOUS_DEV_USER_CONFIG"];

describe("BUG-1 regression test — settings persist properly", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });

    beforeEach(() => {
        // Per-test temp directory so the GET /settings reader sees the
        // same file the POST writer wrote.
        TEST_CONFIG_DIR = mkdtempSync(join(tmpdir(), "bug1-settings-"));
        TEST_CONFIG_PATH = join(TEST_CONFIG_DIR, "autonomous-dev.json");
        writeFileSync(TEST_CONFIG_PATH, "{}", "utf-8");
        // The route handler (server/routes/settings.ts) calls
        // `readPortalSettings()` with no override; it resolves
        // `userConfigPath()` which honors AUTONOMOUS_DEV_USER_CONFIG.
        process.env["AUTONOMOUS_DEV_USER_CONFIG"] = TEST_CONFIG_PATH;
        // #353: the writer now emits a config-change MARKER under
        // ${AUTONOMOUS_DEV_STATE_DIR}/config-changes instead of writing the
        // config directly. Point the state dir at this test's temp dir so
        // markers don't land in the committed kit-parity fixture.
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = TEST_CONFIG_DIR;
    });

    // Simulate the daemon's consume_config_changes(): apply any pending
    // portal config-change markers to the config file the reader reads. This
    // lets the regression tests still assert end-to-end persistence through
    // the new marker indirection (the daemon's real apply is covered by
    // consume_config_changes.bats).
    function applyPendingMarkers(): void {
        const ccDir = join(TEST_CONFIG_DIR, "config-changes");
        let files: string[];
        try {
            files = readdirSync(ccDir).filter((f) => f.endsWith(".json"));
        } catch {
            return;
        }
        for (const f of files.sort()) {
            const marker = JSON.parse(readFileSync(join(ccDir, f), "utf-8"));
            if (
                marker.source === "portal" &&
                marker.proposed &&
                typeof marker.proposed === "object"
            ) {
                writeFileSync(TEST_CONFIG_PATH, JSON.stringify(marker.proposed), "utf-8");
            }
        }
    }

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
        if (ORIGINAL_USER_CONFIG === undefined) {
            delete process.env["AUTONOMOUS_DEV_USER_CONFIG"];
        } else {
            process.env["AUTONOMOUS_DEV_USER_CONFIG"] = ORIGINAL_USER_CONFIG;
        }
        try {
            rmSync(TEST_CONFIG_DIR, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
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
        applyPendingMarkers();
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
        applyPendingMarkers();
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
        applyPendingMarkers();
        const loadRes = await app.request("/settings");
        expect(loadRes.status).toBe(200);
        const loadHtml = await loadRes.text();

        expect(loadHtml).toMatch(/name="discordWebhook"[^>]*value="https:\/\/discord\.com\/api\/webhooks\/test"/);
        expect(loadHtml).toMatch(/name="dndEnabled"[^>]*checked/);
        expect(loadHtml).toMatch(/name="dndStart"[^>]*value="22:00"/);
        expect(loadHtml).toMatch(/name="dndEnd"[^>]*value="08:00"/);
    });
});