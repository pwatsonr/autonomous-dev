// SPEC-035-1-04 §BrandWordmark — theme-aware inline-text wordmark.
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

import type { FC } from "hono/jsx";

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
}

function bracketsDefault(): boolean {
    return (process.env["PORTAL_WORDMARK_BRACKETS"] ?? "1") === "1";
}

export const BrandWordmark: FC<BrandWordmarkProps> = ({
    showBrackets,
    theme,
}) => {
    const renderBrackets =
        typeof showBrackets === "boolean" ? showBrackets : bracketsDefault();
    // AC-02 / AC-03: whitespace inside the wordmark must be exactly
    // " autonomous-dev " (single space on each side) so the rendered
    // string matches TDD-035 SS 6.4 verbatim regardless of whether
    // brackets are present.
    if (renderBrackets) {
        return (
            <div class="wm" data-theme={theme}>
                <span class="br">[</span> autonomous-dev{" "}
                <span class="br">]</span>
            </div>
        );
    }
    return (
        <div class="wm" data-theme={theme}>
            {" "}
            autonomous-dev{" "}
        </div>
    );
};
