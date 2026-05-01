// SPEC-013-3-01 §Handler Contract — placeholder shim.
//
// This file is intentionally minimal in the Spec 01 commit: it provides the
// renderPage / notFound surface that route handlers must call. The real
// HTMX-aware implementation arrives in SPEC-013-3-02 and the actual
// templates in SPEC-013-3-03.
//
// Acceptance criteria covered here for Spec 01:
//   - Page handlers delegate rendering to renderPage(c, view, props)
//   - Handlers do NOT inspect HX-Request directly (only this module may)
//
// SPEC-013-3-02 will replace the bodies of the helpers below with the real
// fragment-vs-full-page dispatch based on the HX-Request header.

import type { Context } from "hono";

import type { RenderProps, ViewName } from "../types/render";

// TODO(SPEC-013-3-02): Replace with the real HTMX-aware implementation
// dispatching to renderFullPage / renderFragment from SPEC-013-3-03.
export async function renderPage<V extends ViewName>(
    c: Context,
    view: V,
    props: RenderProps[V],
): Promise<Response> {
    // Placeholder: emit a tiny HTML document that includes the view name and
    // a JSON dump of the props so the page is identifiable during the brief
    // window between Spec 01 and Spec 02 commits.
    const body =
        `<!doctype html><html><head><title>${escape(view)}</title></head>` +
        `<body><h1>${escape(view)}</h1>` +
        `<pre>${escape(JSON.stringify(props))}</pre></body></html>`;
    return c.html(body, 200);
}

// TODO(SPEC-013-3-02): Replace with the HTMX-aware 404 helper.
export function notFound(c: Context): Response | Promise<Response> {
    const path = c.req.path;
    const body =
        `<!doctype html><html><head><title>Not Found</title></head>` +
        `<body><h1>404 Not Found</h1>` +
        `<p>No handler for <code>${escape(path)}</code></p></body></html>`;
    return c.html(body, 404);
}

// Local escape helper. The real implementation in SPEC-013-3-03 uses Hono
// JSX which auto-escapes; this placeholder needs its own helper because
// the strings here are concatenated by hand.
function escape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
