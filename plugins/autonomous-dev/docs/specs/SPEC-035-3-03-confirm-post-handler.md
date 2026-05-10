# SPEC-035-3-03: POST /ops/kill-switch — Confirm + Engage Handler

## Metadata
- **Parent Plan**: PLAN-035-3
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§6.5.7 v1.1)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-13, G-05)
- **Tasks Covered**: PLAN-035-3 Task 4, Task 6 (POST registration)
- **Estimated effort**: 1.0 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: SAFETY-CRITICAL — destructive daemon-halt; **no silent failures**

## 1. Summary

Implement `POST /ops/kill-switch` in
`server/routes/ops-kill-switch.ts`. The handler is the single
authoritative engagement point. It enforces a strict ordered validation
chain; on any failure it returns a non-2xx response with a fragment that
re-establishes a known-safe UI state and **NEVER** records the kill switch
as engaged. On daemon-halt failure the handler MUST also leave the kill
switch un-engaged on the daemon side (the existing
`operationsHandlers.engageKillSwitch` is responsible for its own atomicity)
and emit a structured ERROR log line for operator follow-up.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                                          | Task |
|-------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The handler MUST be registered as `app.post("/ops/kill-switch", handler)` in `server/routes/index.ts`, AFTER the existing `csrfMiddleware` from `server/security/csrf-protection.ts` in the middleware chain (verified via `server/middleware/index.ts` registration order). | T6   |
| FR-2  | **CSRF validation** is performed by the upstream `csrfMiddleware` (existing infrastructure — no re-implementation in the handler). On invalid or missing `_csrf`, the middleware MUST return HTTP 403 BEFORE the handler executes, with no body referencing kill-switch state. The handler MUST NOT bypass, weaken, or wrap the existing middleware. | T4   |
| FR-3  | The handler MUST execute the validation chain in **exactly this order** (each step gates the next): (1) parse body, (2) typed-CONFIRM exact match, (3) `armed_at` present and parseable, (4) `armed_at` within 30s window, (5) invoke daemon halt inside try/catch. | T4   |
| FR-4  | **Step 2 — Typed CONFIRM**: read `body["confirmation"]`. If `typeof confirmation !== "string"` OR `confirmation !== "CONFIRM"` (strict `===`, case-sensitive, exact string), the handler MUST return HTTP 422 with the **armed** `KillSwitch` fragment re-rendered (so the operator can retry without losing the form context). The current `armed_at` value from the body MUST be echoed back into the re-rendered fragment so the 30s window continues to apply. | T4   |
| FR-5  | **Step 3 — armed_at present**: read `body["armed_at"]`. If `typeof armed_at !== "string"`, the handler MUST return HTTP 422 with an error fragment "Arming timestamp missing. Please try again." that contains a Retry button (HTMX GET to `?step=arm`). | T4   |
| FR-6  | **Step 4 — armed_at window**: parse `armedTime = new Date(armed_at).getTime()`. If `Number.isNaN(armedTime)` OR `(Date.now() - armedTime) > 30_000`, the handler MUST return HTTP 422 with the **idle** `KillSwitch` fragment re-rendered (the armed state has expired; the operator must re-arm). The handler MUST NOT log this as an ERROR — it is a normal expiry. | T4   |
| FR-7  | **Step 4a — clock-skew safety**: if `(Date.now() - armedTime) < -5_000` (armed_at is more than 5s in the future), the handler MUST treat this as invalid and return HTTP 422 with the idle fragment (defense against forged or replayed timestamps from misconfigured clients). | T4   |
| FR-8  | **Step 5 — daemon halt**: invoke `await operationsHandlers.engageKillSwitch({ reason: "portal-operator-manual" })` inside a `try/catch`. The reason string is fixed and MUST NOT be sourced from the request body. | T4   |
| FR-9  | **Failure path — daemon throw**: if `engageKillSwitch` throws, the handler MUST: (a) log `kill_switch_engage_failed` at ERROR with `{ error: err.message, armed_at }`, (b) return HTTP 500 with the `<div class="ks-panel armed ks-error">` fragment per TDD §6.5.7 lines 832–854 (containing a Retry button), (c) **NOT** render the engaged state, (d) **NOT** emit any "engaged" log entry. The kill switch state remains un-engaged. | T4   |
| FR-10 | **Success path**: on `engageKillSwitch` resolution, the handler MUST return HTTP 200 with `<KillSwitch engaged={true} onConfirm="/ops/kill-switch" csrfToken={c.get("csrfToken") ?? ""} />`. The csrfToken on the engaged form MUST be a fresh value drawn from the request context (so the subsequent reset POST validates). | T4   |
| FR-11 | The handler MUST emit `Cache-Control: no-store` on every response.                                                                                                                                                     | T4   |
| FR-12 | The handler MUST NOT log the request body verbatim (the `confirmation` field is intentionally `CONFIRM` and not sensitive, but routing log content through structured loggers prevents future drift).               | T4   |
| FR-13 | The handler MUST NOT mutate any persistent state on failure. The only state mutation is the underlying daemon halt via `operationsHandlers.engageKillSwitch`, which only occurs after all four prior validations pass. | T4   |

## 3. Non-Functional Requirements

| Requirement                              | Target                                                                          | Measurement                                                       |
|------------------------------------------|----------------------------------------------------------------------------------|-------------------------------------------------------------------|
| Validation order is strict                | No step can short-circuit a later one; each tested independently                  | Per-step integration tests (KS-I-C04..C08)                         |
| No silent failure paths                   | Every code path returns a non-2xx response with a known fragment OR returns 200 + engaged | Code-coverage gate: 100% branch coverage on the handler           |
| Daemon-halt atomicity                     | If the daemon command throws, no engaged-state response is returned              | Mock-throw integration test asserts 500 + ks-error fragment        |
| CSRF middleware ordering                  | `csrfMiddleware` registers before `/ops/*` POST routes                            | `server/middleware/index.ts` static review + integration test KS-I-C04 |

## 4. Technical Approach

**File: `plugins/autonomous-dev-portal/server/routes/ops-kill-switch.ts`** (extend the file from SPEC-035-3-02).

```tsx
opsKillSwitchRoutes.post("/ops/kill-switch", async (c) => {
    // (1) CSRF: validated upstream by csrfMiddleware. On reach: trusted.
    c.header("Cache-Control", "no-store");

    const body = await c.req.parseBody();
    const confirmation = body["confirmation"];
    const armedAt = body["armed_at"];
    const csrfToken = c.get("csrfToken") ?? "";

    // (2) Typed CONFIRM
    if (typeof confirmation !== "string" || confirmation !== "CONFIRM") {
        return c.html(
            <KillSwitch
                engaged={false}
                armed={true}
                armedAt={typeof armedAt === "string" ? armedAt : ""}
                csrfToken={csrfToken}
                onConfirm="/ops/kill-switch"
            />,
            422,
        );
    }

    // (3) armed_at present
    if (typeof armedAt !== "string") {
        return c.html(errorFragment("Arming timestamp missing. Please try again."), 422);
    }

    // (4) armed_at window
    const armedTime = new Date(armedAt).getTime();
    const skew = Date.now() - armedTime;
    if (Number.isNaN(armedTime) || skew > 30_000 || skew < -5_000) {
        return c.html(
            <KillSwitch engaged={false} onConfirm="/ops/kill-switch" csrfToken={csrfToken} />,
            422,
        );
    }

    // (5) Daemon halt
    try {
        await operationsHandlers.engageKillSwitch({ reason: "portal-operator-manual" });
    } catch (err) {
        logger.error("kill_switch_engage_failed", {
            error: err instanceof Error ? err.message : String(err),
            armed_at: armedAt,
        });
        return c.html(killSwitchErrorFragment(), 500);
    }

    return c.html(
        <KillSwitch engaged={true} onConfirm="/ops/kill-switch" csrfToken={csrfToken} />,
    );
});
```

The error fragment helper renders `<div class="ks-panel armed ks-error">` with status chip "ERROR", meta text "Daemon halt command failed. Kill switch was NOT engaged. Check daemon logs and retry.", and a Retry button that GETs `/ops/kill-switch-modal?step=arm` to restart the flow.

## 5. Acceptance Criteria

### AC-1: Missing CSRF (FR-2)
```
Given a POST /ops/kill-switch with NO _csrf field in the body
When the request reaches the middleware chain
Then csrfMiddleware returns HTTP 403 BEFORE the handler runs
And the response body does NOT contain "engaged" or "ENGAGED"
And operationsHandlers.engageKillSwitch is NOT called
```

### AC-2: Wrong CONFIRM string — case mismatch (FR-4)
```
Given a POST with confirmation=confirm (lowercase) and valid CSRF + armed_at
When the handler runs
Then response status == 422
And response body contains <div class="ks-panel armed">
And response body contains <input name="armed_at" value="<original-armed_at>">
And operationsHandlers.engageKillSwitch is NOT called
And the operator can re-submit with confirmation=CONFIRM within the original 30s window
```

### AC-3: Wrong CONFIRM string — substring (FR-4)
```
Given POST with confirmation="CONFIRMx" (substring + extra)
Then response status == 422; armed fragment re-rendered; daemon NOT called
Given POST with confirmation=" CONFIRM" (leading space)
Then response status == 422; armed fragment re-rendered; daemon NOT called
Given POST with confirmation="Confirm" (mixed case)
Then response status == 422; armed fragment re-rendered; daemon NOT called
```

### AC-4: Missing armed_at (FR-5)
```
Given a POST with confirmation=CONFIRM, valid CSRF, but armed_at field absent
When the handler runs
Then response status == 422
And body contains "Arming timestamp missing"
And body contains a Retry button with hx-get="/ops/kill-switch-modal?step=arm"
And operationsHandlers.engageKillSwitch is NOT called
```

### AC-5: Expired armed_at (FR-6)
```
Given a POST with confirmation=CONFIRM, valid CSRF, armed_at=ISO(now - 31s)
When the handler runs
Then response status == 422
And body contains <div class="ks-panel"> (idle, no "armed" modifier)
And body contains the "Engage kill switch" button (idle action)
And operationsHandlers.engageKillSwitch is NOT called
And NO ERROR log line is emitted (this is a normal expiry, not an error)
```

### AC-6: Future-skewed armed_at (FR-7)
```
Given a POST with armed_at = ISO(now + 10s) (10 seconds in the future)
When the handler runs
Then response status == 422; idle fragment returned; daemon NOT called
```

### AC-7: Malformed armed_at (FR-6)
```
Given a POST with armed_at="not-a-date"
When the handler runs
Then Number.isNaN(new Date(armed_at).getTime()) is true
And response status == 422; idle fragment returned; daemon NOT called
```

### AC-8: Daemon halt failure (FR-9)
```
Given operationsHandlers.engageKillSwitch is mocked to throw new Error("daemon unreachable")
And POST passes all four prior validations
When the handler executes
Then logger.error is called with key "kill_switch_engage_failed" and {error: "daemon unreachable", armed_at}
And response status == 500
And response body contains <div class="ks-panel armed ks-error">
And response body contains <span class="chip err">ERROR</span>
And response body contains a Retry button (hx-get to ?step=arm)
And response body does NOT contain "ENGAGED"
And no "engaged" log line is emitted
```

### AC-9: Happy path (FR-3, FR-8, FR-10)
```
Given POST with valid CSRF + confirmation=CONFIRM + armed_at=ISO(now - 5s)
When the handler executes
Then operationsHandlers.engageKillSwitch is called EXACTLY ONCE with {reason: "portal-operator-manual"}
And response status == 200
And response body contains <span class="chip err">ENGAGED</span>
And response body contains <form method="POST" action="/ops/kill-switch/reset">
And response body contains a fresh CSRF token in the reset form's _csrf input
And response header Cache-Control == "no-store"
```

### AC-10: Validation order — short-circuit (FR-3)
```
Given POST with confirmation=wrong AND armed_at expired AND CSRF valid
When the handler runs
Then it returns 422 with the ARMED fragment (CONFIRM check fires first per FR-3)
And the expired-armed_at idle fragment is NOT returned
And operator sees retry path consistent with their actual action
```

## 6. Tests

Tests live in `tests/integration/kill-switch.test.ts` (full table in SPEC-035-3-05). The above ACs map 1:1 to test rows KS-I-C01..C10.

## 7. Verification

- All 10 ACs pass as integration tests.
- Branch coverage on the handler is 100% (every `if`/`try`/`catch` branch exercised).
- Static review: `csrfMiddleware` is registered before `/ops/*` POST in `server/middleware/index.ts`. PR reviewer confirms via diff annotation.
- Manual safety smoke: load Ops page, click Engage → wait 31s → type CONFIRM → submit. Expect 422 + idle re-render. Re-arm + submit within 30s. Expect engaged.
- Mock-throw smoke: temporarily stub `engageKillSwitch` to throw. Confirm 500 + ks-error fragment + log line. Revert stub.
- No log line `kill_switch_engaged_succeeded` (or equivalent positive event) is emitted on the failure path — verified by log capture in mock-throw integration test.
