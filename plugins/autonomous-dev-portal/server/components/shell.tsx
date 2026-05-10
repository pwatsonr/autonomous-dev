// SPEC-035-1-01 §ShellLayout — two-column portal shell.
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
 *
 * Runs synchronously in <head> to apply the persisted theme to
 * `<html data-theme>` before first paint. `localStorage` access is
 * wrapped in try/catch because some sandboxed contexts throw on read;
 * we silently fall back to "light" in that case. Identical to the
 * BaseLayout IIFE so behaviour is consistent across both layouts during
 * the transition.
 */
const FOUC_PREVENTION_IIFE =
    "(function(){var t;try{t=localStorage.getItem('portal-theme')}catch(e){}" +
    "document.documentElement.dataset.theme=t==='dark'?'dark':'light';})();";

export interface ShellProps {
    /** Current request path; passed to nav children for active highlighting. */
    activePath: string;
    /** Server-rendered theme (from `getThemeFromCookie`). Default `"light"`. */
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
    /** Daemon status pill in the RailOpsBar. */
    daemonStatus?: "running" | "stale" | "down" | "unknown";
    /** Whether the kill-switch is currently engaged. */
    killSwitchEngaged?: boolean;
    /** MTD spend value rendered in the RailOpsBar (USD, 2 decimals). */
    mtdSpend?: number;
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
    theme = "light",
    cspNonce,
    modalSlotContent,
    pageTitle,
    headActions,
    children,
    approvalsCount,
    daemonStatus = "unknown",
    killSwitchEngaged = false,
    mtdSpend,
}) => {
    const resolvedTheme: Theme = theme === "dark" ? "dark" : "light";
    const nonce = cspNonce ?? "";
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
                        />
                        <div class="rail-ops">
                            <div class="rail-ops-row">
                                <span
                                    class={`dot ${daemonStatus === "running" ? "live" : daemonStatus === "stale" ? "warn" : daemonStatus === "down" ? "err" : "muted"}`}
                                ></span>
                                <span class="rail-ops-label">
                                    {daemonStatus === "running"
                                        ? "Daemon running"
                                        : daemonStatus === "stale"
                                          ? "Daemon stale"
                                          : daemonStatus === "down"
                                            ? "Daemon down"
                                            : "Daemon unknown"}
                                </span>
                            </div>
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
                            {mtdSpend !== undefined ? (
                                <div class="rail-ops-mtd meta-mono">
                                    ${mtdSpend.toFixed(2)} MTD
                                </div>
                            ) : null}
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
