// SPEC-013-3-03 §BaseLayout — HTML5 shell with HTMX integration.
//
// CSP-compatible by construction:
//   - no inline <script> blocks (HTMX is loaded from /static/htmx.min.js)
//   - no inline style="..." attributes
//   - no on* event handlers
// CSS comes from /static/portal.css (asset serving in PLAN-013-4).
// The defer attribute on the HTMX <script> ensures it initialises after
// DOM parse, which matches HTMX's documented requirements.

import type { FC } from "hono/jsx";

import { Navigation } from "../fragments/navigation";

interface Props {
    activePath: string;
    children?: unknown;
}

export const BaseLayout: FC<Props> = ({ activePath, children }) => (
    <html lang="en">
        <head>
            <meta charset="utf-8" />
            <meta
                name="viewport"
                content="width=device-width, initial-scale=1"
            />
            <title>autonomous-dev portal</title>
            <link rel="stylesheet" href="/static/portal.css" />
            <script src="/static/htmx.min.js" defer></script>
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
