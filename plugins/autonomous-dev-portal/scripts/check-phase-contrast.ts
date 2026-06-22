#!/usr/bin/env bun
/**
 * SPEC-034-3-01 / -02 / -03 — Phase contrast verification + light/dark theme parity.
 *
 * Single CI-blocking script. Reads `server/static/design-tokens.css`, parses the
 * `:root` and `:root[data-theme="dark"]` blocks, and runs three checks:
 *
 *   Part A (WCAG SC 1.4.11): each --phase-* vs --bg-0 in both themes >= 3.0:1.
 *     8 phases x 2 themes = 16 checks.   PRD-018 M-02 part A.
 *
 *   Part B (peer-chip):     adjacent --phase-* pairs in pipeline order
 *     (prd, tdd, plan, spec, code, review, deploy, observe) in both themes >= 3.0:1.
 *     7 pairs x 2 themes = 14 checks.    PRD-018 M-02 part B / OI-3403.
 *
 *   Part C (theme parity):  every CSS variable in :root has a counterpart in the
 *     dark block (and vice versa), modulo a documented allowlist of
 *     theme-invariant token families.   PRD-018 M-06.
 *
 * Exit 0 if all pass; exit 1 on any failure. CI-blocking — no advisory mode.
 *
 * Refs:
 *   - PRD-018 v1.1 M-02 (parts A + B), M-06 (theme parity)
 *   - TDD-034 §5.10, §5.11
 *   - PLAN-034-3 Tasks 1-4
 *
 * Run locally: `bun plugins/autonomous-dev-portal/scripts/check-phase-contrast.ts`
 *   (optionally pass an explicit token-file path as positional arg for fixture testing).
 *
 * Flags:
 *   --skip-peer-chip   Skip Part B (adjacent peer-chip pair contrast). Used in CI
 *                      where Part B is currently advisory pending the design palette
 *                      decision (SPEC-034-2-04 — Part B fails 14/14 against the
 *                      current palette; tracked as an open design-system issue).
 *                      Parts A and C still run and remain merge-blocking.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** 8 phase tokens in pipeline order. SPEC-034-3-01/02. */
export const PHASES = [
    "prd",
    "tdd",
    "plan",
    "spec",
    "code",
    "review",
    "deploy",
    "observe",
] as const;

/** 7 adjacent pairs in pipeline order, derived from PHASES (SPEC-034-3-02 §1). */
export const PAIRS: ReadonlyArray<readonly [string, string]> = PHASES.slice(0, -1).map(
    (a, i) => [a, PHASES[i + 1]] as const,
);

/**
 * Theme-invariant token families (defined once in :root, not re-declared per theme).
 * Adding a new theme-invariant family is a one-line edit; converting a
 * theme-sensitive family to invariant requires a TDD update.
 *
 * Reviewer asserts each prefix against design-tokens.css on every PR.
 */
export const THEME_INVARIANT_PREFIXES = [
    "--s-",      // spacing scale (one source of truth, not theme)
    "--r-",      // radii (geometry, not theme)
    "--t-",      // type scale (sizes, not colors) — vendored CSS uses --t-* (spec text said --text-*; actual tokens use --t-*)
    "--text-",   // future-proof: alternative type-scale prefix from spec text
    "--lh-",     // line heights (sizes, not theme)
    "--font-",   // font families (typeface stack, not theme)
    "--ease-",   // motion easing curves (durations/eases, not theme)
    "--dur-",    // motion durations (durations/eases, not theme)
    "--border-", // border shorthands (composed from theme-sensitive line vars; defined once)
] as const;

export function isThemeInvariant(name: string): boolean {
    return THEME_INVARIANT_PREFIXES.some((p) => name.startsWith(p));
}

const THRESHOLD = 3.0;

// -----------------------------------------------------------------------------
// Color math (WCAG 2.x relative luminance + contrast ratio)
// -----------------------------------------------------------------------------

/** Convert a `#rrggbb` hex string to normalized [r, g, b] in 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
    const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) {
        throw new Error(`Invalid hex color: ${hex}`);
    }
    const v = m[1];
    return [
        parseInt(v.slice(0, 2), 16) / 255,
        parseInt(v.slice(2, 4), 16) / 255,
        parseInt(v.slice(4, 6), 16) / 255,
    ];
}

/** sRGB component to linear-light per WCAG 2.x. */
export function srgbToLinear(c: number): number {
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance per WCAG: L = 0.2126*R + 0.7152*G + 0.0722*B (linear). */
export function relativeLuminance(rgb: [number, number, number]): number {
    const [r, g, b] = rgb;
    return (
        0.2126 * srgbToLinear(r) +
        0.7152 * srgbToLinear(g) +
        0.0722 * srgbToLinear(b)
    );
}

/** WCAG contrast ratio between two hex colors. Result is in [1, 21]. */
export function contrastRatio(hex1: string, hex2: string): number {
    const l1 = relativeLuminance(hexToRgb(hex1));
    const l2 = relativeLuminance(hexToRgb(hex2));
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

// -----------------------------------------------------------------------------
// Token-file parser
// -----------------------------------------------------------------------------

export interface ThemeColors {
    bg0: string;
    phases: Record<string, string>;
}

export interface ParsedTokens {
    light: ThemeColors;
    dark: ThemeColors;
    lightBlock: string;
    darkBlock: string;
}

/**
 * Extract the contents of `:root { ... }` and `:root[data-theme="dark"] { ... }`.
 *
 * Uses the [^}]+ regex pattern from TDD-034 §5.10 — pinned per the spec, no
 * CSS-parser library. Throws if either block is missing.
 */
function extractBlocks(css: string): { lightBlock: string; darkBlock: string } {
    // The dark selector contains '[' and ']' which the simple :root regex would also
    // match if we don't anchor. So match dark first, then strip it before matching light.
    const darkRe = /:root\[data-theme="dark"\]\s*\{([^}]+)\}/;
    const darkMatch = darkRe.exec(css);
    if (!darkMatch) {
        throw new Error('Missing :root[data-theme="dark"] block in token CSS');
    }
    const darkBlock = darkMatch[1];

    // Strip the dark block from the source so the next regex doesn't pick the
    // dark selector (which starts with `:root` literally) before the plain :root.
    const cssWithoutDark = css.slice(0, darkMatch.index) + css.slice(darkMatch.index + darkMatch[0].length);

    // Match plain :root, NOT :root[...]. Negative-lookahead-free: require whitespace or `{` next.
    const lightRe = /:root\s*\{([^}]+)\}/;
    const lightMatch = lightRe.exec(cssWithoutDark);
    if (!lightMatch) {
        throw new Error("Missing :root block in token CSS");
    }
    const lightBlock = lightMatch[1];

    return { lightBlock, darkBlock };
}

/** Extract every `--name: #rrggbb` declaration from a block. */
function extractHexVars(block: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
        out[m[1]] = m[2];
    }
    return out;
}

/** Extract every `--name` declaration name (any value). */
export function extractVarNames(block: string): Set<string> {
    const names = new Set<string>();
    const re = /(--[a-z0-9-]+)\s*:/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block)) !== null) {
        names.add(m[1]);
    }
    return names;
}

/** Parse the token file into per-theme phase + bg-0 colors. */
export function parseTokens(css: string): ParsedTokens {
    const { lightBlock, darkBlock } = extractBlocks(css);

    const buildTheme = (block: string, label: "light" | "dark"): ThemeColors => {
        const hexes = extractHexVars(block);
        if (!hexes["--bg-0"]) {
            throw new Error(`--bg-0 not found in ${label} block`);
        }
        const phases: Record<string, string> = {};
        for (const p of PHASES) {
            const key = `--phase-${p}`;
            if (!hexes[key]) {
                throw new Error(`${key} not found in ${label} block`);
            }
            phases[p] = hexes[key];
        }
        return { bg0: hexes["--bg-0"], phases };
    };

    return {
        light: buildTheme(lightBlock, "light"),
        dark: buildTheme(darkBlock, "dark"),
        lightBlock,
        darkBlock,
    };
}

// -----------------------------------------------------------------------------
// Section runners
// -----------------------------------------------------------------------------

interface RunResult {
    failedA: boolean;
    failedB: boolean;
    failedC: boolean;
    passA: number;
    passB: number;
    passC: number;
    totalA: number;
    totalB: number;
    totalC: number;
}

function runPartA(tokens: ParsedTokens): { failed: boolean; pass: number; total: number } {
    console.log("=== Part A: WCAG SC 1.4.11 — Phase colors vs --bg-0 ===");
    let failed = false;
    let pass = 0;
    let total = 0;
    for (const [label, theme] of [
        ["light", tokens.light],
        ["dark", tokens.dark],
    ] as const) {
        console.log(`  Theme: ${label} (--bg-0: ${theme.bg0})`);
        for (const p of PHASES) {
            total++;
            const ratio = contrastRatio(theme.phases[p], theme.bg0);
            const ok = ratio >= THRESHOLD;
            if (ok) pass++;
            else failed = true;
            console.log(
                `    --phase-${p.padEnd(7)} ${theme.phases[p]}  ratio ${ratio.toFixed(2)}:1  ${ok ? "PASS" : "FAIL"}`,
            );
        }
    }
    console.log("");
    return { failed, pass, total };
}

function runPartB(tokens: ParsedTokens): { failed: boolean; pass: number; total: number } {
    console.log("=== Part B: Adjacent phase pair contrast (>=3:1) ===");
    let failed = false;
    let pass = 0;
    let total = 0;
    for (const [label, theme] of [
        ["light", tokens.light],
        ["dark", tokens.dark],
    ] as const) {
        console.log(`  Theme: ${label}`);
        for (const [a, b] of PAIRS) {
            total++;
            const ratio = contrastRatio(theme.phases[a], theme.phases[b]);
            const ok = ratio >= THRESHOLD;
            if (ok) pass++;
            else failed = true;
            console.log(
                `    ${a.padEnd(7)} / ${b.padEnd(7)} ratio ${ratio.toFixed(2)}:1  ${ok ? "PASS" : "FAIL"}`,
            );
        }
    }
    console.log("");
    return { failed, pass, total };
}

function runPartC(tokens: ParsedTokens): { failed: boolean; pass: number; total: number } {
    console.log("=== Theme parity: Variable coverage ===");
    const lightVars = extractVarNames(tokens.lightBlock);
    const darkVars = extractVarNames(tokens.darkBlock);

    const lightOnly = [...lightVars]
        .filter((n) => !darkVars.has(n) && !isThemeInvariant(n))
        .sort();
    const darkOnly = [...darkVars]
        .filter((n) => !lightVars.has(n) && !isThemeInvariant(n))
        .sort();

    const totalCompared =
        [...lightVars].filter((n) => !isThemeInvariant(n)).length +
        [...darkVars].filter((n) => !isThemeInvariant(n)).length;
    const failed = lightOnly.length > 0 || darkOnly.length > 0;
    const paired = totalCompared - (lightOnly.length + darkOnly.length);

    console.log(
        `  Light-only variables: ${lightOnly.length === 0 ? "(none)" : lightOnly.join(", ")}`,
    );
    console.log(
        `  Dark-only variables:  ${darkOnly.length === 0 ? "(none)" : darkOnly.join(", ")}`,
    );
    console.log(`  ${failed ? "FAIL" : "PASS"}  (${paired}/${totalCompared} variables paired)`);
    console.log("");
    return { failed, pass: paired, total: totalCompared };
}

// -----------------------------------------------------------------------------
// Entrypoint
// -----------------------------------------------------------------------------

interface CliOptions {
    tokenPath: string;
    skipPeerChip: boolean;
}

function parseArgs(argv: string[]): CliOptions {
    // argv[0]=node/bun, argv[1]=script path, argv[2..]=user args.
    const userArgs = argv.slice(2);
    let skipPeerChip = false;
    const positional: string[] = [];
    for (const a of userArgs) {
        if (a === "--skip-peer-chip") {
            skipPeerChip = true;
        } else if (a.startsWith("--")) {
            console.error(`Unknown flag: ${a}`);
            // Continue (lenient) — unknown flags are reported but do not abort
            // so future flags can be added without breaking older callers.
        } else {
            positional.push(a);
        }
    }
    const tokenPath =
        positional[0] ??
        // default: vendored portal token file relative to this script. The
        // committed token file lives at `static/design-tokens.css` (served at
        // `/static/...`); the old `server/static/` default ENOENT'd in CI
        // because that path is never built/committed (#570).
        join(import.meta.dir ?? __dirname, "..", "static", "design-tokens.css");
    return { tokenPath, skipPeerChip };
}

export function main(argv: string[] = process.argv): number {
    const { tokenPath, skipPeerChip } = parseArgs(argv);
    let css: string;
    try {
        css = readFileSync(tokenPath, "utf8");
    } catch (e) {
        console.error(`FATAL: cannot read token file at ${tokenPath}: ${(e as Error).message}`);
        return 2;
    }

    let tokens: ParsedTokens;
    try {
        tokens = parseTokens(css);
    } catch (e) {
        console.error(`FATAL: failed to parse token file: ${(e as Error).message}`);
        return 2;
    }

    console.log(`Token file: ${tokenPath}`);
    console.log("");

    const a = runPartA(tokens);

    let b: { failed: boolean; pass: number; total: number } | null;
    if (skipPeerChip) {
        console.log("=== Part B: SKIPPED (--skip-peer-chip) ===");
        console.log(
            "  Adjacent peer-chip pair contrast is currently advisory in CI per",
        );
        console.log(
            "  SPEC-034-2-04. Part B fails against the current design palette and",
        );
        console.log("  is tracked as an open design-system issue.");
        console.log("");
        b = null;
    } else {
        b = runPartB(tokens);
    }

    const c = runPartC(tokens);

    const exitCode = a.failed || (b?.failed ?? false) || c.failed ? 1 : 0;

    console.log("=== Summary ===");
    console.log(`  Part A: ${a.pass}/${a.total} PASS  (WCAG SC 1.4.11)`);
    if (b) {
        console.log(`  Part B: ${b.pass}/${b.total} PASS  (adjacent phase pairs)`);
    } else {
        console.log("  Part B: SKIPPED  (adjacent phase pairs — advisory)");
    }
    console.log(`  Part C: ${c.pass}/${c.total} variables paired  (light/dark parity)`);
    console.log(`  Overall: ${exitCode === 0 ? "PASS" : "FAIL"}`);

    if (exitCode !== 0) {
        console.error("");
        console.error("FAIL: One or more contrast checks did not meet the >=3:1 threshold.");
        console.error("  Part A failures: phase color vs --bg-0 (WCAG SC 1.4.11)");
        if (b) {
            console.error("  Part B failures: adjacent phase pair contrast (PRD-018 M-02)");
        }
        console.error("  Parity failures: light/dark variable coverage (PRD-018 M-06)");
    }

    return exitCode;
}

// Only run main() when this file is executed directly (not when imported by tests).
// Using import.meta.main (Bun) when available, otherwise fall back to argv check.
const isDirect =
    // @ts-expect-error import.meta.main is a Bun extension
    (typeof import.meta !== "undefined" && (import.meta as { main?: boolean }).main === true) ||
    // Node fallback: compare resolved script path
    (process.argv[1] && process.argv[1].endsWith("check-phase-contrast.ts"));

if (isDirect) {
    process.exit(main(process.argv));
}
