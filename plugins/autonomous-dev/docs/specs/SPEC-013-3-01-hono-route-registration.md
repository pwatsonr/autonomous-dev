# SPEC-013-3-01: Hono Route Registration for Portal Pages

## Metadata
- **Parent Plan**: PLAN-013-3
- **Tasks Covered**: Task 8 (Dashboard `GET /`), Task 9 (Request Detail `GET /repo/:repo/request/:id`), Task 10 (Approval Queue `GET /approvals`), Task 11 (Settings, Costs, Logs, Ops, Audit skeletons), Task 12 (`GET /health`)
- **Estimated effort**: 6 hours

## Description
Register all nine portal routes on the Hono application instance produced by PLAN-013-2: `/`, `/repo/:repo/request/:id`, `/approvals`, `/settings`, `/costs`, `/logs`, `/ops`, `/audit`, and `/health`. Each route handler is a skeleton that resolves stubbed data, picks a template (full page vs. fragment per SPEC-013-3-02), and returns a `Response`. Live data wiring is deferred to PLAN-015. Route handlers MUST validate path parameters, return correct HTTP status codes, and emit JSON for `/health`. The bash dispatcher and daemon are not modified by this spec.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `server/routes/dashboard.ts` | Create | `GET /` handler |
| `server/routes/request-detail.ts` | Create | `GET /repo/:repo/request/:id` handler |
| `server/routes/approvals.ts` | Create | `GET /approvals` handler |
| `server/routes/settings.ts` | Create | `GET /settings` skeleton |
| `server/routes/costs.ts` | Create | `GET /costs` skeleton |
| `server/routes/logs.ts` | Create | `GET /logs` skeleton |
| `server/routes/ops.ts` | Create | `GET /ops` skeleton |
| `server/routes/audit.ts` | Create | `GET /audit` skeleton |
| `server/routes/health.ts` | Create | `GET /health` JSON |
| `server/routes/index.ts` | Create | `registerRoutes(app: Hono)` mounts all handlers |
| `server/app.ts` | Modify | Call `registerRoutes(app)` after middleware bootstrap |

## Implementation Details

### Route Table

| Method | Path | Handler module | Path params | Stub data source |
|--------|------|----------------|-------------|------------------|
| GET | `/` | `dashboard.ts` | none | `stubs/repos.ts` |
| GET | `/repo/:repo/request/:id` | `request-detail.ts` | `repo` (slug), `id` (`REQ-\d{6}`) | `stubs/requests.ts` |
| GET | `/approvals` | `approvals.ts` | none | `stubs/approvals.ts` |
| GET | `/settings` | `settings.ts` | none | `stubs/settings.ts` |
| GET | `/costs` | `costs.ts` | none | `stubs/costs.ts` |
| GET | `/logs` | `logs.ts` | none | `stubs/logs.ts` |
| GET | `/ops` | `ops.ts` | none | `stubs/ops.ts` |
| GET | `/audit` | `audit.ts` | none | `stubs/audit.ts` |
| GET | `/health` | `health.ts` | none | `daemon-status.ts` |

### Handler Contract

Every page handler (i.e. all routes except `/health`) MUST follow this shape:

```ts
export const dashboardHandler = async (c: Context): Promise<Response> => {
  const data = await loadDashboardStub();              // stubbed in this phase
  return renderPage(c, "dashboard", { data });          // SPEC-013-3-02 helper
};
```

- `renderPage(c, view, props)` is implemented in SPEC-013-3-02 and decides full-page vs. fragment based on `HX-Request`.
- Handlers MUST NOT inspect the `HX-Request` header directly — that is the renderer's responsibility.
- Handlers MUST be registered on the Hono app via `registerRoutes(app)` (no inline `app.get(...)` in `app.ts`).

### Path Parameter Validation (`/repo/:repo/request/:id`)

In `request-detail.ts`:

1. Extract `repo` and `id` via `c.req.param("repo")` / `c.req.param("id")`.
2. Validate `repo` against `^[a-z0-9][a-z0-9-]{0,63}$` (slug). On mismatch return `notFound(c)` (404 helper from SPEC-013-3-02).
3. Validate `id` against `^REQ-[0-9]{6}$`. On mismatch return `notFound(c)`.
4. Look up the stub by `(repo, id)`. If not found return `notFound(c)`.
5. Otherwise call `renderPage(c, "request-detail", { request })`.

### `/health` Handler

```ts
export const healthHandler = async (c: Context): Promise<Response> => {
  const daemon = await readDaemonStatus();        // from server/lib/daemon-status.ts
  const healthy = daemon.status === "fresh";
  const body = {
    status: healthy ? "ok" : "degraded",
    daemon,
    components: { http: "ok", templates: "ok" },
  };
  return c.json(body, healthy ? 200 : 503);
};
```

- MUST NOT require auth (operates before auth middleware in the chain).
- MUST set `Content-Type: application/json; charset=utf-8` (Hono `c.json` does this).
- MUST NOT touch the database or spawn subprocesses; only reads `heartbeat.json`.

### `registerRoutes(app)`

```ts
export function registerRoutes(app: Hono): void {
  app.get("/", dashboardHandler);
  app.get("/repo/:repo/request/:id", requestDetailHandler);
  app.get("/approvals", approvalsHandler);
  app.get("/settings", settingsHandler);
  app.get("/costs", costsHandler);
  app.get("/logs", logsHandler);
  app.get("/ops", opsHandler);
  app.get("/audit", auditHandler);
  app.get("/health", healthHandler);
}
```

- The function MUST be idempotent for a given app instance (calling twice is undefined; tests call once).
- `app.ts` MUST invoke `registerRoutes(app)` exactly once after middleware setup and before `app.notFound(...)` (404 from SPEC-013-3-02).

### Stub Data Modules

All stubs live in `server/stubs/*.ts`, each exporting an async loader (so swapping to live data in PLAN-015 is a one-line change). Stub loaders MUST return Promises that resolve synchronously in tests (no fake timers needed).

## Acceptance Criteria

- [ ] All 9 routes are registered exactly once and respond with HTTP 200 (or 503 for `/health` when daemon dead) on a happy-path request
- [ ] `GET /repo/foo/request/REQ-000001` returns 200 when stub exists; 404 when stub missing
- [ ] `GET /repo/FOO/request/REQ-000001` returns 404 (uppercase slug rejected)
- [ ] `GET /repo/foo/request/REQ-12345` returns 404 (5-digit ID rejected)
- [ ] `GET /repo/foo/request/REQ-1234567` returns 404 (7-digit ID rejected)
- [ ] `GET /health` returns `{status:"ok", daemon, components}` with HTTP 200 when heartbeat fresh
- [ ] `GET /health` returns `{status:"degraded", ...}` with HTTP 503 when heartbeat stale or missing
- [ ] `GET /health` does not invoke any auth middleware
- [ ] Every page handler delegates rendering to `renderPage(c, view, props)`; no handler reads `HX-Request` directly (verified by grep)
- [ ] `app.ts` calls `registerRoutes(app)` exactly once
- [ ] No handler module imports another handler module (handlers are leaf-level)
- [ ] TypeScript strict mode passes (`tsc --noEmit`)

## Dependencies

- PLAN-013-2 must have produced a configured Hono `app` instance and a `Context` type re-export.
- SPEC-013-3-02 provides `renderPage`, `notFound`, and the HTMX detection logic. This spec depends on those exports existing; tests for those live in SPEC-013-3-04.
- SPEC-013-3-03 provides the layout and view templates registered under names `dashboard`, `request-detail`, `approvals`, `settings`, `costs`, `logs`, `ops`, `audit`.
- `server/lib/daemon-status.ts` (defined in PLAN-013-3 Task 3) MUST export `readDaemonStatus(): Promise<DaemonStatus>`.

## Notes

- The plan lists 9 routes; the four-spec grouping in this batch covers the same nine. The user's prompt summarized them as "/, /requests, /cost, /settings, /audit, /ops" — the canonical TDD-013 §7 set is implemented here (`/approvals` not `/requests`, `/costs` plural, plus `/repo/:repo/request/:id`, `/logs`, `/health`).
- Route order matters in Hono only for overlapping patterns; none of these patterns overlap, so registration order is purely organizational.
- Handlers MUST stay pure (no module-level side effects, no top-level `await`) so they can be unit-tested by directly calling them with a mocked `Context`.
- Stub loaders intentionally use `async` even when they could be sync — this preserves the call signature for the live PLAN-015 swap.
