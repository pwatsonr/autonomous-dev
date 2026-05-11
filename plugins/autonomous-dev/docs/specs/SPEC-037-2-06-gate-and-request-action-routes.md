# SPEC-037-2-06: Gate Action Routes + Generic Request Action

## Metadata
- **Parent Plan**: PLAN-037-2-mount-missing-routes
- **Parent PRD**: PRD-018-portal-visual-redesign (RequestDetail page)
- **Tasks Covered**: PLAN-037-2 §Scope items 7, 8
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: ELEVATED (gate decisions mutate request lifecycle state)

## 1. Summary

Add four routes backing the RequestDetail page: three gate-decision POSTs
(`approve`, `request-changes`, `reject`) and one generic request-action POST that the
request-timeline component uses for `retry` / `skip` / similar non-gate verbs. The three
gate decisions participate in the typed-CONFIRM flow (SPEC-014-2-02) since they are
irreversible state transitions on a request lifecycle; the generic action POST does NOT
require typed-CONFIRM (its verbs are recoverable).

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                       |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | Register `POST /repo/:repo/request/:id/gate/approve`, `.../gate/request-changes`, `.../gate/reject`, and `POST /api/requests/:id/action` via `buildGateAndRequestActionRoutes(deps)`.              |
| FR-2  | `:repo` MUST match `/^[A-Za-z0-9._-]{1,128}$/`; `:id` MUST match `/^[A-Za-z0-9_-]{1,128}$/`. Invalid → 400 `{error:"invalid-id"}` or `{error:"invalid-repo"}`.                                     |
| FR-3  | The three gate POSTs MUST be wrapped by the existing `requireConfirmation("gate-<verb>")` middleware (SPEC-014-2-02) — caller must have completed the typed-CONFIRM flow within the grace window. |
| FR-4  | On `confirmation-required` from the middleware, return 403 `{error:"confirmation-required",action:"gate-<verb>"}` — the modal flow on the client will then trigger the request/validate dance. |
| FR-5  | On success, gate POSTs MUST update the daemon state via `deps.applyGateDecision({ repo, id, verb, actor })` and return the updated RequestDetail gate fragment (`text/html`) for HTMX `outerHTML` swap. |
| FR-6  | Each successful gate decision MUST append audit entry `gate_<verb>` and broadcast SSE `event: gate, data: { repo, id, verb }`.                                                                     |
| FR-7  | `POST /api/requests/:id/action` body `{action: string}` MUST whitelist `action` against `["retry","skip","cancel","escalate"]`. Unknown → 400 `{error:"unknown-action"}`. No typed-CONFIRM required. |
| FR-8  | The generic action MUST be idempotent at the daemon level — replaying the same request twice is the daemon's responsibility, but the route MUST not 500 on a "no-op" return; instead 200 with the unchanged fragment. |
| FR-9  | All four routes MUST honor upstream CSRF; the three gate POSTs additionally pass through `requireConfirmation` AFTER CSRF.                                                                          |
| FR-10 | The route MUST refuse a gate decision against a request whose lifecycle is terminal (`completed`, `cancelled`, `failed`) — return 409 `{error:"request-terminal",state}`.                          |

## 3. Acceptance Criteria

### AC-1: Gate approve happy path (FR-3, FR-5, FR-6)
```
Given a valid confirmation token recorded for action="gate-approve"
POST /repo/foo/request/req_1/gate/approve with X-Confirmation-Token + CSRF
→ 200 + gate fragment (chip "approved")
→ applyGateDecision called with verb="approve"
→ audit entry gate_approved
→ SSE event "gate" broadcast
```

### AC-2: Gate without confirmation (FR-4)
```
POST /repo/foo/request/req_1/gate/reject WITHOUT X-Confirmation-Token
→ 403 {"error":"confirmation-required","action":"gate-reject"}
```

### AC-3: Gate wrong action confirmed (FR-3)
```
Given a confirmation token recorded for action="gate-approve"
POST /repo/foo/request/req_1/gate/reject with that token
→ 403 {"error":"wrong-action-confirmed"} from requireConfirmation
```

### AC-4: Gate terminal state (FR-10)
```
Given req_1 is in state "completed"
POST /repo/foo/request/req_1/gate/approve (with confirmation)
→ 409 {"error":"request-terminal","state":"completed"}
```

### AC-5: Invalid repo or id (FR-2)
```
POST /repo/..%2F..%2F/request/req_1/gate/approve → 400 {"error":"invalid-repo"}
POST /repo/foo/request/!!!/gate/approve         → 400 {"error":"invalid-id"}
```

### AC-6: Generic action happy path (FR-7)
```
POST /api/requests/req_1/action {"action":"retry"} with CSRF
→ 200 + updated timeline fragment
→ audit entry request_action_retry
```

### AC-7: Generic unknown action (FR-7)
```
POST /api/requests/req_1/action {"action":"explode"}
→ 400 {"error":"unknown-action"}
```

### AC-8: CSRF rejection on all four
```
POST without CSRF token → 403 from upstream middleware
```

## 4. Implementation

**File: `plugins/autonomous-dev-portal/server/routes/gate-and-request-actions.ts`** (new).

```ts
import { Hono } from "hono";
import { requireConfirmation } from "./confirmation-routes";

const REPO_RE = /^[A-Za-z0-9._-]{1,128}$/;
const ID_RE   = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIONS = new Set(["retry","skip","cancel","escalate"]);

export interface GateActionDeps {
    applyGateDecision: (req: { repo: string; id: string; verb: GateVerb; actor: string })
        => Promise<{ ok: true; fragment: JSX.Element }
                 | { ok: false; reason: "not-found" | "terminal"; state?: string }>;
    applyRequestAction: (id: string, action: string, actor: string)
        => Promise<{ ok: true; fragment: JSX.Element } | { ok: false; reason: string }>;
    audit: AuditLogger;
    bus: SSEEventBus;
    confirmationStore: ConfirmationStore;
}

type GateVerb = "approve" | "request-changes" | "reject";

export function buildGateAndRequestActionRoutes(deps: GateActionDeps): Hono {
    const r = new Hono();
    const gateHandler = (verb: GateVerb) => async (c) => {
        const repo = c.req.param("repo");
        const id = c.req.param("id");
        if (!REPO_RE.test(repo)) return c.json({ error: "invalid-repo" }, 400);
        if (!ID_RE.test(id))    return c.json({ error: "invalid-id" }, 400);
        const actor = (c.get("auth") as { source_user_id?: string })?.source_user_id ?? "unknown";
        const res = await deps.applyGateDecision({ repo, id, verb, actor });
        if (!res.ok && res.reason === "not-found") return c.json({ error: "not-found" }, 404);
        if (!res.ok && res.reason === "terminal")
            return c.json({ error: "request-terminal", state: res.state }, 409);
        if (!res.ok) return c.json({ error: "internal" }, 500);
        await deps.audit.append({ event: `gate_${verb.replace("-","_")}`, repo, id, actor });
        void deps.bus.broadcast("gate", { repo, id, verb });
        return c.html(res.fragment);
    };
    for (const verb of ["approve","request-changes","reject"] as const) {
        r.post(`/repo/:repo/request/:id/gate/${verb}`,
            requireConfirmation(`gate-${verb}`, { store: deps.confirmationStore }),
            gateHandler(verb));
    }
    r.post("/api/requests/:id/action", async (c) => {
        const id = c.req.param("id");
        if (!ID_RE.test(id)) return c.json({ error: "invalid-id" }, 400);
        const body = await c.req.json().catch(() => ({})) as { action?: unknown };
        if (typeof body.action !== "string" || !ACTIONS.has(body.action))
            return c.json({ error: "unknown-action" }, 400);
        const actor = (c.get("auth") as { source_user_id?: string })?.source_user_id ?? "unknown";
        const res = await deps.applyRequestAction(id, body.action, actor);
        if (!res.ok) return c.json({ error: res.reason }, 500);
        await deps.audit.append({ event: `request_action_${body.action}`, id, actor });
        return c.html(res.fragment);
    });
    return r;
}
```

## 5. Tests

**Integration — `tests/integration/gate-and-request-actions.test.ts`:**

| Test ID | Scenario                          | Assert                                                       |
|---------|-----------------------------------|--------------------------------------------------------------|
| GR-01   | gate approve happy                | 200 + fragment + audit + SSE                                 |
| GR-02   | gate missing confirmation         | 403 confirmation-required                                    |
| GR-03   | gate wrong action confirmed       | 403 wrong-action-confirmed                                   |
| GR-04   | gate terminal state               | 409 request-terminal                                         |
| GR-05   | invalid repo or id                | 400                                                          |
| GR-06   | generic action happy              | 200 + fragment + audit                                       |
| GR-07   | generic unknown action            | 400 unknown-action                                           |
| GR-08   | CSRF rejection                    | 403 upstream                                                 |

## 6. Verification

```bash
# Pre-mint a confirmation token via the request/validate pair first.
curl -i -X POST -b session=... -H "X-CSRF-Token: $TOK" \
  -H "X-Confirmation-Token: $CONF" \
  http://localhost:8787/repo/foo/request/req_1/gate/approve
# Expect: 200 + gate fragment

curl -i -X POST -b session=... -H "X-CSRF-Token: $TOK" \
  -H "Content-Type: application/json" -d '{"action":"retry"}' \
  http://localhost:8787/api/requests/req_1/action
# Expect: 200 + timeline fragment
```
