# PLAN-013-3: HTTP Routing + HTMX Templates + Page Shells

## Metadata
- **Parent TDD**: TDD-013-portal-server-foundation
- **Estimated effort**: 3-4 days
- **Dependencies**: ["PLAN-013-2"]
- **Blocked by**: []
- **Priority**: P0

## Objective
Implement all 9 page routes per TDD-013 §7 (`/`, `/repo/:repo/request/:id`, `/approvals`, `/settings`, `/costs`, `/logs`, `/ops`, `/audit`, `/health`); Hono JSX layout with HTMX integration; shared fragment templates; route handler skeletons supporting both full-page and HTMX-fragment responses. Live data integration is deferred to PLAN-015.

## Scope
### In Scope
- Base layout component (`server/templates/layout/base.tsx`) with HTMX script tag, CSP-compatible structure, navigation, daemon-status indicator
- Navigation component (`server/templates/fragments/navigation.tsx`) with active-state highlighting and kill-switch indicator
- Daemon status component reading `~/.autonomous-dev/heartbeat.json` and classifying fresh (<60s) / stale (60-300s) / dead (>300s)
- Fragment templates: `repo-card.tsx`, `request-timeline.tsx`, `approval-item.tsx`, `cost-chart.tsx`, `audit-row.tsx`
- Route handlers (skeletons returning stubbed data, no live integration yet) for all 9 routes
- HTMX request detection middleware (Accept header + `HX-Request` header) → routes return fragment or full page accordingly
- 404 handler with HTMX-aware response
- Hono JSX templating decision documented

### Out of Scope
- Live data via SSE (PLAN-015-*)
- Settings mutation endpoints (PLAN-015-*)
- Approval gate POST endpoints (PLAN-015-*)
- Cost computation logic (PLAN-015-*)
- Log streaming (PLAN-015-*)
- All security middleware (PLAN-014-*)
- Static asset serving (PLAN-013-4)

## Tasks

1. **Implement BaseLayout component** -- HTML5 shell with `<head>` (meta tags, CSP-compatible), `<body>` containing navigation + main + footer; loads HTMX from `/static/htmx.min.js`.
   - Files: `server/templates/layout/base.tsx` (new)
   - Acceptance: renders complete HTML5 doc; semantic structure (header/main/footer); accepts children prop; integrates Navigation + DaemonStatus; CSP-compatible (no inline scripts).
   - Effort: 4h

2. **Implement Navigation component** -- Site nav with sections (Dashboard, Approvals, Settings, Costs, Logs, Ops, Audit); active-state by current path; kill-switch status indicator.
   - Files: `server/templates/fragments/navigation.tsx` (new), `server/lib/daemon-status.ts` (new)
   - Acceptance: renders nav menu; active item highlighted; reads heartbeat for daemon state; HTMX `hx-get="/api/daemon-status" hx-trigger="every 30s"` for live update; mobile-responsive.
   - Effort: 5h

3. **Implement DaemonStatus reader** -- Lib that reads `heartbeat.json` and classifies status.
   - Files: `server/lib/daemon-status.ts`
   - Acceptance: reads heartbeat; returns `{status, last_seen, pid, active_requests, kill_switch_active}`; classifies fresh/stale/dead; handles missing file (status=dead); no exceptions thrown.
   - Effort: 2h

4. **Implement RepoCard fragment** -- Dashboard card showing repo name, active request count, last activity, monthly cost, attention badge.
   - Files: `server/templates/fragments/repo-card.tsx` (new)
   - Acceptance: renders all fields; attention badge when approvals pending; HTMX update attrs; click navigates to repo detail; responsive grid placement.
   - Effort: 3h

5. **Implement RequestTimeline fragment** -- Vertical timeline of phase history with status, timestamps, agent assignment, action buttons.
   - Files: `server/templates/fragments/request-timeline.tsx` (new)
   - Acceptance: chronological order; phase status indicators (pending/in-progress/complete/failed); relative timestamps; collapsible details per phase; action buttons with HTMX POST attrs (handlers in PLAN-015).
   - Effort: 4h

6. **Implement ApprovalItem fragment** -- Approval queue row with risk indicator, repo context, action buttons.
   - Files: `server/templates/fragments/approval-item.tsx` (new)
   - Acceptance: renders approval summary; risk-level styling (low/med/high); HTMX confirm pattern for actions; cost-impact display for high-value items.
   - Effort: 3h

7. **Implement CostChart fragment** -- SVG-based chart for daily/weekly/monthly cost views.
   - Files: `server/templates/fragments/cost-chart.tsx` (new), `server/lib/chart-utils.ts` (new)
   - Acceptance: server-rendered SVG; daily/weekly/monthly aggregation; legend + budget threshold indicators; responsive scaling; no JS chart library (per TDD-013 NG).
   - Effort: 5h

8. **Implement Dashboard route handler** -- `GET /` returning portfolio dashboard.
   - Files: `server/routes/dashboard.ts` (new)
   - Acceptance: detects HTMX vs full-page request; returns RepoCard fragments for HTMX; full layout for browser; stubbed data for foundation phase; integrates daemon-status freshness check.
   - Effort: 4h

9. **Implement RequestDetail route handler** -- `GET /repo/:repo/request/:id`.
   - Files: `server/routes/request-detail.ts` (new)
   - Acceptance: parameter validation; 404 for non-existent; renders RequestTimeline; HTMX fragment vs full page detection.
   - Effort: 4h

10. **Implement ApprovalQueue route handler** -- `GET /approvals`.
    - Files: `server/routes/approvals.ts` (new)
    - Acceptance: lists pending approvals (stubbed); priority-sorted (high-risk first); empty-state when none; HTMX fragment per item.
    - Effort: 3h

11. **Implement remaining route handler skeletons** -- Settings, Costs, Logs, Ops, Audit (read-only stubs; mutations in PLAN-015).
    - Files: `server/routes/{settings,costs,logs,ops,audit}.ts` (new)
    - Acceptance: each route returns stubbed data with proper layout; section structure matches TDD-013 §7; no mutation endpoints yet.
    - Effort: 8h

12. **Implement /health route** -- Health check for monitoring + uptime checks.
    - Files: `server/routes/health.ts` (new)
    - Acceptance: returns JSON `{status, daemon, components}`; HTTP 200 healthy / 503 degraded; no auth required; monitoring-friendly format.
    - Effort: 2h

13. **Implement HTMX request detection middleware** -- Centralized logic for fragment-vs-page response.
    - Files: `server/lib/response-utils.ts` (new)
    - Acceptance: detects `HX-Request` header; centralized response wrappers; consistent fragment vs full-page handling; appropriate Content-Type.
    - Effort: 2h

14. **Implement 404 handler** -- HTMX-aware 404 response.
    - Files: `server/lib/error-handlers.ts` (new)
    - Acceptance: 404 page for browser; 404 fragment for HTMX; nav still rendered; helpful "where to go" links.
    - Effort: 1h

15. **Write template + route tests** -- Snapshot tests for templates; route handler response shape validation.
    - Files: `tests/templates/*.test.ts`, `tests/routes/*.test.ts` (new)
    - Acceptance: snapshot tests for all 5 fragments + base layout; route handlers return correct content type and HTMX-aware responses; mock heartbeat data; 404 path covered.
    - Effort: 6h

## Test Plan

- **Snapshot:** all layouts and fragments with mock data
- **Composition:** layout + fragments integrate correctly
- **Route handlers:** fragment vs full-page response shape validation per route
- **HTMX detection:** correct response type based on `HX-Request` header
- **Error states:** 404 path; daemon-down banner appears when heartbeat stale
- **Browser snapshot:** Playwright visit each route, capture screenshots

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SVG chart complexity without JS library | High | Medium | Start with simple bars; defer complex charts to Phase 2; HTML table fallback |
| Fragment vs full-page logic inconsistency | Medium | Medium | Centralize detection in response-utils.ts; test extensively |
| Template performance with large datasets | Medium | Low | Pagination; lazy loading; defer optimization until measured |
| File system access for heartbeat | Low | Low | Proper error handling; missing file → status=dead |

## Acceptance Criteria

- [ ] All 9 routes registered and return correct response based on HTMX detection
- [ ] BaseLayout renders complete HTML5 with HTMX integration
- [ ] Navigation shows active state and daemon status
- [ ] All 5 fragments render correctly with mock data
- [ ] Daemon status classifier (fresh/stale/dead) works on test heartbeat data
- [ ] 404 handler returns HTMX-aware response
- [ ] /health returns 200/503 + JSON
- [ ] Snapshot tests pass for all templates
- [ ] Route handler response shape validation tests pass
- [ ] No TypeScript errors; CSP-compatible (no inline scripts)
