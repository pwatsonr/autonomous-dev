// SPEC-034-3-01/02/03 — unit tests for the contrast/parity math + parser.
//
// Covers:
//   - WCAG goldens (black/white = 21, gray/gray = 1) to +/- 0.01
//   - hexToRgb basic + invalid input throws
//   - parseTokens happy path against a minimal CSS fixture
//   - parseTokens throws on missing --bg-0 / missing --phase-*
//   - PAIRS derived from PHASES (7 pairs, pipeline order)
//   - extractVarNames returns the full set of declared --vars
//   - isThemeInvariant honors documented prefixes

import { describe, expect, test } from "bun:test";

import {
    PAIRS,
    PHASES,
    THEME_INVARIANT_PREFIXES,
    contrastRatio,
    extractVarNames,
    hexToRgb,
    isThemeInvariant,
    parseTokens,
    relativeLuminance,
    srgbToLinear,
} from "../../scripts/check-phase-contrast";

describe("color math (WCAG)", () => {
    test("contrastRatio(black, white) === 21 (+/- 0.01)", () => {
        expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 2);
    });

    test("contrastRatio(white, black) === 21 (commutative)", () => {
        expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 2);
    });

    test("contrastRatio(gray, gray) === 1", () => {
        expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 6);
    });

    test("hexToRgb('#ffffff') === [1, 1, 1]", () => {
        expect(hexToRgb("#ffffff")).toEqual([1, 1, 1]);
    });

    test("hexToRgb('#000000') === [0, 0, 0]", () => {
        expect(hexToRgb("#000000")).toEqual([0, 0, 0]);
    });

    test("hexToRgb throws on invalid hex", () => {
        expect(() => hexToRgb("not-a-color")).toThrow();
        expect(() => hexToRgb("#fff")).toThrow(); // 3-digit shorthand not supported
    });

    test("srgbToLinear(0) === 0 and srgbToLinear(1) === 1", () => {
        expect(srgbToLinear(0)).toBeCloseTo(0, 6);
        expect(srgbToLinear(1)).toBeCloseTo(1, 6);
    });

    test("relativeLuminance(white) === 1, relativeLuminance(black) === 0", () => {
        expect(relativeLuminance([1, 1, 1])).toBeCloseTo(1, 6);
        expect(relativeLuminance([0, 0, 0])).toBeCloseTo(0, 6);
    });

    test("contrastRatio cross-check: #777 vs #fff approximately 4.48 (webaim baseline)", () => {
        // External reference (webaim contrast checker): #777777 vs #ffffff ~= 4.48
        const r = contrastRatio("#777777", "#ffffff");
        expect(r).toBeGreaterThan(4.4);
        expect(r).toBeLessThan(4.6);
    });
});

describe("PHASES + PAIRS", () => {
    test("PHASES has 8 entries in pipeline order", () => {
        expect(PHASES).toEqual([
            "prd",
            "tdd",
            "plan",
            "spec",
            "code",
            "review",
            "deploy",
            "observe",
        ]);
    });

    test("PAIRS has 7 adjacent pairs derived from PHASES", () => {
        expect(PAIRS).toHaveLength(7);
        expect(PAIRS[0]).toEqual(["prd", "tdd"]);
        expect(PAIRS[6]).toEqual(["deploy", "observe"]);
    });

    test("PAIRS is derived (each pair[1] === next pair[0])", () => {
        for (let i = 0; i < PAIRS.length - 1; i++) {
            expect(PAIRS[i][1]).toBe(PAIRS[i + 1][0]);
        }
    });
});

describe("isThemeInvariant", () => {
    test("returns true for documented prefixes", () => {
        expect(isThemeInvariant("--s-4")).toBe(true);
        expect(isThemeInvariant("--r-pill")).toBe(true);
        expect(isThemeInvariant("--ease-std")).toBe(true);
        expect(isThemeInvariant("--dur-fast")).toBe(true);
        expect(isThemeInvariant("--t-display")).toBe(true);
    });

    test("returns false for color/semantic prefixes", () => {
        expect(isThemeInvariant("--bg-0")).toBe(false);
        expect(isThemeInvariant("--fg-0")).toBe(false);
        expect(isThemeInvariant("--brand")).toBe(false);
        expect(isThemeInvariant("--phase-prd")).toBe(false);
        expect(isThemeInvariant("--ok")).toBe(false);
    });

    test("THEME_INVARIANT_PREFIXES is non-empty", () => {
        expect(THEME_INVARIANT_PREFIXES.length).toBeGreaterThan(0);
    });
});

// -----------------------------------------------------------------------------
// Parser fixtures
// -----------------------------------------------------------------------------

function makeFixtureCss(overrides: { lightPhases?: Record<string, string>; darkPhases?: Record<string, string>; lightBg?: string; darkBg?: string } = {}): string {
    const lightPhases: Record<string, string> = {
        prd: "#6b4ea8",
        tdd: "#2f6f8f",
        plan: "#1d7a5f",
        spec: "#6b6a1a",
        code: "#c8631a",
        review: "#8a4d1b",
        deploy: "#2f7a3e",
        observe: "#5a5a5a",
        ...overrides.lightPhases,
    };
    const darkPhases: Record<string, string> = {
        prd: "#a48bd9",
        tdd: "#6fa8c7",
        plan: "#66b896",
        spec: "#b5b250",
        code: "#e89255",
        review: "#c98a55",
        deploy: "#98c39a",
        observe: "#9a978a",
        ...overrides.darkPhases,
    };
    const lightBg = overrides.lightBg ?? "#fafaf7";
    const darkBg = overrides.darkBg ?? "#14130f";

    const phaseLines = (m: Record<string, string>): string =>
        Object.entries(m)
            .map(([k, v]) => `  --phase-${k}: ${v};`)
            .join("\n");

    return `
:root {
  --bg-0: ${lightBg};
  --bg-1: #ffffff;
  --fg-0: #1a1a17;
  --brand: #c8631a;
  --s-1: 4px;
${phaseLines(lightPhases)}
}

:root[data-theme="dark"] {
  --bg-0: ${darkBg};
  --bg-1: #1c1b16;
  --fg-0: #ede9d8;
  --brand: #e89255;
${phaseLines(darkPhases)}
}
`;
}

describe("parseTokens", () => {
    test("happy path returns light + dark with bg0 and 8 phases each", () => {
        const css = makeFixtureCss();
        const t = parseTokens(css);
        expect(t.light.bg0).toBe("#fafaf7");
        expect(t.dark.bg0).toBe("#14130f");
        expect(Object.keys(t.light.phases)).toHaveLength(8);
        expect(Object.keys(t.dark.phases)).toHaveLength(8);
        expect(t.light.phases.prd).toBe("#6b4ea8");
        expect(t.dark.phases.prd).toBe("#a48bd9");
    });

    test("throws on missing --bg-0 in dark block", () => {
        const css = makeFixtureCss().replace("--bg-0: #14130f;", "/* removed */");
        expect(() => parseTokens(css)).toThrow(/--bg-0 not found in dark/);
    });

    test("throws on missing --phase-prd in light block", () => {
        const css = makeFixtureCss().replace("  --phase-prd: #6b4ea8;\n", "");
        expect(() => parseTokens(css)).toThrow(/--phase-prd not found in light/);
    });

    test("throws when :root[data-theme=\"dark\"] block is missing", () => {
        const css = makeFixtureCss().replace(/:root\[data-theme="dark"\][^}]+\}/, "");
        expect(() => parseTokens(css)).toThrow(/dark/);
    });

    test("throws when :root block is missing entirely", () => {
        const css = ":root[data-theme=\"dark\"] { --bg-0: #000; }";
        expect(() => parseTokens(css)).toThrow();
    });
});

describe("extractVarNames", () => {
    test("captures every --name declaration in a block", () => {
        const block = `
            --s-1: 4px;
            --bg-0: #fafaf7;
            --phase-prd: #6b4ea8;
            --border-thin: 1px solid var(--line-1);
        `;
        const names = extractVarNames(block);
        expect(names.has("--s-1")).toBe(true);
        expect(names.has("--bg-0")).toBe(true);
        expect(names.has("--phase-prd")).toBe(true);
        expect(names.has("--border-thin")).toBe(true);
        // var(...) reference should NOT be captured as a declaration
        expect(names.has("--line-1")).toBe(false);
        expect(names.size).toBe(4);
    });

    test("returns empty set on a block with no declarations", () => {
        expect(extractVarNames("/* nothing */").size).toBe(0);
    });
});
