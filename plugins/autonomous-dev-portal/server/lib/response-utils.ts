// SPEC-013-3-02 §HTMX Request Detection & RenderPage.
//
// Single point of HTMX detection. All page handlers in `server/routes/`
// call `renderPage(c, view, props)`; this module decides whether to
// emit a full HTML document or a fragment based on the `HX-Request`
// header (with `HX-Boosted` treated identically).
//
// The detection contract is intentionally narrow:
//   - Only the literal string `"true"` (lowercase) counts.
//   - Header lookup is case-insensitive (handled by Hono).
//   - Accept headers, query strings, and cookies are NOT consulted.
//
// SPEC-013-3-03 owns the templates we delegate to; this file owns only
// the HTTP/header concerns.

import type { Context } from "hono";

import { renderFragment, renderFullPage } from "../templates";
import type { RenderProps, ViewName } from "../types/render";

const HX_REQUEST = "HX-Request";
const HX_BOOSTED = "HX-Boosted";

/**
 * Returns `true` exactly when HTMX has marked the inbound request as
 * either an `hx-*` triggered fetch (`HX-Request: true`) or a boosted
 * navigation (`HX-Boosted: true`). Both produce fragment responses so
 * HTMX can swap them into the existing DOM without re-emitting layout
 * chrome.
 */
export function isHtmxRequest(c: Context): boolean {
    return (
        c.req.header(HX_REQUEST) === "true" ||
        c.req.header(HX_BOOSTED) === "true"
    );
}

/**
 * Renders `view` with `props` and returns a 200 HTML response. Picks
 * full-page vs fragment based on `isHtmxRequest`. Caching headers are
 * intentionally NOT set here; PLAN-014 owns the cache strategy.
 *
 * SPEC-014-2-04 — the per-request CSP nonce is read off the context and
 * threaded into the layout so every `<script>` tag carries it.
 */
export async function renderPage<V extends ViewName>(
    c: Context,
    view: V,
    props: RenderProps[V],
): Promise<Response> {
    const html = isHtmxRequest(c)
        ? await renderFragment(view, props)
        : await renderFullPage(view, props, undefined, c.get("cspNonce") ?? "");
    return c.html(html, 200);
}

/**
 * 404 helper used by both `app.notFound(...)` and individual route
 * handlers (e.g. request-detail when a stub is missing). Echoes the
 * requested path so users see what was missing without leaking any
 * server-side state.
 */
export async function notFound(c: Context): Promise<Response> {
    const props: RenderProps["404"] = { path: c.req.path };
    const html = isHtmxRequest(c)
        ? await renderFragment("404", props)
        : await renderFullPage("404", props, undefined, c.get("cspNonce") ?? "");
    return c.html(html, 404);
}
