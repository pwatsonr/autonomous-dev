# SPEC-035-3-04: POST /ops/kill-switch/reset — Disengage Handler

## Metadata
- **Parent Plan**: PLAN-035-3
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§6.5.7 v1.1)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-13)
- **Tasks Covered**: PLAN-035-3 Task 5, Task 6 (reset POST registration)
- **Estimated effort**: 0.4 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: SAFETY-CRITICAL — recovery from engaged state; idempotent

## 1. Summary

Implement `POST /ops/kill-switch/reset` in
`server/routes/ops-kill-switch.ts`. The handler disengages a previously
engaged kill switch by invoking `operationsHandlers.resetKillSwitch()`. It
shares the engage handler's CSRF requirement and failure-handling
discipline (no silent failure, structured ERROR log on failure, do not
mark idle if the daemon-side reset failed). It does NOT require a typed
CONFIRM — the operator's intent here is to *restore* daemon processing,
which is the safer direction; the typed-CONFIRM gate is reserved for the
*destructive* engage transition.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                                  | Task |
|-------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The handler MUST be registered as `app.post("/ops/kill-switch/reset", handler)` in `server/routes/index.ts`, AFTER the existing `csrfMiddleware`. The middleware ordering MUST match SPEC-035-3-03 FR-1. | T6   |
| FR-2  | **CSRF validation**: identical to SPEC-035-3-03 FR-2 — handled upstream by `csrfMiddleware` from `server/security/csrf-protection.ts`. On invalid/missing `_csrf` the middleware returns HTTP 403 BEFORE the handler executes. The handler MUST NOT bypass the middleware. | T5   |
| FR-3  | The handler MUST invoke `await operationsHandlers.resetKillSwitch()` inside a `try/catch`. The handler MUST NOT pass any operator-controlled parameters to `resetKillSwitch` (the call signature is parameterless per existing daemon contract). | T5   |
| FR-4  | **Idempotency**: the handler MUST be safe to invoke multiple times in succession. If `resetKillSwitch` resolves on a kill switch that is already disengaged (the daemon handler is idempotent on its side per PLAN-035-3 risk-table row 6), the handler MUST still return HTTP 200 + idle fragment. | T5   |
| FR-5  | **Success path**: on `resetKillSwitch` resolution, the handler MUST return HTTP 200 with `<KillSwitch engaged={false} onConfirm="/ops/kill-switch" csrfToken={c.get("csrfToken") ?? ""} />`. The csrfToken is drawn fresh from the request context. | T5   |
| FR-6  | **Failure path — daemon throw**: if `resetKillSwitch` throws, the handler MUST: (a) log `kill_switch_reset_failed` at ERROR with `{ error: err.message }`, (b) return HTTP 500 with an error fragment containing the message "Kill switch reset failed. Check daemon logs." and a Retry button (POST submit to `/ops/kill-switch/reset`), (c) **NOT** render the idle state, (d) the kill switch remains engaged on the daemon side (the operator must retry or use a CLI fallback). | T5   |
| FR-7  | The error fragment from FR-6 MUST include a fresh `_csrf` token in its retry form so the next POST is accepted by `csrfMiddleware`.                                                                          | T5   |
| FR-8  | The handler MUST emit `Cache-Control: no-store` on every response.                                                                                                                                            | T5   |
| FR-9  | The handler MUST NOT log the request body. It MUST NOT log on the success path (success is implicit by the 200 response; log volume is reserved for failures).                                              | T5   |
| FR-10 | The handler MUST require an authenticated session (existing `authMiddleware` upstream). On unauthenticated request the middleware returns 401 BEFORE the handler runs.                                       | T5   |
| FR-11 | The handler MUST NOT accept a `confirmation` field. If a request includes one, it is silently ignored — there is no typed-CONFIRM gate on reset (per the rationale in §1).                                  | T5   |

## 3. Non-Functional Requirements

| Requirement                              | Target                                                                          | Measurement                                                       |
|------------------------------------------|----------------------------------------------------------------------------------|-------------------------------------------------------------------|
| Idempotency                               | Two consecutive resets both return 200 + idle fragment                            | Integration test KS-I-R03                                          |
| No silent failure                         | Daemon-throw path returns 500 + ks-error fragment + log line                     | Mock-throw integration test KS-I-R04                               |
| Branch coverage                           | 100% (try/catch arms both exercised)                                              | Coverage gate in CI                                                |
| CSRF parity with engage                   | Both POSTs share the same middleware ordering and the same 403 failure mode      | Integration test KS-I-R02                                          |

## 4. Technical Approach

**File: `plugins/autonomous-dev-portal/server/routes/ops-kill-switch.ts`** (extend the file from SPEC-035-3-02 / -03).

```tsx
opsKillSwitchRoutes.post("/ops/kill-switch/reset", async (c) => {
    // CSRF validated upstream by csrfMiddleware.
    c.header("Cache-Control", "no-store");

    const csrfToken = c.get("csrfToken") ?? "";

    try {
        await operationsHandlers.resetKillSwitch();
    } catch (err) {
        logger.error("kill_switch_reset_failed", {
            error: err instanceof Error ? err.message : String(err),
        });
        return c.html(
            <div class="ks-panel ks-error">
                <div class="ks-status">
                    <h4>Kill switch <span class="chip err">RESET FAILED</span></h4>
                    <div class="meta">Kill switch reset failed. Check daemon logs.</div>
                </div>
                <div class="ks-action">
                    <form method="POST" action="/ops/kill-switch/reset">
                        <input type="hidden" name="_csrf" value={csrfToken} />
                        <button class="btn destructive" type="submit">Retry reset</button>
                    </form>
                </div>
            </div>,
            500,
        );
    }

    return c.html(
        <KillSwitch engaged={false} onConfirm="/ops/kill-switch" csrfToken={csrfToken} />,
    );
});
```

The error fragment is purposely a `<div class="ks-panel ks-error">` (no `armed` modifier — the kill switch is engaged, not armed-to-engage). The retry POST goes to `/reset` (not to `?step=arm`) because the recovery direction is "try reset again," not "re-engage."

## 5. Acceptance Criteria

### AC-1: Missing CSRF (FR-2)
```
Given POST /ops/kill-switch/reset with NO _csrf field
When the request reaches the middleware chain
Then csrfMiddleware returns HTTP 403 BEFORE the handler runs
And the response body does NOT contain "DISENGAGED" or "engaged: false"
And operationsHandlers.resetKillSwitch is NOT called
```

### AC-2: Happy path (FR-3, FR-5)
```
Given POST /ops/kill-switch/reset with valid CSRF and current engaged state
When the handler executes
Then operationsHandlers.resetKillSwitch is called EXACTLY ONCE with no arguments
And response status == 200
And response body contains <span class="chip ok">DISENGAGED</span>
And response body contains the "Engage kill switch" button (idle state)
And response body contains a fresh CSRF token in any subsequent form
And response header Cache-Control == "no-store"
```

### AC-3: Idempotency (FR-4)
```
Given operationsHandlers.resetKillSwitch resolves successfully on already-disengaged state
When two consecutive POSTs are issued (each with valid CSRF)
Then both responses are HTTP 200
And both bodies contain the idle fragment
And resetKillSwitch is called twice (existing daemon contract is idempotent — verified by PLAN-035-3 risk row 6)
And no ERROR log line is emitted on either call
```

### AC-4: Daemon reset failure (FR-6)
```
Given operationsHandlers.resetKillSwitch is mocked to throw new Error("daemon unreachable")
And POST has valid CSRF
When the handler executes
Then logger.error is called with key "kill_switch_reset_failed" and {error: "daemon unreachable"}
And response status == 500
And response body contains <div class="ks-panel ks-error">
And response body contains <span class="chip err">RESET FAILED</span>
And response body contains a "Retry reset" button with action="/ops/kill-switch/reset"
And response body contains a fresh _csrf token in the retry form
And response body does NOT contain "DISENGAGED"
And no success log line is emitted
```

### AC-5: Confirmation field ignored (FR-11)
```
Given POST /ops/kill-switch/reset with confirmation=anything in the body and valid CSRF
When the handler executes
Then the handler does NOT validate the confirmation field
And on resetKillSwitch success returns 200 + idle fragment
```

### AC-6: Auth required (FR-10)
```
Given an unauthenticated request to POST /ops/kill-switch/reset
When the request reaches the middleware chain
Then authMiddleware returns 401 BEFORE the handler runs
And resetKillSwitch is NOT called
```

### AC-7: No success-path logging (FR-9)
```
Given a successful reset (FR-5 path)
When all log handlers are inspected
Then no log entry mentions "kill_switch_reset" (no info, no debug, no error)
And operator-side observability comes only from the 200 response + audit log entry created by the daemon side
```

### AC-8: Cache prevention (FR-8)
```
Given any response from the reset handler (success OR failure)
Then response header Cache-Control == "no-store"
```

## 6. Tests

Tests live in `tests/integration/kill-switch.test.ts` (full table in SPEC-035-3-05). The above ACs map to test rows KS-I-R01..R08.

## 7. Verification

- All 8 ACs pass as integration tests.
- Branch coverage on the reset handler is 100%.
- Manual smoke test: engage kill switch (per SPEC-035-3-03) → click Reset → expect idle re-render.
- Mock-throw smoke: temporarily stub `resetKillSwitch` to throw. Confirm 500 + ks-error fragment + `kill_switch_reset_failed` log line. Confirm Retry button is wired to `/ops/kill-switch/reset` (not to `?step=arm`). Revert stub.
- Idempotency smoke: trigger reset twice in rapid succession; confirm no error, no double-log, both responses idle.
- CSRF parity: confirm `tests/integration/kill-switch.test.ts` exercises the missing-`_csrf` case for BOTH `/ops/kill-switch` and `/ops/kill-switch/reset` and both return 403.
