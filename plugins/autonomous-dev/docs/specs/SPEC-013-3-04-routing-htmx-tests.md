# SPEC-013-3-04: Routing + HTMX Header Handling Tests

## Metadata
- **Parent Plan**: PLAN-013-3
- **Tasks Covered**: Task 15 (template + route tests); covers test obligations declared by SPEC-013-3-01, SPEC-013-3-02, SPEC-013-3-03
- **Estimated effort**: 6 hours

## Description
Provide automated test coverage for the routing layer (SPEC-013-3-01), the HTMX-aware rendering helpers (SPEC-013-3-02), and the layout/fragment templates (SPEC-013-3-03). Tests run under `vitest` (project default), use `app.fetch(new Request(...))` for end-to-end route assertions (no live network), and use Hono's testing utilities where appropriate. Snapshot tests cover all fragments + layout. Header-driven tests prove that fragment vs. full-page selection is correct across the documented HTMX header matrix. Heartbeat reads are tested via a temp directory and `XDG_STATE_HOME`-style env override.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/routes/registration.test.ts` | Create | Verifies all 9 routes registered, HTTP 200/404/503 paths |
| `tests/routes/request-detail.test.ts` | Create | Path param validation (slug + REQ-id) |
| `tests/routes/health.test.ts` | Create | `/health` JSON shape, 200 vs 503 |
| `tests/lib/response-utils.test.ts` | Create | `isHtmxRequest`, `renderPage` selection logic |
| `tests/lib/error-handlers.test.ts` | Create | 404 + 500 (HTMX vs full) |
| `tests/lib/daemon-status.test.ts` | Create | fresh/stale/dead classification + missing/malformed file |
| `tests/templates/base-layout.snapshot.test.ts` | Create | Snapshot for layout |
| `tests/templates/fragments.snapshot.test.ts` | Create | Snapshots for navigation, daemon-status-pill, repo-card, request-timeline, approval-item, cost-chart, audit-row |
| `tests/helpers/build-app.ts` | Create | Bootstraps a Hono app with stubbed dependencies |
| `tests/helpers/mock-heartbeat.ts` | Create | Writes a fake heartbeat.json into a tmpdir; restores on teardown |

## Implementation Details

### `build-app.ts`

```ts
export function buildTestApp(opts?: { daemonStatus?: DaemonStatus }): Hono {
  const app = new Hono();
  // bootstrap minimal middleware as PLAN-013-2 does in production
  registerRoutes(app);
  app.notFound(notFound);
  app.onError(serverError);
  if (opts?.daemonStatus) {
    vi.spyOn(daemonModule, "readDaemonStatus").mockResolvedValue(opts.daemonStatus);
  }
  return app;
}
```

- MUST NOT bind a TCP port. Tests dispatch via `app.fetch(req)`.
- Tests MUST clean up `vi.restoreAllMocks()` in `afterEach`.

### Route Registration Test (`registration.test.ts`)

For each route in the table below, send a GET via `app.fetch` and assert the documented status:

| Path | HX-Request | Daemon | Expected status | Body assertion |
|------|------------|--------|-----------------|----------------|
| `/` | absent | fresh | 200 | contains `<!doctype html>` |
| `/` | `true` | fresh | 200 | does NOT contain `<!doctype html>` |
| `/approvals` | absent | fresh | 200 | contains `<nav` |
| `/approvals` | `true` | fresh | 200 | does NOT contain `<nav` |
| `/settings` | absent | fresh | 200 | contains `<!doctype html>` |
| `/costs` | absent | fresh | 200 | contains `<svg` (chart) |
| `/logs` | absent | fresh | 200 | contains `<main` |
| `/ops` | absent | fresh | 200 | contains `<main` |
| `/audit` | absent | fresh | 200 | contains `<table` |
| `/health` | absent | fresh | 200 | JSON with `status:"ok"` |
| `/health` | absent | dead | 503 | JSON with `status:"degraded"` |
| `/does-not-exist` | absent | fresh | 404 | full-page 404 |
| `/does-not-exist` | `true` | fresh | 404 | fragment 404 |

### Path Param Validation Test (`request-detail.test.ts`)

Run the following matrix against `GET /repo/{repo}/request/{id}`:

| repo | id | Stub present | Expected status |
|------|----|----|-----------------|
| `acme` | `REQ-000001` | yes | 200 |
| `acme` | `REQ-000001` | no | 404 |
| `Acme` | `REQ-000001` | yes | 404 (uppercase rejected) |
| `acme!` | `REQ-000001` | yes | 404 (special char rejected) |
| `acme` | `REQ-12345` | yes | 404 (5 digits) |
| `acme` | `REQ-1234567` | yes | 404 (7 digits) |
| `acme` | `req-000001` | yes | 404 (lowercase REQ rejected) |
| `acme` | `REQ-12345A` | yes | 404 (non-digit) |
| `` (empty) | `REQ-000001` | yes | 404 (Hono returns 404 for missing param naturally) |

### `isHtmxRequest` Test (`response-utils.test.ts`)

| Header set | Expected `isHtmxRequest` |
|------------|--------------------------|
| `HX-Request: true` | true |
| `hx-request: true` (lowercase) | true |
| `HX-Boosted: true` | true |
| `HX-Request: false` | false |
| `HX-Request: 1` | false (only `"true"` accepted) |
| `HX-Request: ""` | false |
| (no headers) | false |
| `Accept: text/html-fragment` only | false |
| `HX-Request: TRUE` (uppercase value) | false |

### `renderPage` Selection Test

- Spy on `renderFullPage` and `renderFragment`. Send a request with `HX-Request: true` → assert `renderFragment` called once, `renderFullPage` not called. Send without header → opposite.
- Assert `Content-Type: text/html; charset=utf-8` on both.

### Error Handler Tests (`error-handlers.test.ts`)

- 404 fragment includes the requested path string.
- 500 body MUST NOT contain the literal `err.message` (use a recognizable sentinel like `"sentinel-leak-12345"` and assert absence).
- 500 logger receives the error (spy on `c.get("logger").error`).

### `daemon-status.test.ts`

- Use `tmp.dir()` for a unique heartbeat path; override the home-dir resolution via env var `AUTONOMOUS_DEV_STATE_DIR` (introduce this override in `daemon-status.ts` for testability).
- Cases:
  - file missing → `dead`
  - file empty → `dead`
  - file malformed JSON → `dead`
  - `last_seen` = now → `fresh`
  - `last_seen` = 30s ago → `fresh`
  - `last_seen` = 90s ago → `stale`
  - `last_seen` = 240s ago → `stale`
  - `last_seen` = 301s ago → `dead`
  - `last_seen` = 1 hour in the future → `dead`
  - File present but missing `last_seen` field → `dead`

### Snapshot Tests

- Layout: render `BaseLayout` with `activePath="/"` and a `<p>hello</p>` child. Snapshot the string output.
- Each fragment rendered with a stable, hand-crafted props object (no `Date.now()`, no random IDs). Use `toMatchInlineSnapshot()` to keep diffs reviewable in PRs.
- Snapshots MUST be regenerated only via `vitest -u`; CI runs without `-u` and fails on drift.

## Acceptance Criteria

- [ ] `vitest run` passes locally and in CI with zero skipped tests
- [ ] Route registration table (13 cases) all pass; failures pinpoint the offending route
- [ ] `request-detail` validation matrix (9 cases) all pass
- [ ] `isHtmxRequest` matrix (9 cases) all pass
- [ ] `renderPage` selection spies confirm correct branch chosen for both header states
- [ ] `error-handlers.test.ts` proves no error message leakage and confirms logger usage
- [ ] `daemon-status.test.ts` covers all 11 cases including missing/malformed/future-dated heartbeats
- [ ] Snapshot tests exist for: `BaseLayout`, `Navigation`, `DaemonStatusPill`, `RepoCard`, `RequestTimeline`, `ApprovalItem`, `CostChart`, `AuditRow` (8 snapshots)
- [ ] No test creates real network sockets (verified by ensuring no `app.listen`/`serve` call in `tests/`)
- [ ] No test depends on the user's actual `~/.autonomous-dev/heartbeat.json` (verified by env override usage)
- [ ] Test runtime under 5 seconds total on a typical dev machine (no real timers, no real I/O outside tmpdirs)
- [ ] `vitest -u` does not produce any unexpected snapshot churn after a clean run

## Dependencies

- `vitest` (already on the toolchain).
- `tmp` or built-in `node:fs.mkdtemp` for tmpdir creation.
- The `AUTONOMOUS_DEV_STATE_DIR` env override MUST be added to `server/lib/daemon-status.ts` (small change to SPEC-013-3-03's reader) so tests do not pollute the user's real home directory. If the SPEC-013-3-03 implementation is already merged without this hook, add it as a one-line patch and note the cross-spec change in the PR description.
- All artifacts produced by SPEC-013-3-01, SPEC-013-3-02, SPEC-013-3-03.

## Notes

- The Playwright "browser snapshot" line item in the source plan's Test Plan is intentionally NOT in scope here — it belongs alongside the static-asset/CSS work in PLAN-013-4 where the visual rendering is meaningful. This spec covers only HTML/text-level assertions.
- Inline snapshots are preferred over external `__snapshots__` files for fragments because diff review during PRs is cleaner. Layout snapshot is large enough to warrant an external file.
- Tests MUST avoid timing flakiness: any time-based assertion MUST stub `Date.now()` (vitest fake timers) rather than relying on wall-clock comparisons.
- The state-dir env override is a minor backdoor introduced solely for testability; production code reads it once at module load. Future security review (PLAN-014) will confirm the override is not honored when running under a daemon-managed UID.
