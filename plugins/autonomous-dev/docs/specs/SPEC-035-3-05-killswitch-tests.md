# SPEC-035-3-05: KillSwitch Integration Test Suite

## Metadata
- **Parent Plan**: PLAN-035-3
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§6.5.7 v1.1, §10.5)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-13)
- **Tasks Covered**: PLAN-035-3 Task 8, Task 9 (manual safety smoke fixtures)
- **Estimated effort**: 0.6 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: SAFETY-CRITICAL — these tests are the gate that prevents regression of any failure-path AC across SPECs 01–04

## 1. Summary

Implement `tests/integration/kill-switch.test.ts` covering the **five
canonical scenarios** required by TDD-035 §10.5 (happy path, expired
armed_at, wrong CONFIRM string, daemon halt failure, missing CSRF) plus
extended coverage from SPEC-035-3-02..04 ACs. The test file boots the
portal in test mode with a stubbed `operationsHandlers` and validates
HTTP responses, headers, log capture, and (via spies) daemon-side
side-effect counts. It is the regression gate for the entire kill-switch
state machine.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                       | Task |
|-------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1  | The file MUST be located at `tests/integration/kill-switch.test.ts` and MUST run under the project's standard `bun test` runner alongside other integration tests.                | T8   |
| FR-2  | The suite MUST boot the portal via the existing test helper (`createTestPortal()` or equivalent — match the harness used by other integration tests in `tests/integration/`).      | T8   |
| FR-3  | The suite MUST stub `operationsHandlers.engageKillSwitch` and `operationsHandlers.resetKillSwitch` with spies (e.g. `vi.fn()` / `mock()` per the project's test runner) so call counts and arguments are observable. The default stub resolves to `undefined`; individual tests opt into throw behavior. | T8   |
| FR-4  | The suite MUST capture log output via the project's test logger sink and assert presence/absence of `kill_switch_engage_failed` and `kill_switch_reset_failed` lines per the AC tables. | T8   |
| FR-5  | Each test MUST issue requests with a valid authenticated session cookie (helper: `authenticatedRequest()` or equivalent) AND a valid CSRF token (helper: `getCsrfToken()` or fetched via a preliminary GET to a CSRF-bearing route). | T8   |
| FR-6  | The suite MUST cover the **five canonical scenarios** from PLAN-035-3 Task 8 / TDD-035 §10.5: happy path, expired armed_at, wrong CONFIRM, daemon halt failure, missing CSRF. Each scenario maps to one test row in the table below. | T8   |
| FR-7  | The suite MUST also cover the extended ACs from SPEC-035-3-02..04 — the GET arm handler (7 rows), all 10 confirm-POST ACs, and all 8 reset-POST ACs — for full state-machine coverage. | T8   |
| FR-8  | The suite MUST be hermetic: no real daemon required; no real timers (use `vi.setSystemTime()` or equivalent for the 30s window test); no shared mutable state between tests (each test resets the spies and the system clock). | T8   |
| FR-9  | The suite MUST run in < 5 seconds total wall time (no real `setTimeout(31s)` waits — use clock mocking).                                                                          | T8   |
| FR-10 | The suite MUST assert HTTP **headers** (`Cache-Control: no-store`, content-type) in addition to status codes and body fragments.                                                  | T8   |

## 3. Test Fixtures

### 3.1 Helper: `armedAt(offsetMs: number = 0): string`
Returns `new Date(Date.now() + offsetMs).toISOString()`. Used to mint armed_at values relative to mocked system time.

### 3.2 Helper: `armRequest(): Promise<{armed_at: string, csrf: string}>`
Issues `GET /ops/kill-switch-modal?step=arm`, parses the response body, extracts `armed_at` and `_csrf` values from the rendered hidden inputs. Used by happy-path test to obtain a valid armed timestamp.

### 3.3 Helper: `confirmPost(body: Record<string,string>): Promise<Response>`
Posts to `/ops/kill-switch` with the given body, attaching the session cookie and the CSRF cookie. Body fields: `_csrf`, `confirmation`, `armed_at`. Caller can omit any field to test missing-field paths.

### 3.4 Helper: `resetPost(body?: Record<string,string>): Promise<Response>`
Posts to `/ops/kill-switch/reset` with the given body (defaults to `{ _csrf: validToken }`).

### 3.5 Spy harness
```ts
const engageKillSwitch = vi.fn().mockResolvedValue(undefined);
const resetKillSwitch = vi.fn().mockResolvedValue(undefined);
beforeEach(() => {
    engageKillSwitch.mockClear();
    resetKillSwitch.mockClear();
    engageKillSwitch.mockResolvedValue(undefined); // reset throw stubs
    resetKillSwitch.mockResolvedValue(undefined);
    logCapture.clear();
});
```

## 4. Test Table — Five Canonical + Extended

### 4.1 Five canonical (PLAN-035-3 Task 8 / TDD-035 §10.5)

| Test ID    | Scenario                       | Expected HTTP | Expected body fragment                          | Spy assertion                              | Log assertion                                   |
|------------|--------------------------------|---------------|-------------------------------------------------|--------------------------------------------|-------------------------------------------------|
| KS-I-CANON1 | Happy path                     | 200           | `<span class="chip err">ENGAGED</span>`         | engageKillSwitch called 1×, args `{reason:"portal-operator-manual"}` | no `kill_switch_engage_failed` line         |
| KS-I-CANON2 | Expired armed_at (31s old)     | 422           | `<div class="ks-panel">` + "Engage kill switch" | engageKillSwitch called 0×                 | no error log                                     |
| KS-I-CANON3 | Wrong CONFIRM (lowercase)      | 422           | `<div class="ks-panel armed">` + retry form     | engageKillSwitch called 0×                 | no error log                                     |
| KS-I-CANON4 | Daemon halt failure            | 500           | `<div class="ks-panel armed ks-error">`         | engageKillSwitch called 1× (and threw)     | `kill_switch_engage_failed` with `{error,armed_at}` |
| KS-I-CANON5 | Missing CSRF                   | 403           | (no kill-switch fragment; middleware response)   | engageKillSwitch called 0×                 | no error log; CSRF middleware logs its own     |

### 4.2 GET arm handler (SPEC-035-3-02)

| Test ID  | Scenario                       | Expected HTTP | Body assertion                                                                          |
|----------|--------------------------------|---------------|-----------------------------------------------------------------------------------------|
| KS-I-A01 | step=arm happy path             | 200           | `<input name="armed_at" value=/^20\d{2}-.*Z$/>` + `<input name="_csrf" value=<token>>` |
| KS-I-A02 | step missing                    | 200           | idle fragment, no armed_at                                                              |
| KS-I-A03 | step=cancel                     | 200           | idle fragment                                                                           |
| KS-I-A04 | Cache-Control header            | 200           | header `Cache-Control: no-store`                                                        |
| KS-I-A05 | armed_at query param ignored    | 200           | server-minted armed_at != injected value                                                |
| KS-I-A06 | unauthenticated                 | 401           | no armed fragment                                                                       |
| KS-I-A07 | concurrent arms                 | 200×2         | two distinct armed_at values                                                            |

### 4.3 Confirm POST (SPEC-035-3-03)

| Test ID  | Scenario                       | Expected HTTP | Body assertion / spy / log                                                              |
|----------|--------------------------------|---------------|-----------------------------------------------------------------------------------------|
| KS-I-C01 | Missing CSRF                   | 403           | engageKillSwitch 0×                                                                     |
| KS-I-C02 | confirmation=lowercase         | 422           | armed fragment; engageKillSwitch 0×                                                     |
| KS-I-C03 | confirmation="CONFIRMx"        | 422           | armed fragment; engageKillSwitch 0×                                                     |
| KS-I-C04 | confirmation=" CONFIRM"        | 422           | armed fragment; engageKillSwitch 0×                                                     |
| KS-I-C05 | armed_at missing                | 422           | "Arming timestamp missing"; engageKillSwitch 0×                                         |
| KS-I-C06 | armed_at expired (31s old)      | 422           | idle fragment; engageKillSwitch 0×; no error log                                        |
| KS-I-C07 | armed_at future-skewed (+10s)   | 422           | idle fragment; engageKillSwitch 0×                                                      |
| KS-I-C08 | armed_at malformed              | 422           | idle fragment; engageKillSwitch 0×                                                      |
| KS-I-C09 | Daemon throw                    | 500           | ks-error fragment + Retry button; engageKillSwitch 1×; `kill_switch_engage_failed` log  |
| KS-I-C10 | Happy path                      | 200           | engaged fragment + reset form + fresh _csrf; engageKillSwitch 1× with reason            |

### 4.4 Reset POST (SPEC-035-3-04)

| Test ID  | Scenario                       | Expected HTTP | Body assertion / spy / log                                                              |
|----------|--------------------------------|---------------|-----------------------------------------------------------------------------------------|
| KS-I-R01 | Missing CSRF                   | 403           | resetKillSwitch 0×                                                                      |
| KS-I-R02 | Happy path                      | 200           | idle fragment + Cache-Control no-store; resetKillSwitch 1×                              |
| KS-I-R03 | Idempotent (two resets)         | 200×2         | both idle; resetKillSwitch 2×; no error log                                             |
| KS-I-R04 | Daemon throw                    | 500           | ks-error fragment + Retry; resetKillSwitch 1×; `kill_switch_reset_failed` log           |
| KS-I-R05 | confirmation field ignored      | 200           | resetKillSwitch 1× (confirmation NOT validated)                                         |
| KS-I-R06 | Unauthenticated                 | 401           | resetKillSwitch 0×                                                                      |
| KS-I-R07 | No success-path logging         | 200           | log capture has 0 lines mentioning "kill_switch_reset"                                  |
| KS-I-R08 | Retry form has fresh _csrf      | 500 → retry path | error-fragment _csrf token is non-empty and a valid CSRF token                       |

## 5. Acceptance Criteria

### AC-1: Five canonical scenarios all pass
```
Given the five canonical tests KS-I-CANON1..5
When the suite runs
Then all five pass with the assertions in §4.1
```

### AC-2: Extended coverage all passes
```
Given the 7 GET tests + 10 confirm-POST tests + 8 reset-POST tests
When the suite runs
Then all 25 extended tests pass
```

### AC-3: Hermeticity
```
Given the suite runs in CI with no real daemon process
And no real wall-clock waits
When the suite executes
Then total wall time < 5 seconds
And no test depends on another test's mutation
And clock is restored after every test (vi.useRealTimers() in afterEach)
```

### AC-4: Spy contract
```
Given engageKillSwitch and resetKillSwitch are stubbed
When any test runs
Then the daemon-side handlers are NOT invoked (the stubs intercept all calls)
And the spy call counts match the per-test expectations exactly
```

### AC-5: Log capture
```
Given the project's test log capture is wired
When KS-I-CANON4 runs (engage failure) and KS-I-R04 runs (reset failure)
Then logCapture contains exactly one ERROR line per test with the expected key and structured fields
And success-path tests (KS-I-CANON1, KS-I-R02) produce no error log lines
```

### AC-6: Failure-path bodies are unmistakable
```
Given any failure-path test (KS-I-CANON4, KS-I-C09, KS-I-R04)
When the response body is parsed
Then it does NOT contain "ENGAGED" (the user-facing success state)
And it DOES contain a Retry mechanism (button or form)
And the Retry mechanism's action URL routes back to a known-safe entry point
     (?step=arm for engage failures; /reset for reset failures)
```

### AC-7: Five canonical scenarios serve as the regression gate
```
Given a future PR modifies any handler in SPEC-035-3-03 or -04
When CI runs
Then any regression in the five canonical scenarios fails the PR
And the PR cannot be merged without re-passing all five
```

## 6. Implementation Notes

- **Clock mocking**: use `vi.useFakeTimers()` + `vi.setSystemTime(date)` in tests that need to advance time past the 30s window. Always `vi.useRealTimers()` in `afterEach` to avoid leakage.
- **CSRF token acquisition**: prefer fetching via a preliminary GET to a CSRF-bearing route (e.g. `/ops/kill-switch-modal`) and parsing the token from the response, rather than synthesizing one — this exercises the real middleware path and catches drift.
- **Body parsing**: use a minimal HTML fragment matcher (regex against the response text is acceptable for this scope; do not pull in a full DOM parser). The exact fragments to match are listed in the AC tables of SPECs 01–04.
- **Stub injection**: the test harness must allow `operationsHandlers` to be replaced before the portal boots. If the existing harness does not support this, add a `__test__` injection point — but minimize the production-code surface.
- **Concurrent test (KS-I-A07)**: use `Promise.all([armRequest(), armRequest()])`; assert the two ISO timestamps differ. If the system clock has insufficient resolution, advance the mocked clock by 1ms between calls.

## 7. Verification

- All 30 tests (5 canonical + 7 GET + 10 confirm + 8 reset) pass under `bun test tests/integration/kill-switch.test.ts`.
- The five canonical tests run in any environment where `bun test` succeeds today — no new infrastructure dependencies.
- Total wall time of the suite is < 5s.
- A deliberate regression PR (e.g. removing the case-sensitivity check in SPEC-035-3-03 FR-4) fails KS-I-C02 with an actionable error message — verified by a one-off reviewer experiment before merge.
- The five canonical scenarios are linked from the PR description as the "do-not-skip" gate for any future change to kill-switch handlers.
