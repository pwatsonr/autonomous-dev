# SPEC-013-3-03: Server-Side Template Engine + Layout/Partial Structure

## Metadata
- **Parent Plan**: PLAN-013-3
- **Tasks Covered**: Task 1 (BaseLayout), Task 2 (Navigation), Task 3 (DaemonStatus), Tasks 4-7 (RepoCard, RequestTimeline, ApprovalItem, CostChart fragments), implicit AuditRow fragment
- **Estimated effort**: 9 hours

## Description
Establish the server-side template engine and the directory structure for the layout, page views, and reusable fragments referenced by SPEC-013-3-02. PLAN-013-3 commits to **Hono JSX** as the engine (per the plan's "Hono JSX templating decision documented" deliverable); this spec confirms that decision and rejects external engines like `eta` or `nunjucks` to keep the dependency graph minimal and avoid a second renderer alongside React-Hono. Implement `renderFullPage` and `renderFragment` against TSX components, the base layout with HTMX integration, the navigation with active-state highlighting, and all five fragments listed in PLAN-013-3 plus the AuditRow fragment.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/templates/index.ts` | Create | `renderFullPage`, `renderFragment` dispatchers |
| `server/templates/layout/base.tsx` | Create | HTML5 shell + HTMX script tag |
| `server/templates/fragments/navigation.tsx` | Create | Site nav with active-state |
| `server/templates/fragments/daemon-status-pill.tsx` | Create | Status pill consuming `DaemonStatus` |
| `server/templates/fragments/repo-card.tsx` | Create | Dashboard repo summary card |
| `server/templates/fragments/request-timeline.tsx` | Create | Vertical phase timeline |
| `server/templates/fragments/approval-item.tsx` | Create | Approval queue row |
| `server/templates/fragments/cost-chart.tsx` | Create | SVG cost chart |
| `server/templates/fragments/audit-row.tsx` | Create | Audit log row |
| `server/templates/views/{dashboard,request-detail,approvals,settings,costs,logs,ops,audit,404,500}.tsx` | Create | Page-level view components, one per `ViewName` |
| `server/lib/daemon-status.ts` | Create | `readDaemonStatus()` reading `~/.autonomous-dev/heartbeat.json` |
| `server/lib/chart-utils.ts` | Create | Numeric helpers for `cost-chart.tsx` |
| `package.json` | Modify | Confirm `hono/jsx` present; add `tsx`/JSX compile config |
| `tsconfig.json` | Modify | `"jsx": "react-jsx"`, `"jsxImportSource": "hono/jsx"` |

## Implementation Details

### Engine Decision

- **Chosen:** Hono JSX (`hono/jsx`) — server-side TSX compiled to strings.
- **Rejected:** `eta`, `nunjucks`, `handlebars`, `pug`. Rationale: Hono is already a dependency; adding a second engine doubles the surface area, splits component conventions, and forces context-marshalling between TS types and a string-template DSL. Hono JSX gives us type-checked props end to end.
- The decision MUST be referenced in the project ADR log (deferred — note in code comment at `server/templates/index.ts` head).

### Render Dispatchers

```ts
import type { ViewName, RenderProps } from "../types/render";
import { BaseLayout } from "./layout/base";
import * as views from "./views";

export async function renderFullPage<V extends ViewName>(
  view: V, props: RenderProps[V],
): Promise<string> {
  const View = views[view];
  return "<!doctype html>" + (
    <BaseLayout activePath={(props as any).path ?? viewToPath(view)}>
      <View {...props as any} />
    </BaseLayout>
  ).toString();
}

export async function renderFragment<V extends ViewName>(
  view: V, props: RenderProps[V],
): Promise<string> {
  const View = views[view];
  return (<View {...props as any} />).toString();
}
```

- Both functions return a string; Hono's JSX runtime converts elements to strings via `.toString()`.
- `renderFullPage` MUST prepend `<!doctype html>` so browsers don't trigger quirks mode.
- `renderFragment` MUST NOT include the doctype, layout, navigation, or `<head>`.

### `BaseLayout` Component

```tsx
export const BaseLayout = ({ activePath, children }: { activePath: string; children: any }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>autonomous-dev portal</title>
      <link rel="stylesheet" href="/static/portal.css" />
      <script src="/static/htmx.min.js" defer></script>
    </head>
    <body>
      <header><Navigation activePath={activePath} /></header>
      <main id="main">{children}</main>
      <footer>autonomous-dev</footer>
    </body>
  </html>
);
```

- MUST load HTMX from `/static/htmx.min.js` (asset serving belongs to PLAN-013-4; this spec only references the path).
- MUST be CSP-compatible: no inline `<script>`, no inline `style="..."` on interactive elements, no `onclick` attributes. CSS lives in `/static/portal.css` (created in PLAN-013-4).
- The `defer` attribute on the HTMX script MUST be present so HTMX initializes after DOM parse.

### `Navigation` Component

- Renders an `<ul>` with these items in order: Dashboard (`/`), Approvals (`/approvals`), Settings (`/settings`), Costs (`/costs`), Logs (`/logs`), Ops (`/ops`), Audit (`/audit`).
- The item whose `href` matches `activePath` MUST receive `aria-current="page"` and a CSS class `active`.
- Includes a `<DaemonStatusPill>` that polls via `hx-get="/api/daemon-status" hx-trigger="every 30s" hx-swap="outerHTML"`.
- Mobile responsiveness is a CSS concern (PLAN-013-4); this spec only ensures semantic markup (proper landmarks, no overflow-only solutions).

### `DaemonStatus` Reader

```ts
export interface DaemonStatus {
  status: "fresh" | "stale" | "dead";
  last_seen: string | null;     // ISO8601
  pid: number | null;
  active_requests: number;
  kill_switch_active: boolean;
}
export async function readDaemonStatus(): Promise<DaemonStatus> { /* ... */ }
```

- Path: `~/.autonomous-dev/heartbeat.json` (resolved via `os.homedir()`).
- Classification:
  - `fresh` if `now - last_seen < 60_000` ms
  - `stale` if `60_000 <= now - last_seen < 300_000` ms
  - `dead` otherwise (including: file missing, parse error, `last_seen` missing or in the future).
- MUST NOT throw. Any I/O or parse error MUST resolve to `{status:"dead", last_seen:null, pid:null, active_requests:0, kill_switch_active:false}`.
- MUST use `fs/promises.readFile` (no sync I/O on the request path).

### Fragment Components

Each fragment is a pure function of its props, server-rendered, no client state.

- **RepoCard** (`{repo, activeRequests, lastActivity, monthlyCostUsd, attentionCount}`): card with the four fields and an "attention" badge when `attentionCount > 0`. Click target: `<a href="/repo/{repo}">`. HTMX self-refresh attrs: `hx-get="/repo/{repo}/card" hx-trigger="every 30s" hx-swap="outerHTML"` (endpoint defined in PLAN-015).
- **RequestTimeline** (`{phases: Phase[]}`): `<ol>` with one `<li>` per phase. Status icon classes: `pending`, `in-progress`, `complete`, `failed`. Each entry includes a relative timestamp (`<time datetime="...">`), the assigned agent, and a `<details>` element for expandable detail. Action buttons emit `hx-post="/api/requests/{id}/action"` with `hx-confirm` per action.
- **ApprovalItem** (`{id, summary, riskLevel, repo, costImpactUsd, actions}`): row with risk-level CSS class (`low|med|high`), summary text, repo context. Action buttons MUST use `hx-confirm="..."` for irreversible actions and surface `costImpactUsd` when `riskLevel === "high"`.
- **CostChart** (`{series: {label,value}[], budgetUsd}`): inline `<svg>` rendered server-side. No JS chart library. MUST include axis labels, a budget threshold line when `budgetUsd > 0`, and a `<title>` element for accessibility. Width is controlled via `viewBox` (responsive).
- **AuditRow** (`{ts, actor, action, target, result}`): `<tr>` with five `<td>`s; result class is `ok` or `fail`.

### `chart-utils.ts`

Numeric helpers: `niceTickStep(min,max,n)`, `scaleLinear(domain,range)`, `formatUsd(value)`. Pure functions, no DOM.

## Acceptance Criteria

- [ ] `tsconfig.json` sets `jsx: "react-jsx"` and `jsxImportSource: "hono/jsx"`; `tsc --noEmit` passes
- [ ] `renderFullPage("dashboard", props)` output starts with `<!doctype html>` and contains `<script src="/static/htmx.min.js" defer>`
- [ ] `renderFragment("dashboard", props)` output does NOT contain `<!doctype>`, `<html`, `<head`, or `<nav` (verified by string assertion)
- [ ] `BaseLayout` contains zero inline `<script>` blocks and zero `onclick=` attributes (CSP check)
- [ ] `Navigation` marks the matching item with `aria-current="page"` and class `active` for each of the seven nav paths
- [ ] `DaemonStatusPill` includes `hx-get="/api/daemon-status"` and `hx-trigger="every 30s"`
- [ ] `readDaemonStatus()` returns `status:"fresh"` when `last_seen` is 5s ago
- [ ] `readDaemonStatus()` returns `status:"stale"` when `last_seen` is 120s ago
- [ ] `readDaemonStatus()` returns `status:"dead"` when `last_seen` is 600s ago
- [ ] `readDaemonStatus()` returns `status:"dead"` when heartbeat.json is missing (no exception thrown)
- [ ] `readDaemonStatus()` returns `status:"dead"` when heartbeat.json is malformed JSON (no exception thrown)
- [ ] All five fragments render correctly with stub props (snapshot tests in SPEC-013-3-04)
- [ ] `CostChart` renders SVG without referencing any JS chart library
- [ ] No fragment imports from `views/`; no view imports from another view (verified by grep)

## Dependencies

- `hono/jsx` runtime (already a transitive dep of Hono).
- Node.js `fs/promises` and `os` (stdlib).
- SPEC-013-3-02 consumes the exports `renderFullPage`/`renderFragment` from this spec.
- SPEC-013-3-01 consumes the view names registered in `views/index.ts`.

## Notes

- The plan instructs us to "document the Hono JSX templating decision"; this spec's "Engine Decision" section is that documentation. A separate ADR may be created later, but is not required for code-complete.
- The user prompt mentioned `eta` as an alternative — explicitly rejected here to avoid running two template engines in parallel. If a future requirement (e.g., end-user template authoring) demands a string-DSL engine, a follow-up plan can revisit this.
- Tailwind/utility CSS is intentionally not introduced; CSS lives in a single `portal.css` (PLAN-013-4) and templates use semantic class names (`active`, `risk-high`, `status-fresh`).
- All components MUST be pure (no module-level mutation). This keeps snapshot tests deterministic.
- The `cost-chart` SVG is intentionally simple in this phase — bar chart, single series. Multi-series and zoom interactions are deferred.
