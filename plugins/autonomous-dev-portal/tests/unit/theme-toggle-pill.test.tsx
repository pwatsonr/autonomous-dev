// SPEC-037-1-02 §theme-toggle pill — unit tests.
//
// Renders <ShellLayout> via Hono's JSX runtime and asserts the pill markup
// is rendered inside `.rail-ops` as the final child, matching the kit's
// Shell.jsx structure (lines 59-65 of
// /tmp/portal-design-v2/.../ui_kits/portal/Shell.jsx).
//
// Acceptance criteria covered (per SPEC-037-1-02):
//   - AC-01: `<button class="theme-toggle" data-action="toggle-theme">` inside `.rail-ops`
//   - AC-02: child `<span class="tt-track {theme}">` with 3 children in order
//   - AC-03: tt-track class reflects the resolved theme ("dark" / "light")
//   - AC-04: pill is the LAST child of `.rail-ops`
//   - AC-05: no inline `style=""` or `onclick=""` attributes
//   - AC-06: `aria-label="Toggle theme"` present

import { describe, expect, test } from "bun:test";

import { ShellLayout } from "../../server/components/shell";

/** Resolve a Hono JSX node to a plain HTML string. */
async function render(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    return typeof v === "string" ? v : String(v);
}

/** Extract the substring between the first `<div class="rail-ops">` and its closing `</div>`. */
function extractRailOps(html: string): string {
    const start = html.indexOf('<div class="rail-ops">');
    expect(start).toBeGreaterThan(-1);
    // Find the matching </div> by walking nested <div> tags.
    let depth = 0;
    let i = start;
    const openTag = /<div\b/g;
    const closeTag = /<\/div>/g;
    openTag.lastIndex = start;
    closeTag.lastIndex = start;
    while (i < html.length) {
        openTag.lastIndex = i;
        closeTag.lastIndex = i;
        const o = openTag.exec(html);
        const c = closeTag.exec(html);
        if (!c) break;
        if (o && o.index < c.index) {
            depth += 1;
            i = o.index + o[0].length;
        } else {
            depth -= 1;
            i = c.index + c[0].length;
            if (depth === 0) {
                return html.slice(start, i);
            }
        }
    }
    return html.slice(start);
}

describe("ShellLayout theme-toggle pill — SPEC-037-1-02", () => {
    test("P-01: rail-ops contains a <button class='theme-toggle' data-action='toggle-theme'>", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const railOps = extractRailOps(html);
        expect(railOps).toMatch(
            /<button[^>]*\bclass="theme-toggle"[^>]*\bdata-action="toggle-theme"/,
        );
    });

    test("P-02: with default theme (dark), the pill renders <span class='tt-track dark'>", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const railOps = extractRailOps(html);
        expect(railOps).toContain('<span class="tt-track dark">');
    });

    test("P-03: with theme='light', the pill renders <span class='tt-track light'>", async () => {
        const html = await render(
            <ShellLayout activePath="/" theme="light" />,
        );
        const railOps = extractRailOps(html);
        expect(railOps).toContain('<span class="tt-track light">');
    });

    test("P-04: .tt-track has exactly three children: .tt-knob, .tt-l.tt-light, .tt-l.tt-dark in order", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const railOps = extractRailOps(html);
        // Capture the tt-track block contents.
        const trackMatch = railOps.match(
            /<span class="tt-track [^"]+">([\s\S]*?)<\/span>\s*<\/button>/,
        );
        expect(trackMatch).not.toBeNull();
        const inner = trackMatch![1];
        const knobIdx = inner.indexOf('<span class="tt-knob"');
        const lightIdx = inner.indexOf('<span class="tt-l tt-light"');
        const darkIdx = inner.indexOf('<span class="tt-l tt-dark"');
        expect(knobIdx).toBeGreaterThan(-1);
        expect(lightIdx).toBeGreaterThan(knobIdx);
        expect(darkIdx).toBeGreaterThan(lightIdx);
        // Verify there are exactly three <span> children (no extras).
        const childSpans = inner.match(/<span\b/g) ?? [];
        expect(childSpans.length).toBe(3);
        // Verify labels.
        expect(inner).toContain(">LIGHT<");
        expect(inner).toContain(">DARK<");
    });

    test("P-05: the .theme-toggle button is the LAST child of .rail-ops", async () => {
        const html = await render(
            <ShellLayout activePath="/" mtdSpend={123.45} />,
        );
        const railOps = extractRailOps(html);
        // Last </button> in the rail-ops segment should be the theme-toggle.
        const lastButtonOpen = railOps.lastIndexOf("<button");
        const themeToggleOpen = railOps.indexOf(
            '<button type="button" class="theme-toggle"',
        );
        expect(themeToggleOpen).toBeGreaterThan(-1);
        expect(lastButtonOpen).toBe(themeToggleOpen);
        // SPEC-037-3-04 rewrote `.rail-ops` to a 3-line metrics block —
        // the MTD row now renders via `RailOpsRow` (a `<div class="line">`
        // with the literal "MTD spend" label) rather than the old
        // `.rail-ops-mtd` div. Verify the row exists before the toggle.
        const mtdIdx = railOps.indexOf("MTD spend");
        expect(mtdIdx).toBeGreaterThan(-1);
        expect(mtdIdx).toBeLessThan(themeToggleOpen);
    });

    test("P-06: pill carries aria-label='Toggle theme' and no inline onclick/style", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const railOps = extractRailOps(html);
        const buttonMatch = railOps.match(
            /<button[^>]*class="theme-toggle"[^>]*>/,
        );
        expect(buttonMatch).not.toBeNull();
        const buttonTag = buttonMatch![0];
        expect(buttonTag).toContain('aria-label="Toggle theme"');
        expect(buttonTag).not.toMatch(/\bonclick=/i);
        expect(buttonTag).not.toMatch(/\bstyle=/i);
        // type="button" is required so form submissions never trigger it.
        expect(buttonTag).toContain('type="button"');
    });

    test("P-07: pill is rendered AFTER the kill-switch kbtn", async () => {
        const html = await render(<ShellLayout activePath="/" />);
        const railOps = extractRailOps(html);
        const kbtnIdx = railOps.indexOf('class="kbtn');
        const toggleIdx = railOps.indexOf('class="theme-toggle"');
        expect(kbtnIdx).toBeGreaterThan(-1);
        expect(toggleIdx).toBeGreaterThan(kbtnIdx);
    });
});
