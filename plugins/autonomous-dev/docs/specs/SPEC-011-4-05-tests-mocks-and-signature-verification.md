# SPEC-011-4-05: Jest Tests with Slack API Mocks and Signature Verification

## Metadata
- **Parent Plan**: PLAN-011-4
- **Tasks Covered**: Task 10 (Jest unit tests; ≥90% coverage; signature verification, dual-mode startup, timeout, shutdown, config validation, signal handlers)
- **Estimated effort**: 4 hours

## Description
Author the Jest test suite for `intake/adapters/slack/main.ts`. Tests use mocked `@slack/web-api` and `@slack/socket-mode` clients (no network), an in-process `supertest` HTTP probe, and locally-computed HMAC signatures so the signature middleware can be exercised end-to-end. Coverage targets the four behavioral surfaces of `SlackService`: signature verification (positive + adversarial), dual-mode startup (HTTP and Socket Mode), 3-second response budget (fast and deferred paths), and graceful shutdown (clean and forced). Configuration validation and signal handler wiring are also covered.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/__tests__/adapters/slack/main.test.ts` | Create | Top-level test suite |
| `intake/__tests__/adapters/slack/fixtures/payloads.ts` | Create | Slash command + interaction fixtures |
| `intake/__tests__/adapters/slack/helpers/sign.ts` | Create | HMAC signing helper for fixtures |

## Implementation Details

### Test Layout

Use a single `main.test.ts` with `describe` blocks:

```
SlackService
├── signature verification
├── HTTP mode startup
├── Socket Mode startup
├── slash command pipeline (3s budget)
├── interaction handler dispatch
├── rate limiting
├── error formatting
├── graceful shutdown
└── config validation
```

### Mock Strategy

| Real dependency | Mock |
|-----------------|------|
| `@slack/web-api` `WebClient` | Jest mock object with `chat.postMessage`, `chat.postEphemeral`, `views.open` returning `{ ok: true }` by default |
| `@slack/socket-mode` `SocketModeClient` | Jest mock with `start()`, `disconnect()`, `on(event, cb)` capturing handlers in a map for later trigger |
| `IntakeRouter` | Jest mock with `route(cmd)` returning `Promise<CommandResult>` — controllable per test (resolve fast, resolve slow, reject) |
| `SlackRateLimiter` | Jest mock returning `{ allowed: true }` by default; tests override for rate-limit-hit cases |
| HTTP server | Real Express server bound to ephemeral port (port 0); use `supertest(app)` |
| Logger | Jest spy object capturing all info/warn/error calls |
| `process.exit` | Spy: `jest.spyOn(process, 'exit').mockImplementation(() => undefined as never)` |
| `process.on` (signal) | Capture registered handlers in a map; tests trigger via captured callbacks (do NOT actually emit SIGTERM) |

### Helper: `helpers/sign.ts`

```ts
import crypto from 'crypto';

export function signSlackRequest(opts: {
  signingSecret: string;
  timestamp: number;       // unix seconds
  body: string;            // exact rawBody
}): { 'X-Slack-Signature': string; 'X-Slack-Request-Timestamp': string } {
  const base = `v0:${opts.timestamp}:${opts.body}`;
  const sig = 'v0=' + crypto.createHmac('sha256', opts.signingSecret).update(base).digest('hex');
  return {
    'X-Slack-Signature': sig,
    'X-Slack-Request-Timestamp': String(opts.timestamp),
  };
}
```

### Fixtures: `fixtures/payloads.ts`

Export realistic Slack payloads matching production shape:

- `slashCommandSubmit` — `application/x-www-form-urlencoded`-style object with `command=/request-submit`, `text="add login"`, `user_id`, `team_id`, etc.
- `slashCommandStatus` — same with `command=/request-status`, `text="REQ-000123"`
- `interactionBlockActions` — JSON object simulating a `kill_confirm` button click
- `interactionViewSubmission` — JSON object for the submit-request modal submission

### Signature Verification Tests

```
describe('signature verification', () => {
  it('200 on valid signature within 5min window')
  it('401 missing X-Slack-Signature header → body { error: "missing_signature_headers" }')
  it('401 missing X-Slack-Request-Timestamp header')
  it('401 timestamp >5min old → body { error: "timestamp_expired" }')
  it('401 timestamp >5min in future → body { error: "timestamp_expired" }')
  it('401 mutated body (1 byte flipped) → body { error: "bad_signature" }')
  it('401 wrong signing secret → body { error: "bad_signature" }')
  it('401 truncated signature (length mismatch handled without throwing)')
  it('rejected signature value never appears in response body or logger calls')
  it('valid request reaches router exactly once')
})
```

For the "never appears" test: capture all logger calls + response body; assert that `sig` substring is not present anywhere.

### HTTP Mode Startup Tests

```
describe('HTTP mode startup', () => {
  it('binds to config.port and exposes /health returning { status: "ok", mode: "http" }')
  it('registers POST /slack/events, /slack/commands, /slack/interactions')
  it('URL verification: POST /slack/events with type=url_verification echoes challenge')
  it('does not start Socket Mode client when config.socket_mode=false')
})
```

### Socket Mode Startup Tests

```
describe('Socket Mode startup', () => {
  it('throws "SLACK_APP_TOKEN required" when env var missing and socket_mode=true')
  it('calls SocketModeClient.start() exactly once')
  it('registers slash_commands, interactive, events_api event handlers')
  it('emits info logs on connecting and connected events')
  it('emits warn log on disconnected and error log on error event')
  it('still binds /health on config.port (no /slack/* routes)')
})
```

To verify "no `/slack/*` routes," `supertest(app).post('/slack/commands')` should return 404.

### 3-Second Budget Tests

```
describe('slash command pipeline (3s budget)', () => {
  it('fast path: router resolves at 100ms → response is final formatted result, no deferred POST')
  it('slow path: router resolves at 3000ms → inline 200 is "Processing your request...", deferred POST hits response_url')
  it('boundary: router resolves at exactly 2500ms → uses fast path (resolves before timer)')
  it('boundary: router resolves at 2501ms → uses deferred path')
  it('deferred path: router rejects → posts formatted error to response_url, not retried')
  it('inline ack response_type is ephemeral')
  it('logs slack.response.deferred with elapsed_ms when deferred fires')
})
```

Use `jest.useFakeTimers()` to control the 2500ms deadline deterministically. The `response_url` POST is mocked via `nock` or a Jest spy on the HTTP client used by `postToResponseUrl`.

### Interaction Handler Dispatch Tests

```
describe('interaction handler dispatch', () => {
  it('block_actions kill_confirm dispatches subcommand=kill, args=[reqId]')
  it('block_actions kill_cancel returns LocalDismiss, no router call')
  it('view_submission submit_request_modal dispatches subcommand=submit with 3 args')
  it('unknown verb returns ephemeral error and logs slack.interaction.unknown')
  it('clarify_select calls adapter.resolvePendingPrompt with requestId')
  it('view_closed logs slack.modal.closed and does not call router')
})
```

### Rate Limit Tests

```
describe('rate limiting', () => {
  it('allowed: cmd reaches router')
  it('blocked: ephemeral response with "Try again in Ns", no router call, log slack.ratelimit.hit')
  it('rate-limit key is workspaceId, not userId')
  it('rate-limit log does not include user_id field')
})
```

### Error Formatting Tests

```
describe('error formatting', () => {
  it.each([
    ['INVALID_REQUEST_ID', 'Invalid request ID. Format: REQ-NNNNNN'],
    ['UNKNOWN_REQUEST',    'That request was not found.'],
    ['RATE_LIMITED',       'Too many requests. Please slow down.'],
    ['UNAUTHORIZED',       'You are not authorized for that operation.'],
    ['TIMEOUT',            'The operation timed out. It may still complete in the background.'],
    ['UNKNOWN_BOOM',       'Something went wrong. Please contact your operator.'],
  ])('code %s produces %s', (code, message) => { /* ... */ })

  it('does not include stack trace in blocks')
  it('does not include raw err.message in blocks')
  it('includes requestId context block when provided')
})
```

### Graceful Shutdown Tests

```
describe('graceful shutdown', () => {
  it('SIGTERM triggers shutdown() (handler captured in process.on map)')
  it('shutdown sequence: stopAccepting → Socket Mode disconnect → adapter.drain → server.close')
  it('idempotent: concurrent SIGTERM + SIGINT calls shutdown only once')
  it('clean drain → process.exit(0)')
  it('drain >10s → force timer fires → log slack.shutdown.forced → process.exit(1)')
  it('uncaughtException triggers shutdown with full error logged')
  it('shutdown error in any step → log slack.shutdown.error → process.exit(1)')
})
```

Use `jest.useFakeTimers()`; advance `10001ms` to trigger force-shutdown.

### Config Validation Tests

```
describe('config validation', () => {
  it('throws "config: SLACK_BOT_TOKEN is required" when missing in HTTP mode')
  it('throws "config: SLACK_SIGNING_SECRET is required" when missing in HTTP mode')
  it('throws "config: SLACK_APP_TOKEN is required" when socket_mode=true and env missing')
  it('throws on port=0 or negative')
  it('throws on timestamp_tolerance_seconds <60 or >600')
  it('error message names the offending key but never the token value')
})
```

### Coverage Targets

`jest.config` thresholds for `intake/adapters/slack/main.ts` only:

```json
{
  "branches": 90,
  "functions": 95,
  "lines": 90,
  "statements": 90
}
```

## Acceptance Criteria

- [ ] All 9 `describe` blocks above are present and populated with the listed `it` cases
- [ ] `helpers/sign.ts` produces valid HMAC signatures that pass `SlackVerifier.verify`
- [ ] `fixtures/payloads.ts` exports the four documented fixtures with realistic field shapes
- [ ] No test makes a real network call to Slack (verified by mocking `@slack/web-api` and `@slack/socket-mode` at module level)
- [ ] No test imports a real `SLACK_*` token; all secrets are local Jest fixtures
- [ ] `jest.useFakeTimers()` is used for the budget and shutdown timeout tests
- [ ] `process.exit` is spied and never actually exits the test runner
- [ ] Signal handler tests capture and trigger handlers via a `process.on` mock; no real signals are raised
- [ ] Coverage on `intake/adapters/slack/main.ts` meets thresholds (branches 90%, functions 95%, lines 90%)
- [ ] Test suite runs in <5s (no real timers, no real network)
- [ ] `tsc --strict` passes on test files

## Dependencies

- SPEC-011-4-01..04: define the surface area being tested
- npm: `jest`, `supertest`, `@types/supertest`, `@types/jest` (verify in `package.json`)
- Existing test patterns from `intake/__tests__/adapters/slack/` (siblings: `slack_verifier.test.ts`, `slack_command_handler.test.ts` — follow their structure and helpers where applicable)

## Notes

- Real signature computation in tests (not mocked) is intentional. Mocking `SlackVerifier.verify` would make signature tests vacuous; computing HMAC locally exercises the same code path Slack uses in production.
- The "rejected signature value never appears" test catches log-leak bugs that are easy to introduce when adding debug logging during incident response. It is worth the extra few lines.
- Fake timers around `Promise.race` require `jest.advanceTimersByTimeAsync` (not the sync variant) because the timer winner is settled via microtask. The boundary tests at 2500/2501ms specifically need this.
- Avoid coupling tests to log message text beyond the documented event names (`slack.response.deferred`, `slack.shutdown.forced`, etc.). Asserting on free-form prose makes tests brittle.
- Socket Mode tests do not need to verify the actual `@slack/socket-mode` library behavior — only that the service registers handlers correctly and routes them through the existing helpers. Library correctness is upstream.
- The `process.on` mock pattern: `const handlers = new Map(); jest.spyOn(process, 'on').mockImplementation((sig, cb) => { handlers.set(sig, cb); return process; });` — then `handlers.get('SIGTERM')!()` triggers the registered handler synchronously.
- Coverage thresholds apply to `main.ts` ONLY. Existing helper files (verifier, command handler, components) have their own established coverage and are not included here.
