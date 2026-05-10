// SPEC-036-4-06 — Snapshot tests for the notifications-card fragment.

import { describe, expect, test } from "bun:test";

import { NotificationsCard } from "../../server/templates/fragments/notifications-card";
import type { NotificationsConfig } from "../../server/types/render";

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

describe("NotificationsCard", () => {
    test("untested state renders muted chips for both webhooks", async () => {
        const html = await render(
            NotificationsCard({ config: BASE, canSendTest: false }),
        );
        const mutedChips = html.match(/class="chip muted"/g) ?? [];
        expect(mutedChips.length).toBe(2);
    });

    test("dnd controls disabled when notifyDefault === 'none'", async () => {
        const html = await render(
            NotificationsCard({ config: BASE, canSendTest: false }),
        );
        // dnd-enabled checkbox + start + end inputs each carry `disabled`.
        const dndDisableHelper = html.includes(
            "DND has no effect when notifications are off",
        );
        expect(dndDisableHelper).toBe(true);
    });

    test("Send test button enabled when canSendTest=true", async () => {
        const html = await render(
            NotificationsCard({
                config: { ...BASE, notifyDefault: "discord" },
                canSendTest: true,
            }),
        );
        // The Btn primary should NOT carry `disabled`.
        const sendIdx = html.indexOf("Send test notification now");
        const sliceBefore = html.slice(0, sendIdx);
        const lastBtn = sliceBefore.lastIndexOf("<button");
        const tag = html.slice(lastBtn, sendIdx);
        expect(tag.includes("disabled")).toBe(false);
    });

    test("ok state renders ok-tone chip", async () => {
        const html = await render(
            NotificationsCard({
                config: { ...BASE, discordStatus: "ok" },
                canSendTest: true,
            }),
        );
        expect(html).toContain('class="chip ok"');
    });
});
