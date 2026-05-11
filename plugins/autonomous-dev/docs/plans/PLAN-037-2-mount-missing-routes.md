# PLAN-037-2: Mount missing API + SSE routes

## Metadata
- **Parent**: PLAN-037-portal-kit-parity
- **Effort**: 2 days
- **Dependencies**: []
- **Priority**: P0 (10+ endpoints currently return HTTP 404, breaking every interactive control on Approvals, Settings, Agents, gates)

## Objective

Every interactive control in the portal currently misfires because the routes referenced by `hx-*` attributes in templates are not registered in `server/routes/index.ts`. Some handler implementations already exist on disk (`routes/confirmation-routes.ts`, `routes/events.ts`); others need to be authored. This plan registers every dead endpoint and creates stub handlers for the ones missing.

## Scope

### In Scope

Register / implement, in this order:

1. **`GET /portal/events` (SSE)** — import `eventsRoute(bus)` from `routes/events.ts`; wire it in `registerRoutes`. Without this the heartbeat, log, deploys, and MCP SSE channels on `/ops` are dead.
2. **`GET /api/daemon-status`** — small handler that reads `~/.autonomous-dev/heartbeat.json` and returns JSON `{ status: 'running'|'stale'|'down', mtdSpend, approvalsCount, killSwitchEngaged }`. Drives the rail-ops pill on every page (PLAN-037-3 consumes it).
3. **`POST /api/security/confirmation/{request,validate}`** — import from `routes/confirmation-routes.ts`; mount under the existing `/api/security/` prefix.
4. **Approvals actions**:
   - `POST /api/approvals/:id/approve` — accepts CSRF, marks approval, fires SSE update.
   - `POST /api/approvals/:id/reject` — same.
   - `POST /api/approvals/bulk-approve` — accepts list of approval IDs.
5. **Settings actions**:
   - `POST /settings` — save form (general / trust / costs / allowlist / notifications). Writes to `~/.claude/autonomous-dev.json` via existing config writer; returns updated fragment.
   - `POST /api/settings/allowlist` — add a repo path with `git rev-parse --is-inside-work-tree` validation.
   - `POST /api/settings/notifications/test/{discord,slack,send}` — fires a test notification via existing notification engine.
6. **Agent actions**:
   - `POST /api/agents/:name/{promote,shadow,freeze}` — calls into existing agent-factory CLI commands; returns updated row fragment.
7. **Gate actions** (on RequestDetail):
   - `POST /repo/:repo/request/:id/gate/{approve,request-changes,reject}` — confirm-modal flow; writes to daemon state.
8. **Request action**:
   - `POST /api/requests/:id/action` — generic action endpoint used by request-timeline's "retry" / "skip" actions.

All POST endpoints honor existing CSRF middleware. Handlers that mutate config or daemon state log to the audit chain.

### Out of Scope
- Building new backends for the daemon. This plan wires routes to existing daemon CLI / state files; if a CLI command doesn't exist for an action, stub the route with a 501 "not implemented" + structured log and document in PLAN-037 follow-up.

## Verification
- All 10+ endpoints listed in the gap audit return non-404 status when probed via `curl`.
- HTMX `hx-post` actions on Approvals, Settings, Agents, gates all succeed end-to-end (manually verified in browser, with network-tab inspection).
- `/portal/events` keeps an SSE connection open and emits at least the `heartbeat` event every 30s.

## Tests
- Integration test per endpoint group (approvals, settings, agents, gates, confirmation).
- SSE smoke test for `/portal/events`.

## Risks
| Risk | Mitigation |
|---|---|
| Daemon CLI commands for some actions don't exist (e.g. `autonomous-dev agent promote`) | Stub the route with 501; flag follow-up |
| Existing CSRF middleware semantic mismatch | Reuse `csrf-protection.ts`; add a single test confirming bad-token rejection |
| `~/.claude/autonomous-dev.json` write race vs daemon reads | Use existing atomic-write helper (PR #175 era) |
