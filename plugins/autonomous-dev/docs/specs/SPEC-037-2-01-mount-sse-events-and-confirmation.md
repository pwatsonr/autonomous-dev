# SPEC-037-2-01: Mount SSE Events + Confirmation Routes

## Metadata
- **Parent Plan**: PLAN-037-2-mount-missing-routes
- **Parent PRD**: PRD-018-portal-visual-redesign (gap audit)
- **Tasks Covered**: PLAN-037-2 §Scope items 1, 3
- **Estimated effort**: 0.25 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: BLOCKING (every interactive page depends on `/portal/events` SSE channel)

## 1. Summary

Wire two already-implemented but unmounted route modules into `server/routes/index.ts`:
`eventsRoute(bus)` from `routes/events.ts` (the `GET /portal/events` SSE stream) and
`registerConfirmationRoutes(app, deps)` from `routes/confirmation-routes.ts` (the
`POST /api/security/confirmation/{request,validate}` typed-CONFIRM pair). Both modules
already exist on disk; the only gap is registration. CSRF middleware applies upstream
without modification (GET is exempt for SSE; the confirmation POST routes intentionally
participate in the global CSRF chain per SPEC-014-2-02).

## 2. Functional Requirements

| ID    | Requirement                                                                                              |
|-------|----------------------------------------------------------------------------------------------------------|
| FR-1  | `registerRoutes(app, options)` MUST accept an `sseBus: SSEEventBus` field in `RegisterRoutesOptions` and, when present, mount `eventsRoute(options.sseBus)` via `app.route("/", eventsRoute(bus))`. |
| FR-2  | When `options.sseBus` is omitted, `/portal/events` MUST return 503 with a JSON body `{ error: "sse-disabled" }` rather than 404 — operators must see an explicit "wiring missing" signal. |
| FR-3  | `RegisterRoutesOptions` MUST accept a `confirmation: ConfirmationRouteDeps` field. When present, call `registerConfirmationRoutes(app, options.confirmation)` AFTER the static-asset mount and BEFORE the page handlers. |
| FR-4  | Both mounts MUST run AFTER any upstream CSRF and auth middleware in `server.ts` so that the global security chain wraps them — the registration site MUST NOT install a per-route bypass. |
| FR-5  | When `options.confirmation` is omitted, the two confirmation endpoints MUST return 503 `{ error: "confirmation-disabled" }` — same explicit-failure principle as FR-2. |
| FR-6  | `server.ts` (the portal entrypoint) MUST be updated to construct an `SSEEventBus` and an `InMemoryConfirmationStore + TypedConfirmationService` pair and pass both into `registerRoutes`. |
| FR-7  | Heartbeat emission MUST be wired: the bus MUST receive a `heartbeat` event at most every 30s (existing `SSEEventBus` API). The wiring lives in `server.ts`, not in `registerRoutes`. |

## 3. Acceptance Criteria

### AC-1: SSE endpoint reachable (FR-1, FR-7)
```
Given a portal server started with an SSEEventBus passed to registerRoutes
When curl -N http://PORT/portal/events is invoked
Then response status == 200
And content-type == "text/event-stream"
And within 35 seconds at least one "event: heartbeat" line is read
```

### AC-2: SSE disabled signal (FR-2)
```
Given registerRoutes called without options.sseBus
When GET /portal/events is invoked
Then response status == 503
And body == {"error":"sse-disabled"}
```

### AC-3: Confirmation request happy path (FR-3, FR-4)
```
Given an authenticated session + valid CSRF token
When POST /api/security/confirmation/request {action:"kill-switch-engage"}
Then status == 200, body has {token, phrase, ttl}
And the response did NOT bypass csrfMiddleware (bad token → 403)
```

### AC-4: Confirmation disabled signal (FR-5)
```
Given registerRoutes called without options.confirmation
When POST /api/security/confirmation/request is invoked
Then status == 503, body == {"error":"confirmation-disabled"}
```

## 4. Implementation

**File: `plugins/autonomous-dev-portal/server/routes/index.ts`**

Extend `RegisterRoutesOptions`:
```ts
import type { SSEEventBus } from "../sse/SSEEventBus";
import type { ConfirmationRouteDeps } from "./confirmation-routes";
import { eventsRoute } from "./events";
import { registerConfirmationRoutes } from "./confirmation-routes";

export interface RegisterRoutesOptions {
    staticRootDir?: string;
    authRoutes?: AuthRouteDeps;
    sseBus?: SSEEventBus;
    confirmation?: ConfirmationRouteDeps;
}
```

In `registerRoutes`, after the static-asset mount and before the page handlers:
```ts
if (options.sseBus !== undefined) {
    app.route("/", eventsRoute(options.sseBus));
} else {
    app.get("/portal/events", (c) =>
        c.json({ error: "sse-disabled" }, 503),
    );
}
if (options.confirmation !== undefined) {
    registerConfirmationRoutes(app, options.confirmation);
} else {
    app.post("/api/security/confirmation/request", (c) =>
        c.json({ error: "confirmation-disabled" }, 503));
    app.post("/api/security/confirmation/validate", (c) =>
        c.json({ error: "confirmation-disabled" }, 503));
}
```

**File: `plugins/autonomous-dev-portal/server/server.ts`** — instantiate the bus and
the confirmation deps in production startup and pass through. Test fixtures may pass
`undefined` to exercise the 503 branches.

## 5. Tests

**Integration — `tests/integration/portal-routes-mount.test.ts`:**

| Test ID | Scenario                            | Assert                                                       |
|---------|-------------------------------------|--------------------------------------------------------------|
| MT-01   | SSE reachable + heartbeat           | 200 + text/event-stream + heartbeat within 35s               |
| MT-02   | SSE disabled signal                 | 503 `{error:"sse-disabled"}`                                 |
| MT-03   | Confirmation request happy path     | 200 + token/phrase/ttl                                       |
| MT-04   | Confirmation validate happy path    | 200 + `{valid:true,action}`                                  |
| MT-05   | Confirmation disabled signal        | 503 `{error:"confirmation-disabled"}`                        |
| MT-06   | CSRF still enforced on confirmation | bad `_csrf` → 403 from upstream middleware                   |

## 6. Verification

```bash
curl -i -N http://localhost:8787/portal/events
# Expect: HTTP/1.1 200, content-type: text/event-stream, heartbeat line within 30s

curl -i -X POST http://localhost:8787/api/security/confirmation/request \
  -b session=... -H "X-CSRF-Token: $TOK" \
  -H "Content-Type: application/json" \
  -d '{"action":"kill-switch-engage"}'
# Expect: HTTP/1.1 200, JSON {token,phrase,ttl}
```
