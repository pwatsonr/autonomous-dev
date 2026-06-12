// #392 regression tests — the saved webhook secret must never be rendered
// into the settings page, and the save path must preserve the saved value
// on empty submit (since the form no longer round-trips the secret) with
// an explicit Clear flow for removal.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NotificationsCard } from "../../server/templates/fragments/notifications-card";
import { maskWebhookForDisplay } from "../../server/wiring/settings-reader";
import { FileSettingsStore } from "../../server/wiring/settings-store";
import type { NotificationsConfig } from "../../server/types/render";

const SECRET = "https://discord.com/api/webhooks/1234567890/SuperSecretToken";

const BASE: NotificationsConfig = {
    discordWebhook: "",
    slackWebhook: "",
    discordStatus: "muted",
    slackStatus: "muted",
    notifyDefault: "none",
    dndEnabled: false,
    dndStart: "22:00",
    dndEnd: "07:00",
};

async function render(node: unknown): Promise<string> {
    return await Promise.resolve(node).then(String);
}

describe("maskWebhookForDisplay (#392)", () => {
    test("empty stays empty", () => {
        expect(maskWebhookForDisplay("")).toBe("");
    });

    test("masks to last 4 chars only", () => {
        const mask = maskWebhookForDisplay(SECRET);
        expect(mask).toContain("configured");
        expect(mask).toContain(SECRET.slice(-4));
        expect(mask).not.toContain("SuperSecretT"); // anything beyond last4
    });
});

describe("NotificationsCard secret handling (#392)", () => {
    test("configured webhook: secret absent, mask as placeholder, clear checkbox present", async () => {
        const html = await render(
            NotificationsCard({
                config: { ...BASE, discordWebhook: maskWebhookForDisplay(SECRET) },
                canSendTest: false,
            }),
        );
        expect(html).not.toContain(SECRET);
        expect(html).not.toContain("SuperSecretToken");
        expect(html).toContain("configured — ends");
        expect(html).toContain('name="discordWebhookClear"');
        // the input must not carry the value
        expect(html).toMatch(/id="discord-webhook"[^>]*value=""/);
    });

    test("unconfigured webhook: default placeholder, no clear checkbox", async () => {
        const html = await render(
            NotificationsCard({ config: BASE, canSendTest: false }),
        );
        expect(html).toContain("https://discord.com/api/webhooks/...");
        expect(html).not.toContain('name="discordWebhookClear"');
    });
});

describe("FileSettingsStore webhook save semantics (#392)", () => {
    let dir: string;
    let cfgPath: string;
    let stateDir: string;
    let prevState: string | undefined;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "wh392-"));
        cfgPath = join(dir, "autonomous-dev.json");
        stateDir = join(dir, "state");
        writeFileSync(cfgPath, JSON.stringify({
            notifications: { delivery: { discord: { webhook_url: SECRET } } },
            repositories: { allowlist: ["/repo/a"] },
        }));
        prevState = process.env["AUTONOMOUS_DEV_STATE_DIR"];
        process.env["AUTONOMOUS_DEV_STATE_DIR"] = stateDir;
    });

    afterEach(() => {
        if (prevState === undefined) delete process.env["AUTONOMOUS_DEV_STATE_DIR"];
        else process.env["AUTONOMOUS_DEV_STATE_DIR"] = prevState;
        rmSync(dir, { recursive: true, force: true });
    });

    function lastMarkerProposed(): any {
        const mdir = join(stateDir, "config-changes");
        const files = readdirSync(mdir).filter((f) => f.endsWith(".json"));
        expect(files.length).toBeGreaterThan(0);
        const marker = JSON.parse(readFileSync(join(mdir, files[files.length - 1]!), "utf-8"));
        return marker.proposed;
    }

    test("empty submit preserves the saved webhook", async () => {
        const store = new FileSettingsStore(cfgPath);
        const res = await store.saveFromForm({ discordWebhook: "" }, "test");
        expect(res.ok).toBe(true);
        expect(lastMarkerProposed().notifications.delivery.discord.webhook_url).toBe(SECRET);
    });

    test("non-empty submit replaces the webhook", async () => {
        const store = new FileSettingsStore(cfgPath);
        const NEW = "https://discord.com/api/webhooks/999/NewToken";
        const res = await store.saveFromForm({ discordWebhook: NEW }, "test");
        expect(res.ok).toBe(true);
        expect(lastMarkerProposed().notifications.delivery.discord.webhook_url).toBe(NEW);
    });

    test("clear checkbox removes the webhook", async () => {
        const store = new FileSettingsStore(cfgPath);
        const res = await store.saveFromForm(
            { discordWebhook: "", discordWebhookClear: "1" },
            "test",
        );
        expect(res.ok).toBe(true);
        expect(lastMarkerProposed().notifications.delivery.discord.webhook_url).toBe("");
    });

    test("unrelated keys survive in the proposed config", async () => {
        const store = new FileSettingsStore(cfgPath);
        await store.saveFromForm({ discordWebhook: "" }, "test");
        expect(lastMarkerProposed().repositories.allowlist).toEqual(["/repo/a"]);
    });
});
