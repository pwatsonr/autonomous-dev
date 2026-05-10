# SPEC-035-3-02: GET /ops/kill-switch-modal Arm Route Handler

## Metadata
- **Parent Plan**: PLAN-035-3
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§6.5.7 v1.1)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-13)
- **Tasks Covered**: PLAN-035-3 Tasks 3, 6 (partial — GET registration)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: SAFETY-CRITICAL (entry point of the engage state machine)

## 1. Summary

Implement `GET /ops/kill-switch-modal?step=arm` in
`plugins/autonomous-dev-portal/server/routes/ops-kill-switch.ts`. The
handler is the *only* server-side path that mints an `armed_at` ISO
timestamp; downstream POST validation in SPEC-035-3-03 enforces a 30-second
window against this timestamp. The handler returns an HTMX fragment
(`outerHTML` swap target `.ks-panel`) so the rail-ops `kbtn` from
PLAN-035-1 can transition the panel from idle to armed without a full
page reload.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                          | Task |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The handler MUST be registered as `app.get("/ops/kill-switch-modal", handler)` in `server/routes/index.ts` (or wherever ops routes are registered) so the rail-ops `kbtn` HTMX GET reaches it.        | T6   |
| FR-2  | The handler MUST read `c.req.query("step")`. If the value is exactly `"arm"`, render the **armed** `KillSwitch` fragment per FR-3. Any other value (including `undefined`, `null`, or arbitrary strings) MUST render the **idle** `KillSwitch` fragment (defensive default — never fail open into armed). | T3   |
| FR-3  | When `step === "arm"`, the handler MUST mint `armedAt = new Date().toISOString()` (UTC, millisecond precision). The timestamp MUST be generated server-side; the request MUST NOT be able to supply its own `armed_at`. | T3   |
| FR-4  | The handler MUST read `csrfToken = c.get("csrfToken") ?? ""` from the request context (set upstream by the existing `csrfMiddleware` at `server/security/csrf-protection.ts`). The handler MUST NOT mint or sign its own CSRF token. | T3   |
| FR-5  | The response MUST be `c.html(<KillSwitch engaged={false} armed={true} armedAt={armedAt} csrfToken={csrfToken} onConfirm="/ops/kill-switch" />)` with HTTP 200, content-type `text/html; charset=UTF-8`. | T3   |
| FR-6  | The response MUST NOT include `Set-Cookie`, MUST NOT include `Cache-Control: public`, and MUST include `Cache-Control: no-store` to prevent the armed fragment (with its time-sensitive `armed_at`) from being cached by intermediaries or the browser. | T3   |
| FR-7  | The handler MUST NOT mutate any server-side state. The "armed" fact lives entirely in the client-side hidden input round-tripped on POST — there is no server session entry to leak or to clean up. | T3   |
| FR-8  | The handler MUST be idempotent: invoking GET `?step=arm` twice in succession returns two distinct fragments with two distinct `armed_at` timestamps. The most recent timestamp is the operative one for the next POST. | T3   |
| FR-9  | The route MUST require an authenticated session (existing `authMiddleware` upstream). On unauthenticated request the middleware returns 401 / redirect before the handler runs. The handler does NOT re-implement auth. | T3   |
| FR-10 | On any internal exception (e.g. CSRF middleware failure, render exception), the handler MUST return HTTP 500 with an error fragment that does NOT include any `armed_at` timestamp — the operator must restart the flow rather than receive a partially-armed state. | T3   |

## 3. Non-Functional Requirements

| Requirement                              | Target                                                          | Measurement                                                        |
|------------------------------------------|------------------------------------------------------------------|--------------------------------------------------------------------|
| Latency                                   | p99 < 50ms (no I/O — pure render)                                | Integration-test timing                                             |
| Cache prevention                          | `Cache-Control: no-store` present on every response              | Integration-test header assertion                                   |
| `armed_at` precision                      | ISO-8601 with millisecond fragment (e.g. `2026-05-09T20:00:00.000Z`) | Regex assertion in integration test                            |
| Race-safety                               | Two parallel GETs return two independent timestamps              | Concurrent-request integration test                                 |

## 4. Technical Approach

**File: `plugins/autonomous-dev-portal/server/routes/ops-kill-switch.ts`** (new file).

```tsx
import { Hono } from "hono";
import { KillSwitch } from "../components/primitives";

export const opsKillSwitchRoutes = new Hono();

opsKillSwitchRoutes.get("/ops/kill-switch-modal", async (c) => {
    const step = c.req.query("step");
    const csrfToken = c.get("csrfToken") ?? "";

    c.header("Cache-Control", "no-store");

    if (step !== "arm") {
        return c.html(
            <KillSwitch engaged={false} onConfirm="/ops/kill-switch" csrfToken={csrfToken} />,
        );
    }

    const armedAt = new Date().toISOString();
    return c.html(
        <KillSwitch
            engaged={false}
            armed={true}
            armedAt={armedAt}
            csrfToken={csrfToken}
            onConfirm="/ops/kill-switch"
        />,
    );
});
```

Register in `server/routes/index.ts` after the auth + CSRF middleware chain. CSRF middleware does not block GET (per double-submit cookie pattern at `server/security/csrf-protection.ts`), but it DOES populate `c.get("csrfToken")` for the form to embed.

## 5. Acceptance Criteria

### AC-1: Happy path — armed fragment (FR-2, FR-3, FR-5)
```
Given an authenticated session with CSRF token "tok-abc"
When GET /ops/kill-switch-modal?step=arm is invoked
Then response status == 200
And content-type starts with "text/html"
And body contains <div class="ks-panel armed">
And body contains <input type="hidden" name="armed_at" value="<ISO>">
     where <ISO> matches /^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
And body contains <input type="hidden" name="_csrf" value="tok-abc">
And |Date.now() - Date.parse(<ISO>)| < 1000  (timestamp is current)
```

### AC-2: Defensive default — non-arm step (FR-2)
```
Given GET /ops/kill-switch-modal (no step) OR ?step=cancel OR ?step=foo
When the handler runs
Then response status == 200
And body contains <div class="ks-panel"> (no "armed" modifier)
And body contains the "Engage kill switch" destructive button
And body contains NO <input name="armed_at">
And body contains NO <form method="POST">
```

### AC-3: Cache prevention (FR-6)
```
Given any GET /ops/kill-switch-modal response
Then response header Cache-Control == "no-store"
And no Set-Cookie header is emitted
```

### AC-4: Server-minted timestamp (FR-3)
```
Given a request with arbitrary query string ?step=arm&armed_at=1900-01-01T00:00:00.000Z
When the handler runs
Then the rendered armed_at value is the SERVER's current time
And the request's armed_at parameter is IGNORED (not echoed)
```

### AC-5: Auth required (FR-9)
```
Given an unauthenticated request
When GET /ops/kill-switch-modal?step=arm is invoked
Then authMiddleware returns 401 / redirect BEFORE the handler runs
And no armed_at is minted
```

### AC-6: Failure path (FR-10)
```
Given a render-time exception (e.g. KillSwitch throws)
When the handler executes
Then response status == 500
And body does NOT contain a parseable armed_at hidden input
And the operator must restart by issuing a fresh ?step=arm GET
```

### AC-7: Idempotency (FR-8)
```
Given two sequential GET /ops/kill-switch-modal?step=arm requests T1 and T2
When both responses are parsed
Then armed_at(T1) != armed_at(T2)
And both timestamps are independently valid for the next 30 seconds
```

## 6. Tests

**Integration — `tests/integration/kill-switch.test.ts` (also covers SPEC-035-3-05):**

| Test ID  | Scenario                       | Assert                                                                          |
|----------|--------------------------------|---------------------------------------------------------------------------------|
| KS-I-A01 | step=arm happy path             | 200 + armed fragment + ISO armed_at + CSRF token                                |
| KS-I-A02 | step missing                    | 200 + idle fragment, no armed_at                                                |
| KS-I-A03 | step=cancel                     | 200 + idle fragment                                                             |
| KS-I-A04 | Cache-Control header            | response header `Cache-Control: no-store`                                       |
| KS-I-A05 | armed_at query param ignored    | rendered armed_at differs from injected ?armed_at=...                           |
| KS-I-A06 | unauthenticated                 | 401 / redirect; no armed_at minted                                              |
| KS-I-A07 | concurrent arms                 | Two parallel arms produce distinct ISO timestamps                                |

## 7. Verification

- All seven integration tests pass.
- `curl -i -b session-cookie 'http://localhost:PORT/ops/kill-switch-modal?step=arm'` returns 200 + armed fragment + `Cache-Control: no-store`.
- The rail-ops `kbtn` from PLAN-035-1 (`hx-get="/ops/kill-switch-modal?step=arm" hx-target="#modal-slot"`) successfully replaces `#modal-slot` with the armed panel — manual smoke test from the rendered Ops page.
- Failure-mode safety: forcing a render exception (temporarily `throw` inside the handler) yields 500 + no armed_at — verified manually before reverting the throw.
