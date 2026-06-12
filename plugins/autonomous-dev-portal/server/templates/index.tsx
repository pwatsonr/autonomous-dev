// SPEC-013-3-02 §RenderPage — template dispatcher.
// SPEC-034-2-05 — voice/copy sweep: dispatcher contains no user-facing
// copy; included in the sweep for AC-01 file coverage.
// SPEC-035-1-05 — wraps views in `<ShellLayout>` (replacing legacy
// `<BaseLayout>`) and threads the `portal-theme` cookie value down so
// the SSR `<html data-theme>` matches the client-side IIFE before paint.
//
// Maps a `ViewName` to its JSX view component and renders either the
// full HTML document (wrapped in `<ShellLayout>`) or a fragment (the
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

import type { Theme } from "../lib/theme";
import { getThemeFromCookie } from "../lib/theme";
import {
    deriveShellRailState,
    type ShellRailState,
} from "../lib/shell-rail-state";
import type { RenderProps, ViewName } from "../types/render";
import { ShellLayout } from "../components/shell";
import { AgentsView } from "./views/agents";
import { ApprovalsView } from "./views/approvals";
import { AuditView } from "./views/audit";
import { CostsView } from "./views/costs";
import { DashboardView } from "./views/dashboard";
import { LogsView } from "./views/logs";
import { NotFoundView } from "./views/404";
import { OpsView } from "./views/ops";
import { ReposView } from "./views/repos";
import { RequestDetailView } from "./views/request-detail";
import { RequestsView } from "./views/requests";
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
        case "requests":
            return (
                <RequestsView {...(props as RenderProps["requests"])} />
            );
        case "approvals":
            return (
                <ApprovalsView {...(props as RenderProps["approvals"])} />
            );
        case "settings":
            return (
                <SettingsView {...(props as RenderProps["settings"])} />
            );
        case "costs": {
            const cp = props as RenderProps["costs"];
            return (
                <CostsView
                    series={cp.series}
                    projection={cp.projection}
                />
            );
        }
        case "logs":
            return <LogsView {...(props as RenderProps["logs"])} />;
        case "ops":
            return <OpsView {...(props as RenderProps["ops"])} />;
        case "audit":
            return <AuditView {...(props as RenderProps["audit"])} />;
        case "agents":
            return <AgentsView {...(props as RenderProps["agents"])} />;
        case "repos":
            return <ReposView {...(props as RenderProps["repos"])} />;
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
        case "requests":
            return "/requests";
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
        case "agents":
            return "/agents";
        case "repos":
            return "/repos";
        case "dashboard":
        case "request-detail":
        case "404":
        case "500":
        default:
            return "/";
    }
}

/**
 * Full-page render: wraps the view in `<ShellLayout>` and returns the
 * complete `<!doctype html>...</html>` string suitable for `c.html(...)`.
 *
 * SPEC-035-1-05 — migrated from `BaseLayout` to `ShellLayout`. The
 * server-rendered theme is supplied by the caller (route handler) via
 * `getThemeFromCookie(c)` and threaded into the shell so the SSR HTML
 * carries the same `data-theme` the client-side IIFE will apply,
 * eliminating flash-of-unstyled-content on full-page reloads.
 *
 * @param view  the named view (matches a key in `RenderProps`)
 * @param props strictly-typed props for that view
 * @param activeOverride optional path override for the rail nav (used
 *   by `notFound` so the nav highlights the page the user attempted)
 * @param cspNonce SPEC-014-2-04 — per-request CSP nonce; threaded into
 *   every `<script>` tag in the layout. Defaults to empty string for
 *   callers without a request context (tests, error pre-render).
 * @param theme  SPEC-035-1-05 — server-rendered theme cookie value.
 *   Defaults to `"dark"` when omitted (SPEC-037-1-01 — dark-default kit
 *   baseline; tests and error pre-render get the new default for free).
 * @param shellState SPEC-037-3-05 — pre-derived rail state. When omitted,
 *   `deriveShellRailState()` is invoked to read heartbeat / cost ledger
 *   / approvals queue. Tests / fragments can pass a stub to bypass disk
 *   I/O. Homelab fields are deliberately absent from the type.
 */
export async function renderFullPage<V extends ViewName>(
    view: V,
    props: RenderProps[V],
    activeOverride?: string,
    cspNonce: string = "",
    theme: Theme = "dark",
    shellState?: ShellRailState,
    csrfToken: string = "",
): Promise<string> {
    const body = renderViewBody(view, props);
    // SPEC-037-3-05 AC-01/02 — derive once when not supplied. The helper
    // is internally fault-tolerant; a missing source yields `undefined`
    // for its fields rather than throwing, so we never need a try/catch
    // around it here.
    const resolvedShellState: ShellRailState =
        shellState ?? (await deriveShellRailState());
    const layout = (
        <ShellLayout
            activePath={activeOverride ?? activePathFor(view)}
            cspNonce={cspNonce}
            theme={theme}
            csrfToken={csrfToken}
            {...resolvedShellState}
        >
            {body}
        </ShellLayout>
    );
    const inner = await resolveJsxToString(layout);
    // ShellLayout's <html> root does not include a doctype on its own.
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
    // SPEC-037-3-05 AC-06 — let routes inject `shellState` via context
    // for request-scoped overrides (e.g. pre-computed counts in tests);
    // when absent, `renderFullPage` falls through to the disk-derivation
    // path so the default behavior remains zero-config for callers.
    const ctxShellState = c.get("shellState") as ShellRailState | undefined;
    const html = isHtmx
        ? await renderFragment(view, props)
        : await renderFullPage(
              view,
              props,
              undefined,
              c.get("cspNonce") ?? "",
              getThemeFromCookie(c),
              ctxShellState,
              (c.get("csrfToken") as string | undefined) ?? "",
          );
    // Cast to ContentfulStatusCode-compatible literal union.
    return c.html(
        html,
        status as 200 | 400 | 401 | 403 | 404 | 422 | 500 | 503,
    );
}
