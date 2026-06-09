// SPEC-036-4-01 — Snapshot/structure tests for the SettingsTabs fragment.
//
// Renders the fragment for each of the five `activeTab` values and
// asserts:
//   - exactly one `seg-btn` carries the `active` class (FR-026-15: renamed
//     from `on` to `active` for clarity; CSS keeps .seg-btn.on as an alias),
//   - the `data-active-tab` attribute matches the prop,
//   - one button per tab id is emitted (5 total).

import { describe, expect, test } from "bun:test";

import { SettingsTabs } from "../../server/templates/fragments/settings-tabs";
import { TAB_IDS, type TabId } from "../../server/types/render";

async function render(activeTab: TabId): Promise<string> {
    const node = SettingsTabs({ activeTab }) as unknown as
        | string
        | Promise<string>;
    return await Promise.resolve(node).then(String);
}

describe("SettingsTabs fragment", () => {
    for (const id of TAB_IDS) {
        test(`activeTab="${id}" — exactly one .seg-btn.active, data-active-tab matches`, async () => {
            const html = await render(id);
            expect(html).toContain(`data-active-tab="${id}"`);
            const onMatches = html.match(/class="seg-btn active"/g) ?? [];
            expect(onMatches.length).toBe(1);
            const allBtns = html.match(/class="seg-btn[^"]*"/g) ?? [];
            expect(allBtns.length).toBe(TAB_IDS.length);
        });
    }
});
