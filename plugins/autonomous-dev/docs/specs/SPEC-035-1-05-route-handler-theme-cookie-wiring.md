# SPEC-035-1-05: Route-Handler Theme Cookie Wiring + Theme-Toggle JS Module

## Metadata
- **Parent Plan**: PLAN-035-1-layout-shell-and-brand
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (SS 6.1 theme prop wiring + SS 6.7 theme-toggle module)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-03 theme persistence)
- **Tasks Covered**: PLAN-035-1 Task 5 (theme-toggle JS module) + Task 8 (route-handler theme prop wiring) + Task 9 (atomic BaseLayout → ShellLayout migration of all 10 views)
- **Estimated effort**: 1.5 days (0.5d JS module + 0.5d route-handler wiring + 0.5d atomic view migration)
- **Dependencies**: SPEC-035-1-01 (ShellLayout exists), SPEC-035-1-02/03/04 (children render)
- **Priority**: P0 (final integration step gating the whole plan)
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Wire the SSR theme path end-to-end: ship `server/static/js/theme-toggle.js` (FOUC-prevention IIFE that reads `localStorage["portal.theme"]` before paint, sets `data-theme` on `<html>`, and writes the `portal-theme` cookie shadow); update every page route handler to read `getCookie(c, "portal-theme")` and pass `theme={cookieValue === "dark" ? "dark" : "light"}` to `ShellLayout`; atomically migrate all 10 existing views from `BaseLayout` → `ShellLayout` in a single commit and mark the deprecated layout/nav/pill `@deprecated`.

## Acceptance Criteria

- **AC-01**: `server/static/js/theme-toggle.js` exists with the exact IIFE + `DOMContentLoaded` handler from TDD-035 SS 6.7. The IIFE reads `localStorage.getItem("portal.theme")`, sets `document.documentElement.setAttribute("data-theme", stored)` if `stored` is `"light"` or `"dark"`, and writes `document.cookie = "portal-theme=<value>;path=/;max-age=31536000;SameSite=Strict"`.
- **AC-02**: The `DOMContentLoaded` click handler on `#theme-toggle`: toggles `data-theme` light↔dark, writes `localStorage["portal.theme"]`, refreshes the cookie, and swaps `.tt-track.light`/`.tt-track.dark` classes.
- **AC-03**: Every existing page route handler (Dashboard `/`, Approvals `/approvals`, Request Detail `/approvals/:id`, Costs `/costs`, Ops `/ops`, Settings `/settings`, Audit `/audit`, plus the three remaining views identified in PLAN-035-1 Task 9 = 10 total; healthz/error pages excluded) imports `getCookie` from `hono/cookie`, reads `portal-theme`, and passes the `theme` prop to `ShellLayout` (defaulting to `"light"` when cookie is absent or any value other than `"dark"`).
- **AC-04**: Single atomic commit replaces `BaseLayout` with `ShellLayout` in all 10 view templates. `grep -rn "BaseLayout" server/templates/views/` returns zero matches in non-deprecated files. Each view's `activePath` matches its route.
- **AC-05**: `BaseLayout`, `Navigation`, and `DaemonStatusPill` source files gain JSDoc `@deprecated` tags with a pointer comment "Removed in TDD-018-C; replaced by ShellLayout / RailNav / RailOpsBar."
- **AC-06**: SSR round-trip: `curl -H "Cookie: portal-theme=dark" http://localhost:<port>/` returns HTML containing `<html lang="en" data-theme="dark">`. With cookie absent, returns `data-theme="light"`. With `Cookie: portal-theme=invalid`, returns `data-theme="light"` (defensive default).
- **AC-07**: `GET /static/js/theme-toggle.js` returns 200 with `Content-Type: application/javascript` (or `text/javascript`).
- **AC-08**: First-paint flash-of-wrong-theme is not observable in a manual smoke (Chrome + Firefox + Safari): theme toggle round-trip persists across reload via both `localStorage` and `portal-theme` cookie.

## Implementation

**Files created/modified:**

1. `plugins/autonomous-dev-portal/server/static/js/theme-toggle.js` (NEW) — verbatim from TDD-035 SS 6.7.
2. `plugins/autonomous-dev-portal/server/routes/*.ts` (MODIFIED) — every page route handler reads cookie + passes `theme`.
3. `plugins/autonomous-dev-portal/server/templates/views/*.tsx` (MODIFIED) — all 10 views swap `BaseLayout` → `ShellLayout`, pass through `activePath` + ops props.
4. `plugins/autonomous-dev-portal/server/templates/layout/base.tsx` (MODIFIED) — add `@deprecated` JSDoc.
5. `plugins/autonomous-dev-portal/server/templates/fragments/navigation.tsx` (MODIFIED) — add `@deprecated` JSDoc.
6. `plugins/autonomous-dev-portal/server/templates/fragments/daemon-status-pill.tsx` (MODIFIED) — add `@deprecated` JSDoc.

**Steps:**

1. Write `theme-toggle.js` per TDD-035 SS 6.7. Verify it parses as an ES module.
2. For each page route handler, add `import { getCookie } from "hono/cookie";` then `const theme = getCookie(c, "portal-theme") === "dark" ? "dark" : "light";` and pass `theme` to the view (or directly to `ShellLayout`).
3. In a single commit: update each view template to render `<ShellLayout activePath="<route>" theme={theme} daemonStatus={...} killSwitchEngaged={...} breakerTripped={...} mtdSpend={...} gateCount={...}>{view content}</ShellLayout>`. The ops props are read from existing `StateReader` / `HeartbeatReader` / `CostReader` (no new readers).
4. Add `@deprecated` JSDoc + TDD-018-C cleanup pointer to `base.tsx`, `navigation.tsx`, `daemon-status-pill.tsx`.
5. Run the integration suite to confirm every route renders `<aside class="rail">`.

## Tests

`tests/integration/theme-cookie.test.ts`:

| ID | Assertion |
|----|-----------|
| T-01 | `GET /` with `Cookie: portal-theme=dark` returns HTML containing `data-theme="dark"` |
| T-02 | `GET /` with `Cookie: portal-theme=light` returns `data-theme="light"` |
| T-03 | `GET /` with no cookie returns `data-theme="light"` |
| T-04 | `GET /` with `Cookie: portal-theme=garbage` returns `data-theme="light"` (defensive) |
| T-05 | All 10 page routes honor the cookie identically |

`tests/integration/shell-migration.test.ts`:

| ID | Assertion |
|----|-----------|
| M-01 | Each of the 10 page routes returns 200 |
| M-02 | Each response body contains `<aside class="rail">` and `<main class="main">` |
| M-03 | `grep -rn "BaseLayout" server/templates/views/` returns zero non-deprecated matches |

`tests/integration/static-assets.test.ts`:

| ID | Assertion |
|----|-----------|
| J-01 | `GET /static/js/theme-toggle.js` returns 200 with JS content-type |

**Manual smoke** (PRD-018 NG-06 — desktop only): Chrome + Firefox + Safari — load portal, toggle theme, reload, verify persistence; verify no FOUC on cold load with `localStorage["portal.theme"]="dark"`.

## Verification

```bash
cd plugins/autonomous-dev-portal
npm test -- tests/integration/theme-cookie.test.ts tests/integration/shell-migration.test.ts tests/integration/static-assets.test.ts
grep -rn "BaseLayout" server/templates/views/   # expect zero matches
grep -rn "getCookie(c, \"portal-theme\")" server/routes/ | wc -l   # expect >= 10
node --check server/static/js/theme-toggle.js
curl -s -H "Cookie: portal-theme=dark" http://localhost:${PORT:-19281}/ | grep -o 'data-theme="dark"'
curl -s -H "Cookie: portal-theme=dark" http://localhost:${PORT:-19281}/ | grep -o 'data-theme="light"' && echo "FAIL: should be dark" || echo "OK"
```
