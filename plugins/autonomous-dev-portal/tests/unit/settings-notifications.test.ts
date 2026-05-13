// Test for FR-020-08 — notifications save functionality

import { test, expect } from "bun:test";
import { Hono } from "hono";

import { buildSettingsActionRoutes } from "../../server/routes/settings-actions";
import type { SettingsStore, SettingsFormSaveResult } from "../../server/routes/settings-actions";

class MockSettingsStore implements SettingsStore {
    constructor(private shouldFail = false, private savedForm?: Record<string, unknown>) {}

    async saveFromForm(_form: Record<string, unknown>, _actor: string): Promise<SettingsFormSaveResult> {
        if (this.shouldFail) {
            return {
                ok: false,
                fragment: {
                    toString: () => '<div class="settings-error"><span class="chip err">ERROR</span><span class="meta">mock error</span></div>'
                } as any,
                field: "test"
            };
        }

        return {
            ok: true,
            fragment: {
                toString: () => '<div class="settings-saved"><span class="chip ok">SAVED</span><span class="meta">Settings updated.</span></div>'
            } as any,
        };
    }

    async addAllowlist(_realPath: string, _actor: string): Promise<any> {
        return { ok: true };
    }
}

class MockNotificationDispatcher {
    async send() {
        return { ok: true };
    }
}

class MockAuditAppender {
    async append() {}
}

test("POST /api/settings/notifications saves webhook config", async () => {
    const store = new MockSettingsStore();
    const app = new Hono();

    app.route("/", buildSettingsActionRoutes({
        store,
        notifications: new MockNotificationDispatcher(),
        audit: new MockAuditAppender(),
    }));

    const formData = new FormData();
    formData.append("discordWebhook", "https://discord.com/api/webhooks/123/token");
    formData.append("slackWebhook", "https://hooks.slack.com/services/T00/B00/token");
    formData.append("notifyDefault", "both");
    formData.append("dndEnabled", "true");
    formData.append("dndStart", "22:00");
    formData.append("dndEnd", "07:00");

    const response = await app.request("/api/settings/notifications", {
        method: "POST",
        body: formData,
    });

    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("SAVED");
    expect(html).toContain("Settings updated");
});

test("POST /api/settings/notifications validates webhook URLs", async () => {
    const store = new MockSettingsStore();
    const app = new Hono();

    app.route("/", buildSettingsActionRoutes({
        store,
        notifications: new MockNotificationDispatcher(),
        audit: new MockAuditAppender(),
    }));

    const formData = new FormData();
    formData.append("discordWebhook", "https://malicious.com/webhook");
    formData.append("notifyDefault", "discord");

    const response = await app.request("/api/settings/notifications", {
        method: "POST",
        body: formData,
    });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Discord webhook must be from discord.com");
});

test("POST /api/settings/notifications validates default method coherence", async () => {
    const store = new MockSettingsStore();
    const app = new Hono();

    app.route("/", buildSettingsActionRoutes({
        store,
        notifications: new MockNotificationDispatcher(),
        audit: new MockAuditAppender(),
    }));

    const formData = new FormData();
    formData.append("notifyDefault", "discord");
    // No discordWebhook provided

    const response = await app.request("/api/settings/notifications", {
        method: "POST",
        body: formData,
    });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("Cannot set Discord as default without a Discord webhook");
});

test("POST /api/settings/notifications validates DND time format", async () => {
    const store = new MockSettingsStore();
    const app = new Hono();

    app.route("/", buildSettingsActionRoutes({
        store,
        notifications: new MockNotificationDispatcher(),
        audit: new MockAuditAppender(),
    }));

    const formData = new FormData();
    formData.append("dndEnabled", "true");
    formData.append("dndStart", "25:99"); // Invalid time

    const response = await app.request("/api/settings/notifications", {
        method: "POST",
        body: formData,
    });

    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain("DND start time must be in HH:MM format");
});