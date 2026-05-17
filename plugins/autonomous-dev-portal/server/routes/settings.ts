// SPEC-013-3-01 §Route Table — settings (`GET /settings`).
// SPEC-036-4-01 — extends the route handler to read `?tab=<id>` and
// resolve it against the canonical `TAB_IDS` list. Invalid or missing
// values fall back to `'general'`. The server is the source of truth
// for the *initial* tab; `static/js/settings-tabs.js` owns transitions.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { loadSettingsData, loadSettingsStub } from "../stubs/settings";
import { TAB_IDS, type TabId } from "../types/render";
import { readPortalSettings } from "../wiring/settings-reader";

/**
 * SPEC-036-4-01 AC-01 / AC-06 — pure function so it can be unit-tested
 * without a Hono context. Validates the raw value (which may be `string
 * | string[] | undefined` depending on the framework) against the
 * compile-time `TAB_IDS` tuple. All rejection paths fall through to the
 * benign `'general'` default — never echoes raw input back to HTML.
 */
export function resolveActiveTab(raw: unknown): TabId {
    if (typeof raw !== "string") return "general";
    return (TAB_IDS as readonly string[]).includes(raw)
        ? (raw as TabId)
        : "general";
}

export const settingsHandler = async (c: Context): Promise<Response> => {
    const config = await loadSettingsStub();
    const data = await loadSettingsData();
    data.activeTab = resolveActiveTab(c.req.query("tab"));

    // Add CSRF token for form submissions
    data.csrfToken = (c.get("csrfToken") as string | undefined) ?? "";

    // Read real settings from daemon config file and overlay onto stub data
    const realSettings = await readPortalSettings();

    // Allowlist
    data.allowlist = realSettings.allowlist.map((entry) => ({
        id: entry.id,
        path: entry.path,
        status: "ok" as const,
        addedAt: new Date().toISOString(),
    }));

    // Trust settings
    data.trustLevel = realSettings.globalTrust as "L0" | "L1" | "L2" | "L3";
    data.trustOverrides = Object.entries(realSettings.trustOverrides).map(([repo, level]) => ({
        repo,
        level,
        source: "~/.claude/autonomous-dev.json",
        immutable: false
    }));

    // Cost caps
    data.costCaps = {
        daily: realSettings.dailyCostCap,
        perRequest: realSettings.perRequestCostCap,
        monthly: realSettings.monthlyCostCap
    };
    data.dailyCap = realSettings.dailyCostCap;

    // Notifications
    data.notifications = {
        discordWebhook: realSettings.notifications.discordWebhook,
        slackWebhook: realSettings.notifications.slackWebhook,
        discordStatus: "unknown", // Stub for now
        slackStatus: "unknown",   // Stub for now
        notifyDefault: realSettings.notifications.defaultMethod as "discord" | "slack" | "none",
        dndEnabled: realSettings.notifications.dndEnabled,
        dndStart: realSettings.notifications.dndStart,
        dndEnd: realSettings.notifications.dndEnd
    };

    return renderPage(c, "settings", { config, data });
};
