// SPEC-036-4-02 — jsdom tests for `static/js/settings-tabs.js`.
//
// Verifies the deep-link mechanism: initial visibility from
// `data-active-tab`, click + pushState, popstate restore, idempotency,
// and graceful no-op on a non-Settings page.

import { beforeEach, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(
    join(import.meta.dir, "..", "..", "static", "js", "settings-tabs.js"),
    "utf8",
);

interface SettingsTabsNs {
    showTab: (tabId: string) => void;
    init: () => void;
}

const TAB_IDS = [
    "general",
    "variants",
    "standards",
    "backends",
    "agents",
] as const;

function fixtureSettingsHtml(activeTab: string): string {
    const buttons = TAB_IDS.map(
        (id) =>
            `<button class="seg-btn${
                id === activeTab ? " on" : ""
            }" data-tab="${id}">${id}</button>`,
    ).join("");
    const panels = TAB_IDS.map(
        (id) =>
            `<section data-tab-panel="${id}"${
                id === activeTab ? "" : " hidden"
            }>${id}</section>`,
    ).join("");
    return `<!doctype html><html><body>
        <nav class="seg seg-tabs" data-active-tab="${activeTab}">
            ${buttons}
        </nav>
        ${panels}
    </body></html>`;
}

let dom: JSDOM;
let fv: SettingsTabsNs;

function setup(activeTab = "general") {
    dom = new JSDOM(fixtureSettingsHtml(activeTab), {
        runScripts: "outside-only",
        url: "http://localhost/settings",
    });
    dom.window.eval(SCRIPT);
    fv = (dom.window as unknown as { __settingsTabs: SettingsTabsNs })
        .__settingsTabs;
    // The script self-runs `init()` since readyState !== 'loading'.
    return dom.window.document;
}

function panelHidden(doc: Document, id: string): boolean {
    const el = doc.querySelector(
        `[data-tab-panel="${id}"]`,
    ) as HTMLElement | null;
    if (!el) throw new Error(`panel ${id} not found`);
    return el.hidden === true;
}

describe("settings-tabs.js — initial render", () => {
    beforeEach(() => {});

    test("data-active-tab='standards' shows standards panel", () => {
        const doc = setup("standards");
        expect(panelHidden(doc, "standards")).toBe(false);
        for (const id of TAB_IDS) {
            if (id === "standards") continue;
            expect(panelHidden(doc, id)).toBe(true);
        }
    });

    test("missing data-active-tab falls back to 'general'", () => {
        dom = new JSDOM(
            `<!doctype html><html><body>
                <nav class="seg seg-tabs">
                    <button class="seg-btn" data-tab="general">G</button>
                    <button class="seg-btn" data-tab="agents">A</button>
                </nav>
                <section data-tab-panel="general" hidden>g</section>
                <section data-tab-panel="agents" hidden>a</section>
            </body></html>`,
            { runScripts: "outside-only", url: "http://localhost/settings" },
        );
        dom.window.eval(SCRIPT);
        const doc = dom.window.document;
        expect(panelHidden(doc, "general")).toBe(false);
        expect(panelHidden(doc, "agents")).toBe(true);
    });
});

describe("settings-tabs.js — click + pushState", () => {
    test("click on .seg-btn updates panel + URL", () => {
        const doc = setup("general");
        const w = dom.window as unknown as {
            history: { pushState: (...args: unknown[]) => void };
        };
        const calls: unknown[][] = [];
        const orig = w.history.pushState;
        w.history.pushState = ((...a: unknown[]) => {
            calls.push(a);
            return orig.apply(w.history, a as Parameters<typeof orig>);
        }) as typeof w.history.pushState;

        const btn = doc.querySelector(
            '[data-tab="variants"]',
        ) as HTMLButtonElement;
        btn.click();

        expect(panelHidden(doc, "variants")).toBe(false);
        expect(panelHidden(doc, "general")).toBe(true);
        expect(calls.length).toBe(1);
        expect(String(calls[0]?.[2])).toBe("?tab=variants");
    });
});

describe("settings-tabs.js — popstate", () => {
    test("popstate event reads URL and toggles panels", () => {
        const doc = setup("general");
        const w = dom.window as unknown as {
            location: Location;
            history: { replaceState: (...args: unknown[]) => void };
            dispatchEvent: (ev: Event) => boolean;
            PopStateEvent: typeof PopStateEvent;
        };
        // jsdom doesn't allow direct location.search assignment; use
        // history.replaceState instead.
        w.history.replaceState({}, "", "?tab=agents");
        const ev = new w.PopStateEvent("popstate");
        w.dispatchEvent(ev);
        expect(panelHidden(doc, "agents")).toBe(false);
        expect(panelHidden(doc, "general")).toBe(true);
    });
});

describe("settings-tabs.js — idempotency + safety", () => {
    test("calling init() twice does not double-bind handlers", () => {
        const doc = setup("general");
        // Run init manually a second time; dataset.bound sentinel
        // should short-circuit.
        fv.init();

        const w = dom.window as unknown as {
            history: { pushState: (...args: unknown[]) => void };
        };
        const calls: unknown[][] = [];
        const orig = w.history.pushState;
        w.history.pushState = ((...a: unknown[]) => {
            calls.push(a);
            return orig.apply(w.history, a as Parameters<typeof orig>);
        }) as typeof w.history.pushState;

        const btn = doc.querySelector(
            '[data-tab="variants"]',
        ) as HTMLButtonElement;
        btn.click();
        expect(calls.length).toBe(1);
    });

    test("no nav element — script no-ops without throwing", () => {
        dom = new JSDOM(
            "<!doctype html><html><body><p>not settings</p></body></html>",
            { runScripts: "outside-only", url: "http://localhost/" },
        );
        expect(() => dom.window.eval(SCRIPT)).not.toThrow();
    });
});
