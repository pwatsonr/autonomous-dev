# SPEC-015-2-05: Tests — Approval Flow with Mocked Router, Settings Round-Trip, HTTP-Client Retry

## Metadata
- **Parent Plan**: PLAN-015-2
- **Tasks Covered**: Task 11 (end-to-end integration tests) plus the unit-test bundles for SPEC-015-2-01 through SPEC-015-2-04
- **Estimated effort**: 6 hours

## Description

Build the test harness and the comprehensive test suites for PLAN-015-2 deliverables: a `MockIntakeRouter` HTTP server fixture, an in-memory state.json factory, and three top-level test suites covering (1) the approval gate end-to-end flow, (2) the settings editor round-trip with validation and daemon-reload signaling, and (3) the HTTP client's retry/timeout/error-classification behavior. Tests run against the real portal server (Bun + Hono) bound to a random ephemeral port, with the mock intake router on another ephemeral port. No browser is launched; HTMX behavior is verified via response-fragment HTML inspection. The modal flow is tested in jsdom for CustomEvent dispatch and focus management.

This spec is the canonical place to look up "where does feature X get tested?" for any of the four sibling specs.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `tests/portal/fixtures/mock-intake-router.ts` | Create | Standalone Hono app with command recording + behavior modes |
| `tests/portal/fixtures/state-factory.ts` | Create | `createState(repoDir, requestId, overrides)` writes valid state.json |
| `tests/portal/fixtures/portal-test-server.ts` | Create | Boots the real portal pointing at the mock router |
| `tests/portal/fixtures/csrf-helper.ts` | Create | `fetchCsrfToken(baseUrl)` |
| `tests/portal/approval-gate-flow.test.ts` | Create | Suite 1 — approve/reject/changes integration |
| `tests/portal/settings-mutation-flow.test.ts` | Create | Suite 2 — settings round-trip + reload |
| `tests/portal/intake-router-client.test.ts` | Create | Suite 3 — HTTP client retry/timeout/error mapping |
| `tests/portal/gate-confirmation-modal.test.ts` | Create | Modal lifecycle in jsdom |
| `tests/portal/idempotent-rerender.test.ts` | Create | Reload-after-action behavior |
| `package.json` | Modify | Add `test:portal` script |

## Implementation Details

### Fixtures

**`MockIntakeRouter`** — Hono app on a random Bun-served port. Records every `POST /router/command` body. Modes set via `setBehavior(mode, count?)`:
- `'ok'` (default): always 200 with `{commandId: 'mock-N', data: {}}`
- `'fail-permanent'`: always 422 with `{error:'Mock validation error', errorCode:'INVALID_TRANSITION'}`
- `'fail-transient'`: always 503
- `'fail-then-ok'` with `count`: 503 for the first `count` requests, then 200

API: `start()`, `stop()`, `getReceivedCommands()`, `reset()`, `setBehavior(mode, count?)`. Also serves `GET /router/health` returning `{version: '1.0-mock'}`.

**`createState(repoDir, requestId, overrides)`** — writes a syntactically valid state.json to `<repoDir>/.autonomous-dev/requests/<requestId>/state.json`. Overrides: `status`, `cost`, `ageHours` (sets `created_at = now - ageHours*3600s`), `escalatedAt`, `phaseHistory`. Returns the written path.

**`startPortal({intakePort, repoRoot, userConfigPath?})`** — boots the real portal app with an `IntakeRouterClient` injected with `port: intakePort`. Returns `{ url, stop }`. Settings tests pass a temp `userConfigPath` so the real `~/.claude/autonomous-dev.json` is never touched.

**`fetchCsrfToken(baseUrl)`** — GETs the portal home page and extracts the CSRF token via the existing PLAN-014-2 cookie/header convention. Returns the token string for use in subsequent POST headers.

### Suite 1 — Approval Gate Flow (`approval-gate-flow.test.ts`)

Setup: per-test `mkdtemp` repo root, fresh `MockIntakeRouter`, fresh portal pointing at it. Teardown: stop server + rm dir.

Tests:
1. **Approve low-cost happy** — state pending, cost 25. POST `/gate/approve`. Assert: 200; HTML contains "Approved by"; mockRouter received exactly one command with `command:'approve', targetRequestId:'REQ-1', source:'portal'`.
2. **Reject high-cost no token** — state pending, cost 75. POST `/gate/reject` without token. Assert: 428; mockRouter received 0 commands.
3. **Reject high-cost with valid token** — POST `/gate/confirm-token` first, retrieve token, POST `/gate/reject` with `{confirmationToken, comment:"too expensive"}`. Assert: 200; mockRouter received one `reject` command. Reuse same token: returns 200 idempotent, mockRouter still has 1 command.
4. **Idempotent re-render** — state already approved. POST `/gate/approve`. Assert: 200; HTML contains "Approved"; mockRouter received 0 commands.
5. **Request-changes empty comment** — POST with `comment=''`. Assert: 422; HTML contains "Comment is required"; mockRouter received 0.
6. **Intake transient → 503** — `mockRouter.setBehavior('fail-transient')`. POST `/gate/approve`. Assert: 503; HTML contains `class="service-error"`.
7. **Escalation badge on aged request** — `createState(..., {ageHours: 25})`. GET request detail page. Assert: HTML contains `escalation-badge` and the word "Escalated".

### Suite 2 — Settings Mutation Flow (`settings-mutation-flow.test.ts`)

Tests:
1. **Cost-cap change → config-set + daemon-reload** — POST `/settings` with `costCaps.daily=25, costCaps.monthly=700`. Assert: 200; mockRouter has both `config-set` and `daemon-reload` commands.
2. **Invalid daily cap → 422 sticky** — POST `costCaps.daily=0`. Assert: 422; HTML contains `value="0"` AND `<div class="field-error">`; mockRouter has 0 commands.
3. **Notifications-only no reload** — POST `notifications.email.to=op@example.com`. Assert: 200; mockRouter has `config-set` only, NO `daemon-reload`.
4. **Allowlist non-git → 422** — POST `allowlist[]=<repoRoot>` (exists but no `.git`). Assert: 422; HTML matches `/not a git repository/i`.
5. **Allowlist outside roots → 422** — POST `allowlist[]=/etc/passwd`. Assert: 422.
6. **Audit log captures keys not values** — POST `costCaps.daily=50`. Read audit entries. Assert: latest entry has `changedKeys` containing `'costCaps.daily'`; `JSON.stringify(entry)` does NOT contain `"50"`.
7. **Daemon-reload failure non-fatal** — Configure mockRouter to succeed `config-set` but fail `daemon-reload` (use a counter or per-command behavior switch). Assert: 200 to user; logs contain reload failure message.

### Suite 3 — IntakeRouterClient (`intake-router-client.test.ts`)

Tests against `MockIntakeRouter` directly (no portal in this suite).

1. **Happy path** — single attempt; `success:true`; mockRouter has 1 command.
2. **Retry-then-success** — `setBehavior('fail-then-ok', 2)`. Assert: `success:true`; mockRouter has 3 calls; elapsed ≥ 100ms (some jittered backoff occurred).
3. **Exhausts retries** — `setBehavior('fail-transient')`. Assert: `success:false, errorCode:'NETWORK_TRANSIENT'`; mockRouter has 3 calls.
4. **No retry on 422** — `setBehavior('fail-permanent')`. Assert: 1 call; `errorCode:'INVALID_TRANSITION'`.
5. **Client validation rejects bad source** — `submitCommand({source:'cli'})`. Assert: `errorCode:'CLIENT_VALIDATION'`; mockRouter has 0 calls.
6. **healthCheck happy** — Assert: `{healthy:true, version:'1.0-mock', latencyMs:>=0}`.
7. **healthCheck no retry on failure** — stop mockRouter, then call. Assert: `healthy:false` returned without retry storms.
8. **Timeout aborts after 5s** — fixture endpoint that delays 6s. Assert: AbortError received within 5.5s; classified transient; retried (3 attempts within ~16s). Test timeout = 20 000ms.

### Suite 4 — Gate Confirmation Modal (`gate-confirmation-modal.test.ts`)

jsdom-based unit tests. Setup `document.body.innerHTML` with a panel + form + modal partial. Initialize `GateConfirmationController`.

1. **Open modal on event** — dispatch `gate:requires-confirm`. Assert: modal `aria-hidden` toggled to false; modal visible.
2. **Submit disabled until exact match** — type "rej" then "REJEC" then "REJECT". Assert: submit disabled, disabled, enabled (case-sensitive).
3. **Cancel returns focus to button** — click cancel. Assert: `document.activeElement` is the originating reject button.
4. **Successful confirm injects token + triggers htmx submit** — type "REJECT", click submit. Assert: hidden input `name="confirmationToken"` exists in form with the minted value; `htmx.trigger` called with `(form, 'submit')`.
5. **Lower-case "reject" does NOT enable** — type "reject". Assert: submit remains disabled.
6. **ESC dismisses modal** — keydown ESC. Assert: modal hidden; promise resolves `{confirmed:false}`.

### Suite 5 — Idempotent Re-render (`idempotent-rerender.test.ts`)

1. **Reload after approve shows resolved** — `createState({status:'pending-approval'})`; POST approve; rewrite state to `status:'approved'` (simulating intake commit); GET request detail. Assert: HTML contains "Approved"; HTML does NOT contain `class="gate-approve"`.
2. **Double-click race** — `createState({status:'approved'})`; POST approve. Assert: 200 resolved; mockRouter has 0 commands.

### Test Infrastructure Invariants

The test fixtures themselves require coverage. Add a small suite (`tests/portal/fixtures/fixtures.test.ts`) verifying:

- `MockIntakeRouter` records bodies verbatim (`getReceivedCommands()[0].body` deep-equals submitted JSON).
- `MockIntakeRouter` `'fail-then-ok'` with N=2 produces `[503, 503, 200]`.
- `createState` with `ageHours: 25` writes `created_at` exactly `now - 25h ± 1s`.
- `createState` with `escalatedAt` writes that exact value.
- Two parallel `startPortal` calls return distinct URLs and do not collide.

## Acceptance Criteria

- [ ] `MockIntakeRouter` boots on a random port and records all `POST /router/command` bodies verbatim
- [ ] `MockIntakeRouter.setBehavior('fail-then-ok', N)` returns 503 for first N requests then 200
- [ ] `MockIntakeRouter.reset()` clears recorded commands and resets behavior to `'ok'`
- [ ] `createState(repoRoot, requestId, overrides)` writes a syntactically valid state.json with all schema fields populated
- [ ] `startPortal({intakePort, repoRoot})` injects an `IntakeRouterClient` pointing at the mock port
- [ ] `fetchCsrfToken(baseUrl)` returns a token usable as `X-CSRF-Token` for subsequent POSTs
- [ ] Suite 1 has at least 7 tests as enumerated above
- [ ] Suite 2 has at least 7 tests as enumerated above
- [ ] Suite 3 has at least 8 tests as enumerated above
- [ ] Suite 4 has at least 6 jsdom tests covering modal lifecycle
- [ ] Suite 5 has at least 2 tests for reload-after-action and double-click race
- [ ] Fixtures suite has at least 5 tests verifying the harness itself
- [ ] `bun test tests/portal/` runs all suites and exits 0 on a clean repo
- [ ] `bun test tests/portal/intake-router-client.test.ts` finishes in under 20 seconds (timeout test allows ~10s)
- [ ] No test reaches the real `~/.claude/autonomous-dev.json` — settings tests use the `userConfigPath` constructor option
- [ ] `package.json` has `"test:portal": "bun test tests/portal/"`

## Test Cases

The acceptance criteria above ARE the test cases for the four sibling specs. The unique invariants verified by THIS spec (the harness itself) are listed under "Test Infrastructure Invariants" above and re-summarized:

1. **Mock router records bodies** — submit `{a:1, b:'x'}`; assert deep-equal in `getReceivedCommands()[0].body`.
2. **Mock router fail-then-ok N=2** — three POSTs return `[503, 503, 200]`.
3. **State factory ageHours=25** — `created_at = now - 25h ± 1s`.
4. **State factory escalatedAt verbatim** — file content matches passed value.
5. **Portal isolation** — two parallel `startPortal` calls produce different URLs and do not interfere.

## Dependencies

- Bun's built-in test runner (`bun test`)
- Bun's `serve` for the mock router
- jsdom (already in devDependencies)
- All four sibling specs (SPEC-015-2-01 through SPEC-015-2-04) — these tests verify their behavior
- PLAN-014-2 CSRF middleware test helpers

## Notes

- We deliberately do NOT use Playwright or other browser drivers. HTMX behavior is the server's response shape; verifying rendered fragment HTML is sufficient. The modal flow uses jsdom because the only DOM behavior is the modal itself, not full page rendering.
- The mock intake router is intentionally minimal. We resist modeling its full state machine; tests assert on submitted commands and on the portal's response to canned router replies.
- `fail-then-ok` is critical for retry tests: it lets us verify both that retries happen AND that we eventually surface success when the underlying issue resolves.
- Audit log assertions read from the same on-disk path the real audit logger writes to. `beforeEach` resets the directory, so cross-test contamination is impossible.
- We assert on HTML substrings (`'class="gate-actions"'`, `'Approved by'`) rather than parsing DOM. This is brittle if templates change — but it's the most direct way to verify user-facing output. When templates change, tests fail loudly with obvious diffs.
- The 5-second timeout test is gated by Bun's per-test `timeout: 20_000` to allow the AbortController to fire and three retry attempts to complete. Total bounded.
- These suites do NOT run in parallel within a single Bun process because they bind real ports. Bun's test parallelism is per-file, which is sufficient — the files are mutually independent.
- Coverage targets: 95%+ line coverage for `intake-router-client.ts`, `confirmation-token-store.ts`, `escalation.ts`, `panel-context-builder.ts`, `form-parser.ts`, `config-validator.ts`. Lower thresholds acceptable for handler files where integration tests exercise orchestration paths.
