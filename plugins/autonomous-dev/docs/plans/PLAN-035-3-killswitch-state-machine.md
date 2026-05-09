# PLAN-035-3: KillSwitch Primitive and State Machine

## Metadata
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 4 days
- **Dependencies**: ["PLAN-034-1", "PLAN-035-2"]
- **Blocked by**: ["PLAN-034-1"] (tokens), ["PLAN-035-2"] (uses `Btn` primitive in three states)
- **Priority**: P0 (safety-critical — gates Ops surface adoption in TDD-018-C)
- **Stage**: Phase 2 of TDD-035 §11 rollout (shipped alongside shell + brand because the rail ops bar exposes `Engage kill switch`)

## Objective

Land the `KillSwitch` primitive component and its complete server-side state
machine per TDD-035 §6.5.7 v1.1. This is the most safety-sensitive surface in
the redesign — the action of last resort during a runaway daemon — and the
TDD calls it out separately from the other six primitives because the
correctness bar (CSRF, typed CONFIRM, 30-second armed window, daemon-halt
failure handling, HTMX outerHTML swap pattern) materially exceeds the other
primitives combined.

Concretely this plan delivers:

1. `KillSwitch` FC added to `server/components/primitives.tsx` with the prop signature `{engaged, onConfirm, armed?, armedAt?, csrfToken?}` per TDD §6.5.7.
2. Three rendered states: idle (`<button class="btn destructive">Engage kill switch</button>` with HTMX GET), armed (form with hidden `_csrf` + hidden `armed_at` + `pattern="CONFIRM"` input + `<button class="btn destructive" type="submit">`), engaged (form POSTing to `{onConfirm}/reset` with hidden `_csrf` + reset button).
3. `server/routes/ops-kill-switch.ts` (or extension of the existing ops route file) implementing three handlers:
   - `GET /ops/kill-switch-modal?step=arm` — returns the armed-state HTMX fragment with a fresh `armedAt = new Date().toISOString()` and the request's CSRF token.
   - `POST /ops/kill-switch` — validates CSRF (via `csrfMiddleware`), validates `confirmation === "CONFIRM"` (case-sensitive, returns 422 + armed re-render on mismatch), validates `armed_at` ISO timestamp is within a 30-second window (returns 422 + idle fragment on expiry), invokes `operationsHandlers.engageKillSwitch({reason: "portal-operator-manual"})`, returns engaged fragment on success or `.ks-panel.ks-error` 500 fragment with retry button on daemon failure.
   - `POST /ops/kill-switch/reset` — validates CSRF, calls `operationsHandlers.resetKillSwitch()`, returns idle fragment on success or error fragment + log on failure.
4. KillSwitch CSS in `portal.css`: `.ks-panel`, `.ks-panel.armed` (`border-color: var(--err-line); background: var(--err-tint)`), `.ks-panel.ks-error`, `.ks-status`, `.ks-action`, `.ks-confirm-label`. Inputs reuse `.input.mono`.
5. Structured logs `kill_switch_engage_failed` and `kill_switch_reset_failed` per TDD-035 §9.
6. Unit tests for the three KillSwitch render states + integration tests for the four POST validation paths (happy / wrong CONFIRM / expired armed_at / missing CSRF).
7. Wiring for the `kbtn` button in `RailOpsBar` (PLAN-035-1) — the HTMX swap target `#modal-slot` is consumed by this plan's GET handler.

## Scope

### In Scope
- `KillSwitch` FC implementation (added to the same `primitives.tsx` file from PLAN-035-2 to keep the seven primitives co-located).
- All three route handlers (arm GET, engage POST, reset POST).
- CSRF integration via the existing `csrfMiddleware` from `server/security/csrf-protection.ts` — no new middleware, no bypass.
- `armed_at` 30-second window validation on the server (the timestamp lives in the form's hidden input — no server-side session state).
- Daemon-halt failure handling: if `operationsHandlers.engageKillSwitch()` throws, the kill switch state is NOT marked engaged, an error fragment with retry is returned, and the failure is logged at ERROR level.
- Reset flow: `operationsHandlers.resetKillSwitch()` invocation with matching error handling.
- KillSwitch CSS in `portal.css`.
- Unit tests covering the four KillSwitch rows in TDD-035 §10.1 (disengaged chip, engaged chip, armed CONFIRM input + hidden armed_at, armed CSRF input).
- Integration tests covering the four POST scenarios in TDD-035 §10.5 (valid happy path, expired armed_at, wrong confirmation, missing CSRF).

### Out of Scope
- The other six primitives — PLAN-035-2 (this plan depends on `Btn`).
- The shell, rail, and the `kbtn` button in `RailOpsBar` itself — PLAN-035-1 (this plan is the route target for that button's HTMX action).
- The `/design-system` preview card for KillSwitch — PLAN-035-4 (which renders both disengaged and engaged states for visual regression).
- Re-implementing or replacing `operationsHandlers.engageKillSwitch()` / `resetKillSwitch()` — those handlers already exist in the daemon; this plan only consumes them.
- New CSRF middleware or auth changes — strict reuse of existing portal infrastructure.
- Audit-log integration beyond the structured-log lines (audit infra is owned by a separate TDD).

## Tasks

1. **Implement `KillSwitch` FC in `primitives.tsx`.** Prop signature `{engaged, onConfirm, armed?, armedAt?, csrfToken?}` per TDD §6.5.7. Render the three states per the rendered-HTML examples in §6.5.7: idle uses `Btn kind="destructive"` with `hx-get={`${onConfirm}?step=arm`}` `hx-target="closest .ks-panel"` `hx-swap="outerHTML"`; armed uses a `<form method="POST" action={onConfirm}>` with two hidden inputs (`_csrf`, `armed_at`), an `<input pattern="CONFIRM" name="confirmation" autocomplete="off" required>`, and a `Btn kind="destructive" type="submit">Confirm engage</Btn>`; engaged uses `<form method="POST" action={`${onConfirm}/reset`}>` with hidden `_csrf` and a non-destructive `Btn` for "Reset kill switch". The status chip uses `Chip variant="status"` with tone `ok`/DISENGAGED or tone `err`/ENGAGED. Effort: 0.75 day.

2. **Add KillSwitch CSS to `portal.css`.** `.ks-panel` (1px `var(--line-1)` border, 3px radius, padding), `.ks-panel.armed` (`border-color: var(--err-line); background: var(--err-tint)`), `.ks-panel.ks-error` (same `--err` palette + a small icon position), `.ks-status` (flex row with chip + meta text), `.ks-action` (button row), `.ks-confirm-label` (mono 11px, color `var(--err)`). Inputs reuse `.input.mono` defined elsewhere in the redesign — confirm it exists or stub it. No box-shadow per R-15a. Effort: 0.4 day.

3. **Implement `GET /ops/kill-switch-modal?step=arm` handler.** In `server/routes/ops-kill-switch.ts` (or wherever the existing ops routes live). Generate `armedAt = new Date().toISOString()`; read `c.get("csrfToken")` (set by `csrfMiddleware`); render `<KillSwitch engaged={false} armed={true} armedAt={armedAt} csrfToken={csrfToken} onConfirm="/ops/kill-switch" />` and return as HTML so HTMX can `outerHTML`-swap it into `closest .ks-panel`. If `step !== "arm"`, return the idle fragment (defensive default). Effort: 0.4 day.

4. **Implement `POST /ops/kill-switch` handler.** Steps in order per TDD §6.5.7:
   1. CSRF validation (handled upstream by `csrfMiddleware` — by handler entry, CSRF is already validated).
   2. Parse body via `c.req.parseBody()`; extract `confirmation` and `armed_at`.
   3. Reject `confirmation !== "CONFIRM"` (case-sensitive, exact-string equality) → return 422 + armed-state re-render so the operator can retry.
   4. Reject missing or non-string `armed_at` → return 422 + error fragment "Arming timestamp missing".
   5. Reject `Number.isNaN(armedTime)` or `now - armedTime > 30_000` → return 422 + idle re-render (the armed state has expired).
   6. Invoke `operationsHandlers.engageKillSwitch({reason: "portal-operator-manual"})` inside a try/catch.
   7. On exception: log `kill_switch_engage_failed` at ERROR with `{error, armed_at}`, return 500 + `.ks-panel.ks-error` fragment with a retry button (HTMX GET to `?step=arm`). Do NOT mark engaged.
   8. On success: return engaged fragment with fresh CSRF token for the reset form.
   Effort: 0.8 day.

5. **Implement `POST /ops/kill-switch/reset` handler.** CSRF already validated by middleware. Call `operationsHandlers.resetKillSwitch()` inside a try/catch. On exception: log `kill_switch_reset_failed` at ERROR, return 500 + error fragment. On success: return idle fragment with fresh CSRF token. Effort: 0.3 day.

6. **Register routes in `server/routes/index.ts`.** Three new entries: `app.get("/ops/kill-switch-modal", ...)`, `app.post("/ops/kill-switch", ...)`, `app.post("/ops/kill-switch/reset", ...)`. Verify the existing `csrfMiddleware` covers the two POST routes via the middleware-chain registration order. Effort: 0.1 day.

7. **Unit tests for `KillSwitch` (`tests/unit/components/primitives.test.tsx`).** Four assertions from TDD §10.1: (a) disengaged renders `.chip.ok` containing `DISENGAGED`; (b) engaged renders `.chip.err` containing `ENGAGED`; (c) armed renders `<input name="armed_at">` plus `<input name="confirmation" pattern="CONFIRM">`; (d) armed renders `<input type="hidden" name="_csrf">` with the supplied token. Effort: 0.3 day.

8. **Integration tests for KillSwitch routes.** Five scenarios from TDD §10.5 + §6.5.7:
   - Happy path: GET arm → fragment includes `armed_at`; POST with `confirmation=CONFIRM` + valid armed_at + valid CSRF → 200 + engaged fragment + daemon engage called once.
   - Expired armed_at: POST with armed_at older than 30 seconds → 422 + idle fragment.
   - Wrong CONFIRM: POST with `confirmation=confirm` (lowercase) → 422 + armed fragment (allows retry).
   - Missing CSRF: POST without `_csrf` → 403 (middleware rejects before handler runs).
   - Daemon halt failure: mock `operationsHandlers.engageKillSwitch` to throw → 500 + `.ks-panel.ks-error` fragment + `kill_switch_engage_failed` log line.
   Effort: 0.6 day.

9. **Manual safety smoke.** End-to-end: load Ops page, click Engage in rail → modal appears → wait 31 seconds, type CONFIRM, submit → expect 422 + idle re-render (timeout enforced). Repeat within 30s → expect engaged. Click Reset → expect idle. Verify in audit log that engage and reset were recorded by the daemon side. Effort: 0.15 day.

## Verification

- All four KillSwitch unit-test rows in TDD-035 §10.1 pass.
- All four KillSwitch integration-test rows in TDD-035 §10.5 pass.
- Daemon-halt failure path: when `engageKillSwitch` throws, the response is 500, the rendered fragment has class `ks-panel ks-error`, the log line `kill_switch_engage_failed` is emitted with the error message and armed_at, and `engaged` is NOT mutated.
- 30-second armed window: POST with armed_at older than 30s returns 422 with the idle fragment; with armed_at within 30s returns 200 with the engaged fragment.
- Typed CONFIRM is case-sensitive: lowercase `confirm` is rejected; mixed-case `Confirm` is rejected; only exact `CONFIRM` engages.
- CSRF middleware catches the missing-token POST before the handler runs (manual test or middleware unit test confirms 403 status).
- HTMX `hx-target="closest .ks-panel"` + `hx-swap="outerHTML"` correctly replaces the panel on each state transition.
- The rail ops bar `kbtn` (from PLAN-035-1) successfully triggers the GET handler — manual smoke confirms the modal renders into `#modal-slot`.

## Test Plan

- **Unit (Hono JSX)**: extend `tests/unit/components/primitives.test.tsx` with the four KillSwitch rows. Each test renders `<KillSwitch ... />` with one state's prop combination and asserts class/attribute/text presence.
- **Integration (HTTP)**: `tests/integration/kill-switch.test.ts` boots the portal in test mode and exercises:
  1. GET `/ops/kill-switch-modal?step=arm` → 200 with armed fragment, CSRF token present, ISO armed_at present.
  2. POST `/ops/kill-switch` happy path → 200 + engaged fragment + spy on `operationsHandlers.engageKillSwitch` called once with `reason: "portal-operator-manual"`.
  3. POST with armed_at 31 seconds old → 422 + idle fragment.
  4. POST with `confirmation` mismatched → 422 + armed fragment.
  5. POST without `_csrf` → 403.
  6. POST with mocked throw on `engageKillSwitch` → 500 + ks-error fragment + log line captured.
  7. POST `/ops/kill-switch/reset` happy path → 200 + idle fragment + spy on `resetKillSwitch` called once.
  8. POST `/ops/kill-switch/reset` with mocked throw → 500 + error fragment + `kill_switch_reset_failed` log.
- **Security**: assert the typed-CONFIRM matches the existing `typed-confirm-modal.tsx` pattern (FR-S12 reuse).
- **Manual smoke**: timeout test (31s wait), three-browser CSRF test, and audit-log spot check.

## Rollback

Rollback is `git revert <commit-sha>` of the single PR. Risks of half-rolled-back state:
- If `KillSwitch` ships but routes do not, the rail-ops `kbtn` button GET will 404 — the operator sees a broken modal but the daemon is unaffected. Acceptable interim.
- If routes ship but `KillSwitch` does not, the routes are unreachable through the UI but still functional via direct POST. Acceptable interim.

The safer recovery path is to land the full plan and revert wholesale rather than partial. Before merging, verify the full PR diff: component + routes + CSS + tests must all be present. After merge, if the daemon-halt path mis-behaves, the immediate rollback also re-disables the GET arming endpoint — operators retain CLI access to the daemon kill switch (existing CLI surface, not affected by this plan).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `armed_at` window allows a stale form to be replayed if an operator left a tab open | Low | Critical | 30-second window enforced server-side; replay after 30s returns 422 + idle. CSRF token ties the request to the session. |
| CSRF middleware order mis-registration causes the POST to bypass validation | Low | Critical | Integration test "missing CSRF returns 403" is the gate. Reviewer rubric: confirm `csrfMiddleware` registers before `/ops/*` routes per `server/middleware/index.ts`. |
| Typed-CONFIRM check uses loose equality and accepts `confirm` (lowercase) | Low | High | Test asserts lowercase rejected; use strict `===` against literal `"CONFIRM"`. Pattern attribute on the input is a defense-in-depth (browser-side regex) but server is authoritative. |
| Daemon throws on `engageKillSwitch` and the handler still returns engaged fragment | Low | Critical | Try/catch wraps the call; on throw, log + 500 + ks-error fragment + no state mutation. Integration test mocks the throw and asserts the error fragment is rendered. |
| HTMX `outerHTML` swap leaves the form orphaned if the response is non-2xx | Medium | Low | HTMX 422 responses still trigger the swap by default; the returned fragment includes the full `<div class="ks-panel">` so the panel is replaced on every error path. Verified by integration test. |
| Operator types CONFIRM, network drops between submit and response, retries with stale armed_at | Medium | Medium | If the daemon engaged on the first request but the response was lost, the second request will see armed_at within 30s and try to engage again — `engageKillSwitch` should be idempotent on the daemon side. If not idempotent, the second request returns 422 / 500 — operator sees error, daemon already halted. Logged for operator follow-up. Document this in TDD-018-C operations runbook. |
| `reason: "portal-operator-manual"` string drifts from the daemon's expected reason vocabulary | Low | Low | The daemon accepts free-form reasons; this string is only used for audit logs. No coupling. |

## Definition of Done

- [ ] `KillSwitch` FC in `primitives.tsx` with prop signature `{engaged, onConfirm, armed?, armedAt?, csrfToken?}`.
- [ ] Three render states (idle, armed, engaged) match the TDD §6.5.7 rendered-HTML examples exactly.
- [ ] KillSwitch CSS classes (`.ks-panel`, `.ks-panel.armed`, `.ks-panel.ks-error`, `.ks-status`, `.ks-action`, `.ks-confirm-label`) added to `portal.css`; no box-shadow outside `--shadow-*` tokens.
- [ ] Three route handlers implemented; CSRF middleware covers both POSTs.
- [ ] Typed CONFIRM is case-sensitive exact match.
- [ ] `armed_at` 30-second window enforced server-side.
- [ ] Daemon-halt failure returns 500 + `.ks-panel.ks-error` fragment + log line; engaged state is NOT recorded.
- [ ] Reset handler implemented; logs failures.
- [ ] Routes registered in `routes/index.ts`.
- [ ] Four KillSwitch unit-test rows + five integration-test scenarios all pass.
- [ ] Manual safety smoke (timeout, happy path, daemon-failure mock) passes.
- [ ] No coupling to new middleware — strict reuse of existing CSRF, auth, and daemon-handler infrastructure.
