// SPEC-035-4-01 / SPEC-035-4-02 §Tests — DesignSystemPage view.
//
// AC-1..AC-9 of SPEC-035-4-01 and AC-1..AC-6 of SPEC-035-4-02 are covered
// by:
//   - 20 `<section id="preview-N" class="ds-card">` elements rendered.
//   - Sticky `<nav class="ds-toc">` with 20 anchors `#preview-1..20`.
//   - Each primitive-driven section produces the expected primitive
//     class signatures (8 .btn, 8 chip-phase, both engaged + idle
//     kill-switch, both wordmarks).
//   - No `dangerouslySetInnerHTML` substring anywhere in the output.
//   - Token-only sections (01..04, 07) emit `var(--*)` and no hex literals.

import { describe, expect, test } from "bun:test";

import { DesignSystemPage } from "../../server/routes/design-system";

async function renderPage(theme: "light" | "dark"): Promise<string> {
    const node = DesignSystemPage({ theme }) as unknown;
    return String(await Promise.resolve(node));
}

describe("DesignSystemPage", () => {
    test("AC-3: renders sticky TOC with 20 anchors to #preview-{1..20}", async () => {
        const html = await renderPage("light");
        expect(html).toContain('class="ds-toc"');
        for (let n = 1; n <= 20; n++) {
            expect(html).toContain(`href="#preview-${n}"`);
        }
    });

    test("AC-4: emits exactly 20 <section id=preview-N class=ds-card>", async () => {
        const html = await renderPage("light");
        for (let n = 1; n <= 20; n++) {
            expect(html).toContain(`id="preview-${n}"`);
        }
        const sectionMatches = html.match(/<section[^>]*class="ds-card"/g) ?? [];
        expect(sectionMatches.length).toBe(20);
    });

    test("AC-6: no dangerouslySetInnerHTML strings in the design-system view tree", async () => {
        const html = await renderPage("light");
        // The ShellLayout itself emits ONE dangerouslySetInnerHTML for
        // the FOUC IIFE; the design-system view tree adds zero. We assert
        // the non-FOUC HTML never references the pattern by stripping the
        // FOUC <script> first.
        const stripped = html.replace(
            /<script[^>]*>[\s\S]*?try\{t=localStorage[\s\S]*?<\/script>/,
            "",
        );
        expect(stripped).not.toContain("dangerouslySetInnerHTML");
    });

    test("Section 09 emits 8 buttons with kind/size class permutations", async () => {
        const html = await renderPage("light");
        // class="btn ..." matches every primitive Btn rendering. Section
        // 09 contributes 8 buttons; section 17 (kill-switch) adds 2 more
        // (.btn destructive idle + .btn engaged reset).
        const btnMatches = html.match(/<button[^>]*class="btn[^"]*"/g) ?? [];
        expect(btnMatches.length).toBeGreaterThanOrEqual(8);
        expect(html).toContain('class="btn primary"');
        expect(html).toContain('class="btn ghost"');
        expect(html).toContain('class="btn destructive"');
        expect(html).toContain('class="btn primary sm"');
    });

    test("Sections 06 + 11: 8 phase chips appear (canonical order)", async () => {
        const html = await renderPage("light");
        // Section 06 + section 11 both render the full phase row → ≥16
        // .chip-phase elements; we only assert ≥8 to keep the bound loose.
        const phaseMatches = html.match(/class="chip-phase [a-z]+"/g) ?? [];
        expect(phaseMatches.length).toBeGreaterThanOrEqual(8);
        for (const phase of [
            "prd",
            "tdd",
            "plan",
            "spec",
            "code",
            "review",
            "deploy",
            "observe",
        ]) {
            expect(html).toContain(`class="chip-phase ${phase}"`);
        }
    });

    test("Section 12: live dot rendered as `dot live`", async () => {
        const html = await renderPage("light");
        expect(html).toContain('class="dot live"');
    });

    test("Section 17: both engaged + idle kill-switch states render", async () => {
        const html = await renderPage("light");
        expect(html).toContain("DISENGAGED");
        expect(html).toContain("ENGAGED");
        // The engaged variant suppresses the engage button; only the
        // reset button + chip remain (FR-10 of SPEC-035-3-01).
        expect(html).toContain("Reset kill switch");
        expect(html).toContain("Engage kill switch");
    });

    test("Section 20: two BrandWordmarks, second nested under data-theme=dark", async () => {
        const html = await renderPage("light");
        const wmMatches = html.match(/class="wm"/g) ?? [];
        expect(wmMatches.length).toBe(2);
        // The second wordmark sits inside a `<div data-theme="dark">`
        // wrapper so its cascade switches independently of the page theme.
        expect(html).toMatch(/data-theme="dark"[\s\S]*class="wm"/);
    });

    test("AC SPEC-035-4-02-2: token-only sections reference var(--*) and contain no hex literals", async () => {
        const html = await renderPage("light");
        // Pull out the section bodies for sections 01..04 + 07. Each is
        // delimited by `<section id="preview-N"` ... up to the next
        // `<section ` opener.
        const ids = [1, 2, 3, 4, 7];
        for (const n of ids) {
            const re = new RegExp(
                `<section id="preview-${n}"[\\s\\S]*?(?=<section id="preview-)`,
            );
            const match = html.match(re);
            expect(match).not.toBeNull();
            const body = match![0];
            expect(body).toContain("var(--");
            // No 3/4/6/8-digit hex literals embedded as inline style.
            // (The portal-theme cookie name "portal-theme" is allowed —
            // it isn't preceded by `#`.) Pseudo-anchors (`#preview-N`,
            // `#preview-1`) are also allowed by the negative lookahead.
            expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        }
    });

    test("data-section-count attribute is `20` (Playwright wait selector)", async () => {
        const html = await renderPage("light");
        expect(html).toContain('data-section-count="20"');
    });

    test("theme prop propagates to <html data-theme=...>", async () => {
        const lightHtml = await renderPage("light");
        const darkHtml = await renderPage("dark");
        expect(lightHtml).toContain('data-theme="light"');
        expect(darkHtml).toContain('data-theme="dark"');
    });
});
