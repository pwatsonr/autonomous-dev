# SPEC-030-1-04: Stateful + Middleware Auth Tests — `oauth-flow`, `session-security`, `csrf-protection`

## Metadata
- **Parent Plan**: PLAN-030-1 (TDD-014 security test backfill)
- **Parent TDD**: TDD-030 §5.2 (oauth, session, csrf blocks), §5.5
- **Tasks Covered**: TASK-007 (oauth-flow.test.ts), TASK-008 (session-security.test.ts), TASK-009 (csrf-protection.test.ts)
- **Estimated effort**: 4 days (1.5 + 1.5 + 1)
- **Depends on**: SPEC-030-1-01 phase A; SPEC-030-1-02 (pkce baseline) for `oauth-flow.test.ts`
- **Future home**: `plugins/autonomous-dev/docs/specs/SPEC-030-1-04-stateful-and-middleware-auth-tests-oauth-session-csrf.md`

## Description

Ship the three stateful and middleware auth tests: the OAuth authorization-code flow with PKCE, session cookie + timeout semantics, and CSRF middleware. These three are the largest and most state-heavy tests in PLAN-030-1; the OAuth suite is the single largest covering 4 production files in one suite.

Mocking strategy follows TDD-030 §5.5:
- OAuth provider HTTP → `nock` (already in portal devDeps)
- Filesystem (session store) → real fs in `mkdtempSync`
- Time (idle / absolute timeout) → `jest.useFakeTimers({ doNotFake: ['nextTick'] })`
- HTTP server (CSRF) → real `http.createServer` bound to 127.0.0.1, port 0

No production code changes.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev-portal/server/auth/__tests__/oauth-flow.test.ts` | Create | 4-module suite covered by `nock` |
| `plugins/autonomous-dev-portal/server/auth/__tests__/session-security.test.ts` | Create | Cookie attrs + idle/absolute timeouts |
| `plugins/autonomous-dev-portal/server/auth/__tests__/csrf-protection.test.ts` | Create | Double-submit-cookie + safe-method skip |

If `nock` is not already in `plugins/autonomous-dev-portal/package.json` devDependencies, add it under that name with the same major used elsewhere in the repo (or pin to a recent stable major).

## Implementation Details

### `oauth-flow.test.ts`

Read `plugins/autonomous-dev-portal/server/auth/oauth/{oauth-auth.ts,oauth-bootstrap.ts,oauth-state.ts,token-exchange.ts}` to confirm exports. The test covers all four files in one suite (they're tightly coupled by the auth-code flow per TDD-030 §5.2).

Setup pattern:

```ts
import nock from 'nock';

beforeEach(() => {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');  // Allow loopback for any local test server
});

afterEach(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});
```

Test cases:

| Case | nock fixture | Expectation |
|------|-------------|-------------|
| Authorization-code happy path | provider returns valid token | State issued → callback validates → exchange returns access token |
| State replay | (no provider call) | Calling callback twice with the same state value: second call rejects with typed error |
| Wrong state value | (no provider call) | Callback with state not previously issued: rejects with typed error |
| Token-exchange failure | provider returns 400 with `{"error":"invalid_grant"}` | Typed error; assertion on `error.code` (not message) |
| Token-exchange network error | `nock` simulates connection error | Typed error |

Constraints:
- Every test that touches HTTP MUST end with `expect(nock.isDone()).toBe(true)` to confirm all expected interceptors fired.
- `nock.cleanAll()` in `afterEach` is mandatory — leftover interceptors poison the next test.
- The PKCE pieces of the flow rely on `pkce-utils.ts`; SPEC-030-1-02 already covers that module's correctness, so this suite asserts the FLOW (state issuance, callback validation) and need NOT re-verify the PKCE math.

### `session-security.test.ts`

Read `plugins/autonomous-dev-portal/server/auth/session/{session-manager.ts,session-cookie.ts,file-session-store.ts}`.

Setup pattern:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let storeDir: string;
beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'session-test-'));
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
});

afterEach(() => {
  jest.useRealTimers();
  rmSync(storeDir, { recursive: true, force: true });
});
```

Test cases:

| Case | Setup | Assertion |
|------|-------|-----------|
| New cookie attributes | issue session | Parse `Set-Cookie` header; assert `HttpOnly`, `Secure`, `SameSite=Strict` flags present (via `cookie` library if used in production, or a small ad-hoc parser — do NOT do raw substring matching) |
| Session-fixation | pre-login session id; perform login | Post-login session id ≠ pre-login session id |
| Idle timeout | issue session; advance fake timers by `idleMs + 1` | Next request: 401 |
| Absolute timeout | issue session; loop: advance by `idleMs - 1`, touch session, repeat until `absoluteMs + 1` total has elapsed | Next request: 401 even though session was recently touched |
| Logout invalidation | issue session; logout; reuse same id | 401 |
| File store cleanup | create + destroy session in `mkdtempSync` dir | After test: `afterEach` removes dir; subsequent tests see empty dir |

Constraints:
- `Set-Cookie` parsing MUST go through a structured parser (`cookie` package or a 5-line ad-hoc parser that splits on `;`). Substring matching against the full header string is forbidden.
- Fake-timer advancement uses `jest.advanceTimersByTimeAsync(...)` with `await`. Synchronous `jest.advanceTimersByTime` is forbidden because the file-session store performs async fs operations.
- The "absolute timeout" test demonstrates that touching the session does NOT reset the absolute clock — this is the security assertion (idle and absolute are separate budgets).

### `csrf-protection.test.ts`

Read the portal's CSRF middleware. Per TDD-030 §3.2 / §5.1, the file is "adjacent to `server/auth/middleware/`" — confirm the actual path before authoring (it may live at `server/auth/middleware/csrf.ts` or similar). Update file paths in the test imports accordingly. If no CSRF middleware exists in the tree at the time of authoring, **stop** and escalate per TDD-030 §8.1; do not invent a new one.

Setup pattern: same as `localhost-auth.test.ts` — real `http.createServer`, port 0.

Test cases:

| Method | Cookie | `X-CSRF-Token` header | Origin/Referer | Expected |
|--------|--------|------------------------|----------------|----------|
| First GET | none | n/a | same-origin | 200; response carries `Set-Cookie: csrf=<token>` |
| POST | `csrf=ABC` | `ABC` | same-origin | 200 |
| POST | `csrf=ABC` | (missing header) | same-origin | 403 |
| POST | `csrf=ABC` | `XYZ` (mismatch) | same-origin | 403 |
| GET / HEAD / OPTIONS | none | n/a | any | 200 (token check skipped) |
| Cross-origin POST | `csrf=ABC` | `ABC` | `Origin: https://evil.example` | 403 |

Constraints:
- The cross-origin POST case is the defense-in-depth assertion. If the portal's CSRF middleware does not check `Origin`/`Referer`, document the gap in the PR description per TDD-030 §8.1; the test asserts the current production behavior (whatever it is) and a follow-up hotfix PR addresses the gap.
- All cookie checks parse `Set-Cookie` structurally (per the session-test rule above).

## Acceptance Criteria

### `oauth-flow.test.ts`

- AC-1: All five test cases in §"oauth-flow.test.ts" pass under `npx jest --runInBand`.
- AC-2: Every test invokes `expect(nock.isDone()).toBe(true)` after the act-phase HTTP calls (or explicitly opts out with a `// nock not used` comment for cases that make zero HTTP calls — the state-replay and wrong-state cases qualify).
- AC-3: `nock.cleanAll()` is called in `afterEach`. Verified by code review.
- AC-4: `nock.disableNetConnect()` is called in `beforeEach`; loopback is re-enabled with `nock.enableNetConnect('127.0.0.1')` for any test that boots a real server.
- AC-5: Combined line coverage of the four oauth files (`oauth-auth.ts`, `oauth-bootstrap.ts`, `oauth-state.ts`, `token-exchange.ts`) ≥ 90 %.
- AC-6: No `error.message` substring matching for any rejection case. Typed properties only.

### `session-security.test.ts`

- AC-7: All six test cases pass.
- AC-8: `Set-Cookie` parsing goes through a structured parser; a `grep` for `.includes('HttpOnly')` or `.match(/HttpOnly/)` against the test file returns zero hits.
- AC-9: Fake timer advancement uses `jest.advanceTimersByTimeAsync` with `await`. A grep for `advanceTimersByTime\\b` (without `Async`) returns zero hits.
- AC-10: Each test that uses `mkdtempSync` cleans up its directory in `afterEach`. Verified by code review.
- AC-11: The "absolute timeout" test explicitly touches the session before the absolute deadline (so idle resets do NOT reset absolute) and asserts 401 after the absolute deadline.
- AC-12: Combined line coverage of `session-manager.ts`, `session-cookie.ts`, `file-session-store.ts` ≥ 90 %.

### `csrf-protection.test.ts`

- AC-13: All six rows in the CSRF cases table are present and pass.
- AC-14: First-GET sets `csrf=<token>` cookie via structured `Set-Cookie` parsing.
- AC-15: Cross-origin POST without same-origin `Origin` / `Referer` is asserted (even if the assertion currently documents a gap; if the production code does not check, the test asserts the production behavior AND the PR description flags a hotfix).
- AC-16: Line coverage of the CSRF middleware file ≥ 90 %.

### Given/When/Then highlights

```
Given an OAuth state value that has been issued and consumed
When the same state value is presented at the callback a second time
Then the auth subsystem rejects the request with a typed error
And the rejection occurs before any token-exchange HTTP call (nock interceptor count is zero for that test)

Given a session whose absolute lifetime has just exceeded its budget
When the session is "touched" via a request
Then the request is rejected with 401
Even though the idle clock has been reset multiple times during the lifetime

Given a logged-in browser session
When a malicious page on a different origin POSTs to a state-changing endpoint
And the malicious page does not (cannot) include a valid X-CSRF-Token header
Then the response is 403
```

## Test Requirements

The three files together must:
1. Pass under `npx jest --runInBand` from the autonomous-dev plugin root.
2. Pass in isolation per file.
3. Reach the per-suite coverage targets when run with `--coverage`.
4. Have zero leftover `nock` interceptors between tests (assert via `nock.pendingMocks().length === 0` in a `afterAll` if not already covered by `cleanAll`).
5. Have zero leftover temp directories between tests (assert by checking `mkdtempSync`'s tmp prefix is removed).

## Implementation Notes

- The OAuth suite is the single largest test file in PLAN-030-1. Reaching 90 % combined coverage on four production modules in one suite is the largest single ask in the plan. If 90 % is unreachable without dead-code removal, file the dead code as a separate PR per TDD-030 §5.3 and add `/* istanbul ignore next */` only for genuinely defensive branches (with rationale comments).
- Fake-timer + fs interaction is a known hang vector. The `doNotFake: ['nextTick', 'queueMicrotask']` setting is the explicit TDD-030 §5.5 mitigation.
- The CSRF middleware's actual file path may not be `server/auth/middleware/csrf.ts`. Confirm at the start of TASK-009; if absent entirely, escalate (this is a tree-truth gap, not a test gap).
- These three suites can be authored in parallel; they share no fixtures.

## Rollout Considerations

Pure additive. Revert the three files to roll back. If the CSRF cross-origin assertion reveals a real gap, the hotfix is a separate PR per TDD-030 R-03.

## Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Real OAuth vulnerability surfaced | Medium | High (security) | Per TDD-030 §8.1: document in PR, separate hotfix |
| Real session-fixation bug | Low | High | Same as above |
| Real CSRF Origin gap | Medium | Medium | Same as above |
| 90 % coverage unreachable on OAuth suite | Medium | Low (schedule) | Dead-code removal in separate PR; `/* istanbul ignore */` last resort |
| Fake-timer + fs hang | Medium | Medium | `doNotFake: ['nextTick']`; `advanceTimersByTimeAsync` |
| `nock` interceptor leak between tests | Medium | High (false negative) | `nock.cleanAll()` in `afterEach`; `expect(nock.isDone()).toBe(true)` per test |
| CSRF middleware does not exist in tree | Low | High (blocking) | Escalate per TDD-030 §8.1; do not invent middleware |
