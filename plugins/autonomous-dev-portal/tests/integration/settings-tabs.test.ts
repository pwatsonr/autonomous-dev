// SPEC-036-4-01 — Integration tests for `GET /settings?tab=<id>` deep-link.
//
// Verifies:
//   - All five canonical tabs round-trip and the matching panel renders
//     without `hidden` while the other four carry it.
//   - Invalid / missing values default to `general`.
//   - Server never echoes raw query input in the `data-active-tab`
//     attribute (security regression guard for AC-06).

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { registerRoutes } from "../../server/routes";
import { TAB_IDS } from "../../server/types/render";

function freshApp(): Hono {
    const app = new Hono();
    registerRoutes(app);
    return app;
}

async function fetchSettingsHtml(path: string): Promise<string> {
    const app = freshApp();
    const res = await app.request(path);
    expect(res.status).toBe(200);
    return await res.text();
}

function panelIsHidden(html: string, tabId: string): boolean {
    // Match the opening tag of the panel, then check whether the
    // `hidden` attribute is present before the close.
    const re = new RegExp(
        `<section[^>]*data-tab-panel="${tabId}"[^>]*>`,
        "i",
    );
    const m = html.match(re);
    if (!m) throw new Error(`panel for ${tabId} not found`);
    return / hidden(?=[ />])/i.test(m[0]) || /\shidden=""/i.test(m[0]);
}

describe("GET /settings?tab=<id>", () => {
    for (const id of TAB_IDS) {
        test(`?tab=${id} — that panel visible, others hidden`, async () => {
            const html = await fetchSettingsHtml(`/settings?tab=${id}`);
            expect(html).toContain(`data-active-tab="${id}"`);
            expect(panelIsHidden(html, id)).toBe(false);
            for (const other of TAB_IDS) {
                if (other === id) continue;
                expect(panelIsHidden(html, other)).toBe(true);
            }
        });
    }

    test("missing query defaults to 'general'", async () => {
        const html = await fetchSettingsHtml("/settings");
        expect(html).toContain('data-active-tab="general"');
        expect(panelIsHidden(html, "general")).toBe(false);
    });

    test("invalid tab defaults to 'general'", async () => {
        const html = await fetchSettingsHtml("/settings?tab=invalid");
        expect(html).toContain('data-active-tab="general"');
    });

    test("traversal-like value never echoed in data-active-tab (AC-06)", async () => {
        const html = await fetchSettingsHtml(
            "/settings?tab=" + encodeURIComponent("../etc/passwd"),
        );
        expect(html).toContain('data-active-tab="general"');
        expect(html).not.toContain("../etc/passwd");
    });

    test("renders three module scripts (settings-tabs, form-validation, settings-modals)", async () => {
        const html = await fetchSettingsHtml("/settings");
        expect(html).toContain('src="/static/js/settings-tabs.js"');
        expect(html).toContain('src="/static/js/form-validation.js"');
        expect(html).toContain('src="/static/js/settings-modals.js"');
    });
});
