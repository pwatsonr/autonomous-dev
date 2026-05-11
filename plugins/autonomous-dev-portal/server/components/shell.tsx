// SPEC-035-1-01 §ShellLayout — two-column portal shell.
// SPEC-037-1-01 — default theme flipped to "dark".
// SPEC-037-1-02 — theme-toggle pill mounted at the foot of `.rail-ops`.
// SPEC-037-3-04 — `.rail-ops` rewritten to 3 `<div class="line">` rows
//                 (Daemon / Breaker / MTD) plus the existing kill-switch
//                 button and theme-toggle pill. The toggle from
//                 SPEC-037-1-02 is preserved verbatim (single source).
//
// The portal's redesigned chrome: a 220px left rail containing brand +
// nav + ops bar, paired with a flexible content column that renders the
// page body. Replaces `BaseLayout` (server/templates/layout/base.tsx)
// once SPEC-035-1-05 wires the routes through this component; until then
// both files coexist and `base.tsx` remains the active layout.
//
// Composition (per TDD-035 SS 6.1):
//   <html data-theme={theme}>
//     <head>
//       <FOUC IIFE>          -- runs before paint to set data-theme
//       <design-tokens.css>  -- MUST be first stylesheet (SPEC-034-1-06)
//       <portal.css>
//       <shell.css>          -- shell-only layout primitives
//       <htmx.min.js defer>
//       <theme-toggle.js>
//     </head>
//     <body>
//       <div class="app">
//         <aside class="rail">…brand · nav · ops bar…</aside>
//         <main class="main">
//           <div class="page-head"><h1/> <div class="head-actions"/></div>
//           {children}
//           {modalSlotContent ?? <div id="modal-slot" />}
//         </main>
//       </div>
//     </body>
//   </html>
//
// CSP-compatible by construction:
//   - The only inline script is the FOUC-prevention IIFE, which carries
//     the per-request nonce via `cspNonce`.
//   - All other scripts are external + nonce-tagged.
//   - No inline `style="…"` attributes; styling lives in shell.css and
//     consumes design tokens only (R-15a).

import type { FC } from "hono/jsx";

import type { Theme } from "../lib/theme";
import { RailNav } from "./rail-nav";
import { BrandWordmark } from "./brand-wordmark";

/**
 * SPEC-034-1-06 — FOUC-prevention IIFE.
 * SPEC-037-1-01 — Default flipped to "dark" so cold loads paint against the
 * kit's dark palette. Only the literal `"light"` resolves to light; missing
 * or unexpected values resolve to "dark".
 *
 * Runs synchronously in <head> to apply the persisted theme to
 * `<html data-theme>` before first paint. `localStorage` access is
 * wrapped in try/catch because some sandboxed contexts throw on read;
 * we silently fall back to "dark" in that case.
 */
const FOUC_PREVENTION_IIFE =
    "(function(){var t;try{t=localStorage.getItem('portal-theme')}catch(e){}" +
    "document.documentElement.dataset.theme=t==='light'?'light':'dark';})();";

/** SPEC-037-3-04 — supported daemon states for the rail's Daemon row. */
export type DaemonStatusTone = "running" | "stale" | "down" | "unknown";

/** SPEC-037-3-04 — supported circuit-breaker states for the Breaker row. */
export type BreakerState = "OK" | "TRIPPED" | "unknown";

export interface ShellProps {
    /** Current request path; passed to nav children for active highlighting. */
    activePath: string;
    /** Server-rendered theme (from `getThemeFromCookie`). Default `"dark"`
     *  (SPEC-037-1-01 — dark-default kit baseline). */
    theme?: Theme;
    /** SPEC-014-2-04 — per-request CSP nonce. Empty string disables (tests). */
    cspNonce?: string;
    /**
     * Optional override for the modal slot. When omitted, an empty
     * `<div id="modal-slot">` is rendered as the HTMX swap target.
     * Routes that pre-render a modal (e.g. detail dialogs) can pass
     * the modal markup directly instead.
     */
    modalSlotContent?: unknown;
    /** Page body — renders inside `<main class="main">` after page-head. */
    children?: unknown;
    /** Optional page title rendered inside `<div class="page-head"><h1/>`. */
    pageTitle?: string;
    /** Optional `<div class="head-actions">` content (buttons, links, etc.). */
    headActions?: unknown;
    /** Pending-approval count badge for the RailNav Approvals item. */
    approvalsCount?: number;
    /** SPEC-037-3-02 — active-request count badge for the Requests item. */
    requestsCount?: number;
    /** SPEC-037-3-02 — agent-alert count badge for the Agents item. */
    agentsAlertCount?: number;
    /** Daemon status pill in the RailOpsBar. */
    daemonStatus?: DaemonStatusTone;
    /** SPEC-037-3-04 AC-02 — daemon heartbeat age in seconds (right-aligned). */
    daemonAgeSeconds?: number;
    /** Whether the kill-switch is currently engaged. */
    killSwitchEngaged?: boolean;
    /** MTD spend value rendered in the RailOpsBar (USD, 2 decimals). */
    mtdSpend?: number;
    /** SPEC-037-3-04 AC-04 — MTD spend as a % of the monthly cap. */
    mtdPctOfCap?: number;
    /** SPEC-037-3-04 AC-03 — circuit-breaker state for the Breaker row. */
    breakerState?: BreakerState;
    /** SPEC-037-3-04 AC-03 — number of consecutive failures observed. */
    breakerCount?: number;
    /** SPEC-037-3-04 AC-03 — failure threshold that trips the breaker. */
    breakerThreshold?: number;
}

/**
 * SPEC-037-3-04 — tone-to-dot mapping for the Daemon row.
 *
 * `unknown` collapses to `muted` so an unreadable heartbeat does not
 * scream `err` (which is reserved for a confirmed down daemon).
 */
function daemonTone(status: DaemonStatusTone): string {
    switch (status) {
        case "running":
            return "live";
        case "stale":
            return "warn";
        case "down":
            return "err";
        default:
            return "muted";
    }
}

function daemonLabel(status: DaemonStatusTone): string {
    switch (status) {
        case "running":
            return "Daemon running";
        case "stale":
            return "Daemon stale";
        case "down":
            return "Daemon down";
        default:
            return "Daemon unknown";
    }
}

/** SPEC-037-3-04 AC-03 — tone for the Breaker row. */
function breakerTone(state: BreakerState): string {
    switch (state) {
        case "OK":
            return "ok";
        case "TRIPPED":
            return "err";
        default:
            return "muted";
    }
}

/**
 * SPEC-037-3-04 AC-04 — MTD tone thresholds.
 *
 * `>= 100` is the over-cap red band; `>= 75` is the approaching-cap
 * warn band; anything else is the healthy green band. `undefined` is
 * handled by the caller (the row is omitted entirely).
 */
function mtdTone(pctOfCap: number | undefined): string {
    if (pctOfCap === undefined) return "ok";
    if (pctOfCap >= 100) return "err";
    if (pctOfCap >= 75) return "warn";
    return "ok";
}

/**
 * SPEC-037-3-04 — small internal helper for the 3 `.line` rows so the
 * tone/label/value pattern is not repeated three times. Kept private to
 * this module — the rail-ops layout is not a reusable surface.
 */
interface RailOpsRowProps {
    tone: string;
    label: string;
    value: string;
}

function RailOpsRow({ tone, label, value }: RailOpsRowProps): unknown {
    return (
        <div class="line">
            <span class={`dot ${tone}`}></span>
            {label}
            <span class="v">{value}</span>
        </div>
    );
}

/**
 * SPEC-035-1-01 §ShellLayout
 *
 * Renders the full HTML document with a 220px left rail + flexible
 * content column. The rail content is intentionally minimal in this
 * spec; SPEC-035-1-02/03/04 will populate it with `<RailNav>`,
 * `<RailOpsBar>`, and `<BrandWordmark>` respectively.
 */
export const ShellLayout: FC<ShellProps> = ({
    activePath,
    theme = "dark",
    cspNonce,
    modalSlotContent,
    pageTitle,
    headActions,
    children,
    approvalsCount,
    requestsCount,
    agentsAlertCount,
    daemonStatus = "unknown",
    daemonAgeSeconds,
    killSwitchEngaged = false,
    mtdSpend,
    mtdPctOfCap,
    breakerState = "unknown",
    breakerCount,
    breakerThreshold,
}) => {
    // SPEC-037-1-01 — Defensive resolve: only the literal "light" returns
    // "light"; any other value (including undefined) resolves to "dark".
    const resolvedTheme: Theme = theme === "light" ? "light" : "dark";
    const nonce = cspNonce ?? "";

    // SPEC-037-3-04 AC-02 — daemon row value: heartbeat age when known,
    // empty string when status is `"unknown"` (which means we have no
    // heartbeat at all to time against).
    const daemonValue =
        daemonStatus === "unknown" || daemonAgeSeconds === undefined
            ? ""
            : `${daemonAgeSeconds}s`;

    // SPEC-037-3-04 AC-03 — breaker value: `count/threshold` when both
    // are numeric; `--/--` when either is missing.
    const breakerValue =
        typeof breakerCount === "number" && typeof breakerThreshold === "number"
            ? `${breakerCount}/${breakerThreshold}`
            : "--/--";

    // SPEC-037-3-04 AC-04 — MTD row is omitted entirely when no spend
    // value is available (vs rendering `$0.00 (0%)` which would suggest
    // a successful read of a literally-zero ledger).
    const showMtdRow = typeof mtdSpend === "number";
    const mtdValue =
        showMtdRow
            ? `$${mtdSpend.toFixed(2)} (${mtdPctOfCap ?? 0}%)`
            : "";

    return (
        <html lang="en" data-theme={resolvedTheme}>
            <head>
                <meta charset="utf-8" />
                <meta
                    name="viewport"
                    content="width=device-width, initial-scale=1"
                />
                <title>autonomous-dev portal</title>
                {/* SPEC-034-1-06 — synchronous FOUC-prevention IIFE.
                    Must run BEFORE any stylesheet so `data-theme` is set
                    before the browser paints. */}
                <script
                    nonce={nonce}
                    dangerouslySetInnerHTML={{ __html: FOUC_PREVENTION_IIFE }}
                ></script>
                {/* SPEC-034-1-06 AC-01/02/03 — design-tokens.css is the
                    FIRST stylesheet so `var(--…)` references resolve. */}
                <link rel="stylesheet" href="/static/design-tokens.css" />
                <link rel="stylesheet" href="/static/app.css" />
                <link rel="stylesheet" href="/static/portal.css" />
                <link rel="stylesheet" href="/static/shell.css" />
                <script
                    src="/static/htmx.min.js"
                    defer
                    nonce={nonce}
                ></script>
                <script
                    src="/static/theme-toggle.js"
                    type="module"
                    nonce={nonce}
                ></script>
                {/* SPEC-037-4-02 — Approvals segmented filter; pure DOM
                    module that self-attaches on DOMContentLoaded and
                    on htmx:afterSwap so OOB swaps re-bind cleanly. */}
                <script
                    src="/static/segmented-filter.js"
                    defer
                    nonce={nonce}
                ></script>
            </head>
            <body>
                <div class="app">
                    <aside class="rail" data-active-path={activePath}>
                        <div class="rail-brand">
                            <BrandWordmark theme={resolvedTheme} />
                        </div>
                        <RailNav
                            activePath={activePath}
                            approvalsCount={approvalsCount}
                            requestsCount={requestsCount}
                            agentsAlertCount={agentsAlertCount}
                        />
                        {/* SPEC-037-3-04 — 3-line metrics layout. The MTD row
                            is conditionally rendered; Daemon + Breaker rows
                            always render so the rail height stays stable
                            when the cost ledger has not been seeded yet. */}
                        <div class="rail-ops">
                            <RailOpsRow
                                tone={daemonTone(daemonStatus)}
                                label={daemonLabel(daemonStatus)}
                                value={daemonValue}
                            />
                            <RailOpsRow
                                tone={breakerTone(breakerState)}
                                label={`Breaker ${breakerState}`}
                                value={breakerValue}
                            />
                            {showMtdRow ? (
                                <RailOpsRow
                                    tone={mtdTone(mtdPctOfCap)}
                                    label="MTD spend"
                                    value={mtdValue}
                                />
                            ) : null}
                            <button
                                type="button"
                                class={`kbtn ${killSwitchEngaged ? "engaged" : ""}`}
                                hx-get="/ops/kill-switch-modal?step=arm"
                                hx-target="#modal-slot"
                                hx-swap="innerHTML"
                            >
                                {killSwitchEngaged
                                    ? "Kill switch ENGAGED"
                                    : "Kill switch"}
                            </button>
                            {/* SPEC-037-1-02 — theme-toggle pill. The click
                                handler is wired by static/theme-toggle.js
                                via a delegated `[data-action="toggle-theme"]`
                                listener (SPEC-037-1-03); no inline onclick.
                                SPEC-037-3-04 preserves this single source — the
                                toggle is NOT re-rendered when the 3-line
                                metrics block is composed. */}
                            <button
                                type="button"
                                class="theme-toggle"
                                aria-label="Toggle theme"
                                data-action="toggle-theme"
                            >
                                <span class={`tt-track ${resolvedTheme}`}>
                                    <span class="tt-knob"></span>
                                    <span class="tt-l tt-light">LIGHT</span>
                                    <span class="tt-l tt-dark">DARK</span>
                                </span>
                            </button>
                        </div>
                    </aside>
                    <main class="main">
                        {pageTitle !== undefined || headActions !== undefined ? (
                            <div class="page-head">
                                {pageTitle !== undefined ? (
                                    <h1>{pageTitle}</h1>
                                ) : null}
                                <div class="head-actions">{headActions}</div>
                            </div>
                        ) : null}
                        {children}
                        {modalSlotContent !== undefined ? (
                            modalSlotContent
                        ) : (
                            <div id="modal-slot"></div>
                        )}
                    </main>
                </div>
            </body>
        </html>
    );
};
