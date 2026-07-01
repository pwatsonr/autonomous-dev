// SPEC-035-1-04 §BrandWordmark — theme-aware inline-text wordmark.
// SPEC-037-3-03 — adds a `.meta-mono` caption reading `CONTROL PLANE · v{version}`
//                 directly under the wordmark. Version is read once at module
//                 load from `.claude-plugin/plugin.json` (with a `"0.0.0"`
//                 fallback) so it stays in sync with the plugin manifest.
//
// Renders the autonomous-dev wordmark as inline JSX (not <img>) so the
// brackets pick up `var(--brand)` and the wordmark text inherits
// `currentColor` — both update instantly on light/dark theme switch
// without requiring a separate asset swap.
//
// `showBrackets` defaults from PORTAL_WORDMARK_BRACKETS (OQ-02 fallback):
// if upstream IP confirmation forces a wordmark change, operators set
// PORTAL_WORDMARK_BRACKETS=0 and the bracket motif drops without a
// redeploy. See plugins/autonomous-dev-portal/docs/env-vars.md.
//
// AC-01: prop signature + env-var default.
// AC-02: with brackets — `<div class="wm"><span class="br">[</span> autonomous-dev <span class="br">]</span></div>`.
// AC-03: without brackets — `<div class="wm"> autonomous-dev </div>`.
// AC-04: bracket color comes from .rail-brand .wm .br { color: var(--brand) }
//        in portal.css; this component does not inline a color style.

import { PLUGIN_VERSION, DAEMON_VERSION } from "../lib/plugin-version";
import { readFileSync } from "node:fs";

import type { FC } from "hono/jsx";

/**
 * SPEC-037-3-03 AC-01 — module-load version read.
 *
 * Reads the plugin manifest once at module init and caches the version
 * string. Failures (missing file, malformed JSON, missing `.version`)
 * resolve to the static fallback `"0.0.0"` rather than throwing, so the
 * portal still boots when the manifest is absent (e.g. test fixtures).
 *
 * Caption renders the U+00B7 middle dot (·) between literal `CONTROL PLANE`
 * and `v{PLUGIN_VERSION}` — not a hyphen (AC-04).
 */

export interface BrandWordmarkProps {
    // When true, wraps the wordmark in `[ ... ]` brackets colored via
    // `var(--brand)`. Defaults to the PORTAL_WORDMARK_BRACKETS env var
    // (`"1"` truthy, anything else falsy). The default is computed at
    // call time so tests can mutate `process.env` between renders.
    showBrackets?: boolean;
    // Theme hint for callers that want to force a specific palette.
    // The component itself relies on CSS custom properties (currentColor /
    // var(--brand)) for theme switching, so this prop is informational
    // only — passed through as a `data-theme` attribute for any consumer
    // that wants to drive theme-specific overrides (e.g. screenshot
    // tooling that swaps palettes without flipping the document theme).
    theme?: "light" | "dark";
    /**
     * SPEC-037-3-03 AC-03 — when `false`, suppresses the `.meta-mono`
     * caption beneath the wordmark. Defaults to `true` so the caption
     * surfaces automatically for the production shell. Existing isolated
     * unit tests can pass `showCaption={false}` to keep their snapshots.
     */
    showCaption?: boolean;
}

function bracketsDefault(): boolean {
    return (process.env["PORTAL_WORDMARK_BRACKETS"] ?? "1") === "1";
}

export const BrandWordmark: FC<BrandWordmarkProps> = ({
    showBrackets,
    theme,
    showCaption = true,
}) => {
    const renderBrackets =
        typeof showBrackets === "boolean" ? showBrackets : bracketsDefault();
    // AC-02 / AC-03: whitespace inside the wordmark must be exactly
    // " autonomous-dev " (single space on each side) so the rendered
    // string matches TDD-035 SS 6.4 verbatim regardless of whether
    // brackets are present.
    const wordmark = renderBrackets ? (
        <div class="wm" data-theme={theme}>
            <span class="br">[</span> autonomous-dev{" "}
            <span class="br">]</span>
        </div>
    ) : (
        <div class="wm" data-theme={theme}>
            {" "}
            autonomous-dev{" "}
        </div>
    );
    // SPEC-037-3-03 AC-02/04/05: caption renders as a sibling of the
    // wordmark inside a fragment so callers (shell.tsx's `.rail-brand`
    // container) can style both lines together. Color comes from
    // `.meta-mono { color: var(--fg-2) }` in design-tokens.css — the
    // component does not inline any theme-specific color.
    return (
        <>
            {wordmark}
            {showCaption ? (
                <div class="meta-mono">{`CONTROL PLANE · daemon v${DAEMON_VERSION} · portal v${PLUGIN_VERSION}`}</div>
            ) : null}
        </>
    );
};
