// SPEC-037-1-03 — Delegated [data-action="toggle-theme"] click handler.
//
// Loads `static/theme-toggle.js` into a jsdom window with the pill markup
// pre-rendered, dispatches click events, and asserts the handler:
//   - Flips `<html data-theme>`
//   - Writes `localStorage["portal-theme"]`
//   - Writes `document.cookie` `portal-theme=<new>`
//   - Flips the inner `.tt-track` class (`light` <-> `dark`)
//   - Ignores clicks outside the toggle pill
//
// Follows the jsdom-load pattern from `tests/unit/form-validation.test.ts`.

import { describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = readFileSync(
    join(
        import.meta.dir,
        "..",
        "..",
        "static",
        "theme-toggle.js",
    ),
    "utf8",
);

const PILL_MARKUP = `
<button type="button" class="theme-toggle" aria-label="Toggle theme" data-action="toggle-theme">
  <span class="tt-track dark">
    <span class="tt-knob"></span>
    <span class="tt-l tt-light">LIGHT</span>
    <span class="tt-l tt-dark">DARK</span>
  </span>
</button>
<div id="other">other</div>
`;

/** Construct a jsdom env with the pill rendered, `<html data-theme=…>` set,
 *  and the theme-toggle.js IIFE evaluated. */
function setup(initialTheme: "light" | "dark"): JSDOM {
    const dom = new JSDOM(
        `<!doctype html><html data-theme="${initialTheme}"><body>${PILL_MARKUP}</body></html>`,
        { runScripts: "outside-only", url: "http://localhost/" },
    );
    dom.window.eval(SCRIPT);
    // jsdom keeps `document.readyState === "loading"` until the document
    // finishes parsing; the IIFE registers the click listener via
    // `DOMContentLoaded` in that case. Fire it explicitly so the handler
    // is attached for every test, mirroring what the browser does once
    // parsing completes.
    dom.window.document.dispatchEvent(
        new dom.window.Event("DOMContentLoaded", { bubbles: true }),
    );
    return dom;
}

function getTrackClassList(doc: Document): string[] {
    const track = doc.querySelector(".tt-track");
    if (!track) return [];
    return Array.from(track.classList);
}

describe("theme-toggle click handler — SPEC-037-1-03", () => {
    test("H-01: click on pill with data-theme='dark' flips to 'light'", () => {
        const dom = setup("dark");
        const doc = dom.window.document;
        const btn = doc.querySelector(
            '[data-action="toggle-theme"]',
        ) as HTMLButtonElement;
        btn.click();
        expect(doc.documentElement.dataset.theme).toBe("light");
    });

    test("H-02: after click, localStorage['portal-theme'] matches the new theme", () => {
        const dom = setup("dark");
        const doc = dom.window.document;
        const btn = doc.querySelector(
            '[data-action="toggle-theme"]',
        ) as HTMLButtonElement;
        btn.click();
        expect(dom.window.localStorage.getItem("portal-theme")).toBe("light");
    });

    test("H-03: after click, document.cookie contains portal-theme=<new>", () => {
        const dom = setup("dark");
        const doc = dom.window.document;
        const btn = doc.querySelector(
            '[data-action="toggle-theme"]',
        ) as HTMLButtonElement;
        btn.click();
        expect(doc.cookie).toContain("portal-theme=light");
    });

    test("H-04: after click, .tt-track class flips to match the new theme", () => {
        const dom = setup("dark");
        const doc = dom.window.document;
        const btn = doc.querySelector(
            '[data-action="toggle-theme"]',
        ) as HTMLButtonElement;
        btn.click();
        const classes = getTrackClassList(doc);
        expect(classes).toContain("tt-track");
        expect(classes).toContain("light");
        expect(classes).not.toContain("dark");
    });

    test("H-05: a second click flips back to the original theme", () => {
        const dom = setup("dark");
        const doc = dom.window.document;
        const btn = doc.querySelector(
            '[data-action="toggle-theme"]',
        ) as HTMLButtonElement;
        btn.click();
        btn.click();
        expect(doc.documentElement.dataset.theme).toBe("dark");
        expect(getTrackClassList(doc)).toContain("dark");
        expect(getTrackClassList(doc)).not.toContain("light");
    });

    test("H-06: clicking a non-toggle element does NOT change data-theme", () => {
        const dom = setup("dark");
        const doc = dom.window.document;
        const other = doc.getElementById("other") as HTMLDivElement;
        other.click();
        expect(doc.documentElement.dataset.theme).toBe("dark");
        expect(dom.window.localStorage.getItem("portal-theme")).toBeNull();
    });

    test("H-07: clicking a descendant of the pill (e.g. the knob) still toggles", () => {
        const dom = setup("dark");
        const doc = dom.window.document;
        // closest('[data-action="toggle-theme"]') from the knob should
        // resolve to the button, so the handler fires.
        const knob = doc.querySelector(".tt-knob") as HTMLElement;
        // Bubbling click via dispatchEvent (Element.click() doesn't bubble
        // through to the document listener consistently across jsdom builds).
        knob.dispatchEvent(
            new dom.window.MouseEvent("click", { bubbles: true }),
        );
        expect(doc.documentElement.dataset.theme).toBe("light");
    });

    test("H-08: starting from persisted 'light' flips to 'dark' and back", () => {
        // Pre-seed localStorage so the IIFE's `applyTheme(readStoredTheme())`
        // reapplies "light" on script load instead of defaulting to "dark".
        const dom = new JSDOM(
            `<!doctype html><html data-theme="light"><body>${PILL_MARKUP}</body></html>`,
            { runScripts: "outside-only", url: "http://localhost/" },
        );
        dom.window.localStorage.setItem("portal-theme", "light");
        dom.window.eval(SCRIPT);
        dom.window.document.dispatchEvent(
            new dom.window.Event("DOMContentLoaded", { bubbles: true }),
        );
        const doc = dom.window.document;
        expect(doc.documentElement.dataset.theme).toBe("light");
        const btn = doc.querySelector(
            '[data-action="toggle-theme"]',
        ) as HTMLButtonElement;
        btn.click();
        expect(doc.documentElement.dataset.theme).toBe("dark");
        btn.click();
        expect(doc.documentElement.dataset.theme).toBe("light");
    });
});
