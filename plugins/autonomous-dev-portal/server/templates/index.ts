// SPEC-013-3-02 §RenderPage — placeholder template dispatcher.
//
// Spec 02 needs `renderFullPage` and `renderFragment` to exist so the
// HTMX-aware helpers in `server/lib/response-utils.ts` can be wired
// correctly. The real JSX-backed implementation lands in SPEC-013-3-03,
// which replaces both functions with template-driven output.
//
// Until then we emit minimal HTML strings that:
//   - include `<!doctype html>` and a `<nav>` for full-page renders,
//     so the SPEC-013-3-04 routing tests can distinguish full from
//     fragment by string assertion.
//   - omit doctype/nav for fragments.

import type { RenderProps, ViewName } from "../types/render";

function escape(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function viewBody<V extends ViewName>(view: V, props: RenderProps[V]): string {
    return (
        `<main id="main">` +
        `<h1>${escape(view)}</h1>` +
        `<pre>${escape(JSON.stringify(props))}</pre>` +
        `</main>`
    );
}

// TODO(SPEC-013-3-03): Replace with JSX-rendered BaseLayout + view component.
export async function renderFullPage<V extends ViewName>(
    view: V,
    props: RenderProps[V],
): Promise<string> {
    return (
        `<!doctype html>` +
        `<html lang="en"><head><meta charset="utf-8" />` +
        `<title>autonomous-dev portal</title></head>` +
        `<body><header><nav></nav></header>` +
        viewBody(view, props) +
        `</body></html>`
    );
}

// TODO(SPEC-013-3-03): Replace with JSX-rendered view component only.
export async function renderFragment<V extends ViewName>(
    view: V,
    props: RenderProps[V],
): Promise<string> {
    return viewBody(view, props);
}
