# SPEC-037-2-03: Approvals Action Routes (approve / reject / bulk-approve)

## Metadata
- **Parent Plan**: PLAN-037-2-mount-missing-routes
- **Parent PRD**: PRD-018-portal-visual-redesign (Approvals page)
- **Tasks Covered**: PLAN-037-2 §Scope item 4
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: ELEVATED (mutates daemon state and emits audit entries)

## 1. Summary

Add three new POST routes to back the Approvals page HTMX controls. All three honor the
global CSRF middleware, validate the route param, mutate state via the existing
approvals store, emit a structured audit-chain entry, and publish an SSE update on the
shared bus so other connected clients re-render the row in real time.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                       |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | Register `POST /api/approvals/:id/approve`, `POST /api/approvals/:id/reject`, `POST /api/approvals/bulk-approve` in `server/routes/index.ts` via a new sub-router `buildApprovalsActionRoutes(deps)`. |
| FR-2  | `:id` MUST be validated against `/^[A-Za-z0-9_-]{1,128}$/`. Invalid → 400 `{error:"invalid-id"}`.                                                                                                  |
| FR-3  | Bulk endpoint body MUST be JSON `{ ids: string[] }` with `1 <= ids.length <= 50`; each id matches the FR-2 pattern. Failures → 400.                                                                |
| FR-4  | All three routes MUST require CSRF (POST → upstream middleware enforces). The route MUST NOT add any per-route exemption.                                                                          |
| FR-5  | On success, single endpoints return an HTMX row fragment (`text/html`) for `outerHTML` swap. Bulk returns `application/json` `{approved: string[], failed: Array<{id,reason}>}`.                    |
| FR-6  | Each successful mutation MUST append an `auditLogger` entry with event `approval_approved` or `approval_rejected`, including `id`, `actor` (source_user_id), and request-id.                       |
| FR-7  | After success, the handler MUST publish an SSE event on the shared bus: `event: approval`, data `{ id, state }`. The publish MUST NOT block the response — fire-and-forget via `void bus.broadcast(...)`. |
| FR-8  | If the approvals store reports `not-found`, return 404. On any other error, return 500 with a JSON error envelope; do NOT leak stack traces.                                                       |
| FR-9  | Bulk endpoint MUST partial-succeed: failures in some ids MUST NOT roll back successful approvals. Failed ids appear in the response with a `reason` string.                                        |
| FR-10 | The route MUST refuse to approve an approval already in a terminal state (`approved`, `rejected`); return 409 `{error:"already-decided", state}`.                                                  |

## 3. Acceptance Criteria

### AC-1: Approve happy path
```
POST /api/approvals/appr_123/approve with valid CSRF
→ 200 text/html, body contains <tr id="appr_123" ...> with chip "approved"
→ audit log appended with event=approval_approved, id=appr_123
→ SSE bus received {event:"approval", data:{id:"appr_123", state:"approved"}}
```

### AC-2: Reject happy path
```
POST /api/approvals/appr_123/reject → 200 + row fragment with chip "rejected"
```

### AC-3: Invalid id
```
POST /api/approvals/..%2F..%2Fetc/approve → 400 {"error":"invalid-id"}
```

### AC-4: Bulk happy path
```
POST /api/approvals/bulk-approve body {"ids":["a","b","c"]}
→ 200, body {"approved":["a","b","c"],"failed":[]}
```

### AC-5: Bulk partial
```
ids=["good","missing","good2"] where "missing" is not found
→ 200, {"approved":["good","good2"],"failed":[{"id":"missing","reason":"not-found"}]}
```

### AC-6: Already decided
```
POST /api/approvals/already_approved/approve → 409 {"error":"already-decided","state":"approved"}
```

### AC-7: CSRF rejection
```
POST without valid token → 403 from upstream middleware
```

## 4. Implementation

**File: `plugins/autonomous-dev-portal/server/routes/approvals-actions.ts`** (new).

```ts
import { Hono } from "hono";
import type { AuditLogger } from "../security/audit-logger";
import type { SSEEventBus } from "../sse/SSEEventBus";

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const BULK_MAX = 50;

export interface ApprovalsStore {
    decide(id: string, state: "approved" | "rejected", actor: string):
        Promise<{ ok: true; row: JSX.Element } |
                { ok: false; error: "not-found" | "already-decided"; state?: string }>;
}

export interface ApprovalsActionDeps {
    store: ApprovalsStore;
    audit: AuditLogger;
    bus: SSEEventBus;
}

export function buildApprovalsActionRoutes(deps: ApprovalsActionDeps): Hono {
    const r = new Hono();
    const handle = (state: "approved" | "rejected") => async (c) => {
        const id = c.req.param("id");
        if (!ID_RE.test(id)) return c.json({ error: "invalid-id" }, 400);
        const actor = (c.get("auth") as { source_user_id?: string })?.source_user_id ?? "unknown";
        const res = await deps.store.decide(id, state, actor);
        if (!res.ok && res.error === "not-found") return c.json({ error: "not-found" }, 404);
        if (!res.ok && res.error === "already-decided")
            return c.json({ error: "already-decided", state: res.state }, 409);
        if (!res.ok) return c.json({ error: "internal" }, 500);
        await deps.audit.append({ event: `approval_${state}`, id, actor });
        void deps.bus.broadcast("approval", { id, state });
        return c.html(res.row);
    };
    r.post("/api/approvals/:id/approve", handle("approved"));
    r.post("/api/approvals/:id/reject",  handle("rejected"));
    r.post("/api/approvals/bulk-approve", async (c) => { /* ids[] loop, partial success */ });
    return r;
}
```

Mount via `app.route("/", buildApprovalsActionRoutes(deps))` in `registerRoutes`.

## 5. Tests

**Integration — `tests/integration/approvals-actions.test.ts`:**

| Test ID | Scenario               | Assert                                                                |
|---------|------------------------|-----------------------------------------------------------------------|
| AA-01   | approve happy          | 200 + row fragment + audit entry + SSE publish                        |
| AA-02   | reject happy           | 200 + row fragment                                                    |
| AA-03   | invalid id             | 400 {error:"invalid-id"}                                              |
| AA-04   | bulk happy             | 200 {approved:[...], failed:[]}                                       |
| AA-05   | bulk partial           | failed[].reason populated; approved[] still committed                 |
| AA-06   | already-decided        | 409 {error:"already-decided", state}                                  |
| AA-07   | CSRF rejection         | 403 (upstream)                                                        |

## 6. Verification

```bash
curl -i -X POST -b session=... -H "X-CSRF-Token: $TOK" \
  http://localhost:8787/api/approvals/appr_123/approve
# Expect: 200, text/html with row fragment

curl -i -X POST -b session=... -H "X-CSRF-Token: $TOK" \
  -H "Content-Type: application/json" \
  -d '{"ids":["a","b","c"]}' \
  http://localhost:8787/api/approvals/bulk-approve
# Expect: 200 JSON {approved,failed}
```
