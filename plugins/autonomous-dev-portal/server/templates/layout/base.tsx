// SPEC-013-3-03 §BaseLayout — HTML5 shell with HTMX integration.
//
// CSP-compatible by construction:
//   - no inline <script> blocks (HTMX is loaded from /static/htmx.min.js)
//   - no inline style="..." attributes
//   - no on* event handlers
// CSS comes from /static/portal.css (asset serving in PLAN-013-4).
// The defer attribute on the HTMX <script> ensures it initialises after
// DOM parse, which matches HTMX's documented requirements.
//
// SPEC-034-2-05 §Voice/copy sweep — visible chrome strings (page <title>
// "autonomous-dev portal" and footer "autonomous-dev") are sentence case;
// no exclamation marks; no emoji; no per-template copy lives here.
//
// SPEC-014-2-04 §Nonce Helper — every <script> tag carries the per-request
// CSP nonce supplied by `cspMiddleware` and threaded through the renderer
// via the `cspNonce` prop. The nonce is mandatory in production: an
// inline-or-external script without it is blocked by the policy and emits
// a violation report. Ship the empty string when CSP is disabled (tests).
//
// SPEC-034-1-06 §Token & theme integration —
//   1. /static/design-tokens.css MUST be the FIRST stylesheet so CSS
//      variables are defined before any consumer references them.
//   2. A FOUC-prevention IIFE runs synchronously at the top of <head>
//      to set <html data-theme="..."> from localStorage BEFORE first
//      paint, eliminating the light→dark flash on theme-flagged refresh.
//   3. /static/theme-toggle.js (SPEC-034-1-05) is loaded `defer` after
//      the IIFE when the asset is present.

import { asset } from "../../lib/plugin-version";
import type { FC } from "hono/jsx";

import { Navigation } from "../fragments/navigation";

/**
 * SPEC-034-1-06 — FOUC-prevention IIFE.
 *
 * Runs synchronously in <head> to apply the persisted theme to
 * `<html data-theme>` before first paint. Wrapped in try/catch because
 * `localStorage` access throws in some sandboxed contexts (e.g. when
 * cookies/storage are blocked); we silently fall back to "light".
 */
const FOUC_PREVENTION_IIFE =
    "(function(){var t;try{t=localStorage.getItem('portal-theme')}catch(e){}" +
    "document.documentElement.dataset.theme=t==='dark'?'dark':'light';})();";

interface Props {
    activePath: string;
    /** SPEC-014-2-04 — per-request CSP nonce. Empty string disables (tests). */
    cspNonce?: string;
    children?: unknown;
}

/**
 * @deprecated SPEC-035-1-05 — replaced by `ShellLayout`
 *   (`server/components/shell.tsx`). Removed in TDD-018-C; replaced by
 *   ShellLayout / RailNav / RailOpsBar. Retained transitionally as a
 *   fallback so reverting the rollout is a one-line import swap.
 */
export const BaseLayout: FC<Props> = ({ activePath, cspNonce, children }) => (
    <html lang="en" data-theme="light">
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
                nonce={cspNonce ?? ""}
                dangerouslySetInnerHTML={{ __html: FOUC_PREVENTION_IIFE }}
            ></script>
            {/* SPEC-034-1-06 AC-01/02/03 — design-tokens.css is the FIRST
                stylesheet; portal.css consumes its CSS variables. */}
            <link rel="stylesheet" href={asset("/static/design-tokens.css")} />
            <link rel="stylesheet" href={asset("/static/portal.css")} />
            <script
                src={asset("/static/htmx.min.js")}
                defer
                nonce={cspNonce ?? ""}
            ></script>
        </head>
        <body>
            <header>
                <Navigation activePath={activePath} />
            </header>
            <main id="main">{children}</main>
            <footer>autonomous-dev</footer>
        </body>
    </html>
);
