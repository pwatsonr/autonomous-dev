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

    // PLAN-038 TASK-020 — swap the fake `/Users/op/repos/*` allowlist for
    // the real portal-settings allowlist. The allowlist lives on
    // SettingsData (data.allowlist), not SettingsView (config). Other
    // settings tabs (general / variants / standards / backends / agents)
    // remain on the stub for now; their wiring is tracked as follow-up
    // under PRD-018 NG-3702.
    const realSettings = await readPortalSettings();
    if (realSettings.allowlist.length > 0) {
        data.allowlist = realSettings.allowlist.map((entry) => ({
            id: entry.id,
            path: entry.path,
            // Real-source allowlist entries don't carry the legacy
            // `status` / `addedAt` fields. Defaults preserve the view
            // contract without lying about state.
            status: "ok" as const,
            addedAt: new Date().toISOString(),
        }));
    } else {
        data.allowlist = [];
    }

    return renderPage(c, "settings", { config, data });
};
