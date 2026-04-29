# SPEC-013-3-02: HTMX-Aware Template Rendering

## Metadata
- **Parent Plan**: PLAN-013-3
- **Tasks Covered**: Task 13 (HTMX request detection middleware), Task 14 (404 handler)
- **Estimated effort**: 4 hours

## Description
Implement the centralized rendering helpers that decide between full-page and fragment responses based on the `HX-Request` request header. All page handlers (SPEC-013-3-01) call `renderPage(c, view, props)` and `notFound(c)`; this module is the single point where HTMX detection lives. The helpers MUST set correct `Content-Type` headers, invoke the template engine from SPEC-013-3-03, and short-circuit cleanly when `HX-Request: true` is present so HTMX swaps receive a fragment without the full layout chrome.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/lib/response-utils.ts` | Create | `isHtmxRequest`, `renderPage`, `renderFragment` |
| `server/lib/error-handlers.ts` | Create | `notFound`, `serverError` (HTMX-aware) |
| `server/types/render.ts` | Create | `RenderProps`, `ViewName` discriminated union |
| `server/app.ts` | Modify | Register `app.notFound(notFound)` and `app.onError(serverError)` |

## Implementation Details

### HTMX Request Detection

```ts
export function isHtmxRequest(c: Context): boolean {
  return c.req.header("HX-Request") === "true";
}
```

- The detection MUST be a simple equality check on the raw header value.
- Header names in Hono are case-insensitive (handled by the framework); pass them as written by HTMX.
- MUST NOT consider `Accept` headers, query strings, or cookies — `HX-Request` is the sole signal.
- HTMX's `HX-Boosted` header MUST be treated identically to `HX-Request` (same fragment behavior). If either is `"true"`, treat as HTMX.

### `renderPage(c, view, props)`

```ts
export async function renderPage<V extends ViewName>(
  c: Context,
  view: V,
  props: RenderProps[V],
): Promise<Response> {
  const html = isHtmxRequest(c)
    ? await renderFragment(view, props)
    : await renderFullPage(view, props);
  return c.html(html, 200);
}
```

- `renderFragment(view, props)` renders the inner content template only (no `<html>`, `<head>`, navigation).
- `renderFullPage(view, props)` wraps the same content in the base layout (SPEC-013-3-03).
- MUST set `Content-Type: text/html; charset=utf-8` (Hono's `c.html` does this).
- MUST return HTTP 200 on success.
- MUST NOT cache responses (no `Cache-Control` set here; defer caching strategy to PLAN-014).

### `notFound(c)` Handler

```ts
export function notFound(c: Context): Response | Promise<Response> {
  const props = { path: c.req.path };
  return isHtmxRequest(c)
    ? c.html(renderFragment("404", props), 404)
    : c.html(renderFullPage("404", props), 404);
}
```

- MUST return HTTP 404.
- For HTMX: returns the bare 404 fragment (no navigation re-render — HTMX swaps target the requested element).
- For full page: returns the layout-wrapped 404 view, which MUST include the navigation (so users have a way out).
- MUST be wired via `app.notFound(notFound)` in `server/app.ts`.

### `serverError(err, c)` Handler

```ts
export function serverError(err: Error, c: Context): Response {
  c.get("logger")?.error({ err, path: c.req.path }, "request failed");
  const props = { message: "An unexpected error occurred." }; // never leak err.message
  return isHtmxRequest(c)
    ? c.html(renderFragment("500", props), 500)
    : c.html(renderFullPage("500", props), 500);
}
```

- MUST log the original error via the request-scoped logger if present (PLAN-013-2 contract).
- MUST NOT include `err.message` or stack traces in the response body (info-leak prevention; PLAN-014 hardens further).
- MUST return HTTP 500.
- MUST be wired via `app.onError(serverError)` in `server/app.ts`.

### `RenderProps` Union

```ts
export type ViewName =
  | "dashboard" | "request-detail" | "approvals"
  | "settings" | "costs" | "logs" | "ops" | "audit"
  | "404" | "500";

export interface RenderProps {
  dashboard:       { data: DashboardData };
  "request-detail": { request: RequestRecord };
  approvals:       { items: ApprovalItem[] };
  settings:        { config: SettingsView };
  costs:           { series: CostSeries };
  logs:            { lines: LogLine[] };
  ops:             { health: OpsHealth };
  audit:           { rows: AuditRow[] };
  "404":           { path: string };
  "500":           { message: string };
}
```

- The discriminated union MUST be exhaustive — adding a new view is a compile-time fanout to `renderFragment`/`renderFullPage`.
- All `*Data`/`*Record`/`*Item` types are imported from the stubs in SPEC-013-3-01; they may evolve in PLAN-015.

## Acceptance Criteria

- [ ] `isHtmxRequest(c)` returns `true` only when `HX-Request: true` (case-insensitive header name) is present
- [ ] `isHtmxRequest(c)` returns `true` when only `HX-Boosted: true` is present
- [ ] `isHtmxRequest(c)` returns `false` for `HX-Request: false`, missing header, empty string, or any other value
- [ ] `renderPage(c, view, props)` calls `renderFragment` exactly when HTMX, otherwise `renderFullPage` (verified via spy)
- [ ] `renderPage` always returns HTTP 200 with `Content-Type: text/html; charset=utf-8`
- [ ] `notFound(c)` returns HTTP 404 for both fragment and full-page paths
- [ ] `notFound(c)` body includes the requested `path` so users can see what was missing
- [ ] `serverError(err, c)` returns HTTP 500 and never echoes `err.message` into the body (verified by snapshot)
- [ ] `serverError(err, c)` logs the error via `c.get("logger")` when available; does not throw if logger absent
- [ ] `app.notFound` and `app.onError` are wired in `server/app.ts`
- [ ] No page handler in `server/routes/*.ts` reads `HX-Request` directly (grep check; only `response-utils.ts` and `error-handlers.ts` may reference it)
- [ ] TypeScript strict mode passes; `ViewName` and `RenderProps` are exhaustive

## Dependencies

- PLAN-013-2 must export the `Context` type and configure the request-scoped logger on `c.set("logger", ...)`.
- SPEC-013-3-03 provides `renderFragment(view, props)` and `renderFullPage(view, props)` against the named views above.
- SPEC-013-3-04 contains the conformance tests for the eight HTMX header scenarios documented above.

## Notes

- The split between `renderFragment` and `renderFullPage` is intentional: HTMX swaps target a specific element (`hx-target`), and re-sending the navigation/layout would either break the swap or duplicate DOM.
- `HX-Boosted` is HTMX's "progressive enhancement" header (full-page-link click via fetch). Treating it the same as `HX-Request` keeps boosted navigation snappy without needing a separate code path.
- 500-handler must be paranoid about leaking internals — the spec deliberately uses a constant message and pushes detail to the logger.
- Caching headers are intentionally out of scope; PLAN-014 owns the security/caching middleware.
