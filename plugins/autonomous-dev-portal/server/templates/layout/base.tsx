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
// SPEC-014-2-04 §Nonce Helper — every <script> tag carries the per-request
// CSP nonce supplied by `cspMiddleware` and threaded through the renderer
// via the `cspNonce` prop. The nonce is mandatory in production: an
// inline-or-external script without it is blocked by the policy and emits
// a violation report. Ship the empty string when CSP is disabled (tests).

import type { FC } from "hono/jsx";

import { Navigation } from "../fragments/navigation";

interface Props {
    activePath: string;
    /** SPEC-014-2-04 — per-request CSP nonce. Empty string disables (tests). */
    cspNonce?: string;
    children?: unknown;
}

export const BaseLayout: FC<Props> = ({ activePath, cspNonce, children }) => (
    <html lang="en">
        <head>
            <meta charset="utf-8" />
            <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
            />
            <title>autonomous-dev portal</title>
            <link rel="stylesheet" href="/static/portal.css" />
            <script
                src="/static/htmx.min.js"
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
