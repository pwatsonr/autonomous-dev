// BUG-6 regression test — Notification Test buttons all 502 because
// dispatcher reads notifications.discordWebhook (flat) but config has
// notifications.delivery.discord.webhook_url (nested daemon shape).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { registerRoutes } from "../../server/routes";
import { kitParityFixtureRoot } from "../../server/wiring/state-paths";
import { FileSettingsStore } from "../../server/wiring/settings-store";
import { buildFileWebhookDispatcher } from "../../server/wiring/notification-dispatcher";
import type { AuditAppender } from "../../server/routes/_action-deps";

function freshApp(mockFetch?: typeof fetch): Hono {
    const app = new Hono();

    // Wire up settings actions dependencies with test config path
    const testConfigPath = join(kitParityFixtureRoot(), "autonomous-dev.json");
    const settingsStore = new FileSettingsStore(testConfigPath);
    const notificationDispatcher = buildFileWebhookDispatcher(mockFetch || fetch, testConfigPath);

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

describe("BUG-6 regression test — notification test buttons work", () => {
    beforeAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = kitParityFixtureRoot();
    });

    afterAll(() => {
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = ORIGINAL_STATE_DIR;
    });

    test("discord test button returns 200 when webhook URL configured", async () => {
        // Mock fetch to avoid actual HTTP requests
        const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
            console.debug("Mock fetch called with URL:", url.toString());
            console.debug("Mock fetch called with method:", init?.method || "GET");
            return new Response("", { status: 200 });
        };

        const app = freshApp(mockFetch);

        // Set up config with Discord webhook in daemon shape
        const configPath = join(kitParityFixtureRoot(), "autonomous-dev.json");
        const config = {
            notifications: {
                delivery: {
                    discord: {
                        webhook_url: "https://discord.com/api/webhooks/test"
                    }
                }
            }
        };
        await writeFile(configPath, JSON.stringify(config, null, 2));

        const res = await app.request("/api/settings/notifications/test/discord", {
            method: "POST"
        });

        if (res.status !== 200) {
            console.error("Discord test failed with status:", res.status);
            console.error("Response body:", await res.text());
        }
        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toMatchObject({
            sent: true,
            channel: "discord"
        });
    });

    test("slack test button returns 200 when webhook URL configured", async () => {
        // Mock fetch to avoid actual HTTP requests
        const mockFetch = async (url: string | URL | Request, init?: RequestInit) => {
            return new Response("", { status: 200 });
        };

        const app = freshApp(mockFetch);

        // Set up config with Slack webhook in daemon shape
        const configPath = join(kitParityFixtureRoot(), "autonomous-dev.json");
        const config = {
            notifications: {
                delivery: {
                    slack: {
                        webhook_url: "https://hooks.slack.com/test"
                    }
                }
            }
        };
        await writeFile(configPath, JSON.stringify(config, null, 2));

        const res = await app.request("/api/settings/notifications/test/slack", {
            method: "POST"
        });

        expect(res.status).toBe(200);
        const json = await res.json();
        expect(json).toMatchObject({
            sent: true,
            channel: "slack"
        });
    });

    test("test returns error when webhook not configured", async () => {
        const app = freshApp();

        // Set up config without webhook
        const configPath = join(kitParityFixtureRoot(), "autonomous-dev.json");
        const config = {};
        await writeFile(configPath, JSON.stringify(config, null, 2));

        const res = await app.request("/api/settings/notifications/test/discord", {
            method: "POST"
        });

        expect(res.status).toBe(502);
        const json = await res.json();
        expect(json).toMatchObject({
            error: "notification-failed",
            channel: "discord"
        });
    });
});