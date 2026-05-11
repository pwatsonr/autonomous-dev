// PLAN-038 TASK-003 / TDD-037 §5.6 AC-3711 — CTA `--brand` cascade pin.
//
// Pins three guarantees so the regression cannot silently come back:
//
//   1. `design-tokens.css` defines `--brand` in both light and dark theme
//      blocks (no new `--accent` token, no missing variable).
//   2. `app.css` rule `.btn.primary { background: var(--brand) }` exists
//      (so any element with `class="btn primary"` consumes the brand color).
//   3. No higher-priority rule in `portal.css` or `shell.css` overrides
//      `.btn.primary` with a hard-coded color or undefined-variable
//      reference.
//
// Static analysis on the CSS files (not a headless-browser computedStyle
// probe) keeps the test hermetic and fast. The headless-browser variant
// belongs in the Playwright visual-regression suite (TASK-022).

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STATIC_DIR = join(import.meta.dir, "..", "..", "static");

function read(file: string): string {
    return readFileSync(join(STATIC_DIR, file), "utf-8");
}

describe("CTA `--brand` cascade (PLAN-038 TASK-003)", () => {
    test("design-tokens.css defines --brand in light + dark theme", () => {
        const css = read("design-tokens.css");
        // The light-theme block uses `:root { --brand: ... }` and the dark
        // block scopes by `[data-theme="dark"] { --brand: ... }`. Both must
        // be present for theme-toggle to keep the CTA accented.
        expect(css).toMatch(/--brand:\s*#[0-9a-fA-F]{3,8}/);
        // Count occurrences — should be at least two (one per theme block).
        const matches = css.match(/--brand:\s*#[0-9a-fA-F]+/g) ?? [];
        expect(matches.length).toBeGreaterThanOrEqual(2);
    });

    test("design-tokens.css does NOT define an --accent token (TDD-037 NG-3709)", () => {
        const css = read("design-tokens.css");
        // The kit has no --accent token; v1.0 of TDD-037 wrongly proposed
        // one. The pin here prevents a future PR from sneaking it back in.
        expect(css).not.toMatch(/--accent[\s-]*:\s*#/);
    });

    test("app.css defines `.btn.primary { background: var(--brand) }`", () => {
        const css = read("app.css");
        // Whitespace-tolerant match — strips extra spaces before comparing.
        const normalized = css.replace(/\s+/g, " ");
        expect(normalized).toMatch(
            /\.btn\.primary\s*\{[^}]*background:\s*var\(--brand\)/,
        );
    });

    test("no override of .btn.primary in portal.css", () => {
        const css = read("portal.css");
        // portal.css is for portal-only overrides (kill-switch, error page).
        // It must not redeclare `.btn.primary` with anything other than
        // var(--brand) — and ideally not at all.
        const matches = css.match(/\.btn\.primary\b[^{]*\{[^}]*\}/g) ?? [];
        for (const rule of matches) {
            // If a rule exists, it must use var(--brand). No hardcoded hex.
            // No reference to a missing token (e.g. --accent, --primary-color).
            expect(rule).toMatch(/var\(--brand[^)]*\)/);
            expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        }
    });

    test("no override of .btn.primary in shell.css", () => {
        const css = read("shell.css");
        const matches = css.match(/\.btn\.primary\b[^{]*\{[^}]*\}/g) ?? [];
        for (const rule of matches) {
            expect(rule).toMatch(/var\(--brand[^)]*\)/);
            expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        }
    });
});
