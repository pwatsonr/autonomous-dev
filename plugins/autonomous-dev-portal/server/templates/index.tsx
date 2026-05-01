// SPEC-013-3-02 §RenderPage — template dispatcher.
//
// Maps a `ViewName` to its JSX view component and renders either the
// full HTML document (wrapped in `<BaseLayout>`) or a fragment (the
// view component's bare output). Page handlers in `server/routes/` call
// `renderPage(c, view, props)` from `lib/response-utils`; this module
// owns the `view -> component` mapping and `Promise<string>` resolution.
//
// SPEC-013-4-03 wires the unified `ErrorPage` for the 404 / 500 cases
// via the legacy `NotFoundView` / `ServerErrorView` view shells, which
// delegate to the same component. Other status codes (403, 422, 503)
// are handled by the new `app.onError` flow that builds a full
// `ErrorContext` and passes it directly to `<ErrorPage>` — they never
// flow through this dispatcher.

import type { Context } from "hono";

import type { RenderProps, ViewName } from "../types/render";
import { BaseLayout } from "./layout/base";
import { ApprovalsView } from "./views/approvals";
import { AuditView } from "./views/audit";
import { CostsView } from "./views/costs";
import { DashboardView } from "./views/dashboard";
import { LogsView } from "./views/logs";
import { NotFoundView } from "./views/404";
import { OpsView } from "./views/ops";
import { RequestDetailView } from "./views/request-detail";
import { ServerErrorView } from "./views/500";
import { SettingsView } from "./views/settings";

/** Renders the bare view component for the given view name + props.
 * Return type is `JSX.Element` (Hono's `HtmlEscapedString | Promise<…>`). */
function renderViewBody<V extends ViewName>(
    view: V,
    props: RenderProps[V],
): JSX.Element {
    switch (view) {
        case "dashboard":
            return (
                <DashboardView {...(props as RenderProps["dashboard"])} />
            );
        case "request-detail":
            return (
                <RequestDetailView
                    {...(props as RenderProps["request-detail"])}
                />
            );
        case "approvals":
            return (
                <ApprovalsView {...(props as RenderProps["approvals"])} />
            );
        case "settings":
            return (
                <SettingsView {...(props as RenderProps["settings"])} />
            );
        case "costs":
            return <CostsView {...(props as RenderProps["costs"])} />;
        case "logs":
            return <LogsView {...(props as RenderProps["logs"])} />;
        case "ops":
            return <OpsView {...(props as RenderProps["ops"])} />;
        case "audit":
            return <AuditView {...(props as RenderProps["audit"])} />;
        case "404":
            return <NotFoundView {...(props as RenderProps["404"])} />;
        case "500":
            return <ServerErrorView {...(props as RenderProps["500"])} />;
        default: {
            // Exhaustiveness guard. Adding a new ViewName forces a
            // compiler error here.
            const _exhaustive: never = view;
            throw new Error(`Unhandled view: ${String(_exhaustive)}`);
        }
    }
}

/**
 * Resolves a JSX node (which is `string | Promise<string>` after
 * Hono renders it) into a plain string. Hono's JSX runtime returns an
 * `HtmlEscapedString` (which already extends `String`), so this is a
 * thin coerce + await.
 */
async function resolveJsxToString(node: unknown): Promise<string> {
    const v = await Promise.resolve(node);
    if (typeof v === "string") return v;
    return String(v);
}

/**
 * Determines which path to highlight in the `<Navigation>` for a given
 * view. Page-content views map back to their canonical href; views that
 * are not in the nav (request-detail, 404, 500) collapse to "/" so the
 * Dashboard link is the natural visible target.
 */
function activePathFor(view: ViewName): string {
    switch (view) {
        case "approvals":
            return "/approvals";
        case "settings":
            return "/settings";
        case "costs":
            return "/costs";
        case "logs":
            return "/logs";
        case "ops":
            return "/ops";
        case "audit":
            return "/audit";
        case "dashboard":
        case "request-detail":
        case "404":
        case "500":
        default:
            return "/";
    }
}

/**
 * Full-page render: wraps the view in `<BaseLayout>` and returns the
 * complete `<!doctype html>...</html>` string suitable for `c.html(...)`.
 *
 * @param view  the named view (matches a key in `RenderProps`)
 * @param props strictly-typed props for that view
 * @param activeOverride optional path override for `<Navigation>` (used
 *   by `notFound` so the nav highlights the page the user attempted)
 */
export async function renderFullPage<V extends ViewName>(
    view: V,
    props: RenderProps[V],
    activeOverride?: string,
): Promise<string> {
    const body = renderViewBody(view, props);
    const layout = (
        <BaseLayout activePath={activeOverride ?? activePathFor(view)}>
            {body}
        </BaseLayout>
    );
    const inner = await resolveJsxToString(layout);
    // BaseLayout's <html> root does not include a doctype on its own.
    return `<!doctype html>${inner}`;
}

/**
 * Fragment render: emits the view component output without the layout
 * wrapper. HTMX-targeted swaps consume this directly.
 */
export async function renderFragment<V extends ViewName>(
    view: V,
    props: RenderProps[V],
): Promise<string> {
    const body = renderViewBody(view, props);
    return resolveJsxToString(body);
}

/**
 * Convenience wrapper for handlers that have a `Context` in scope and
 * want to write the rendered HTML straight into a `Response`. Mirrors
 * the contract of `renderPage` in `lib/response-utils.ts` but moved
 * here keeps the dependency direction single-flow (lib → templates).
 *
 * Currently unused — kept for parity with the spec's future direction
 * (PLAN-015 may move HTMX detection back into the dispatcher).
 */
export async function renderViewToContext<V extends ViewName>(
    c: Context,
    view: V,
    props: RenderProps[V],
    isHtmx: boolean,
    status = 200,
): Promise<Response> {
    const html = isHtmx
        ? await renderFragment(view, props)
        : await renderFullPage(view, props);
    // Cast to ContentfulStatusCode-compatible literal union.
    return c.html(
        html,
        status as 200 | 400 | 401 | 403 | 404 | 422 | 500 | 503,
    );
}
