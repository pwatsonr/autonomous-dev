# PLAN-011-4: Slack App Service Entry Point

## Metadata
- **Parent TDD**: TDD-011-multi-channel-intake-adapters
- **Estimated effort**: 3-4 days
- **Dependencies**: ["PLAN-011-1"]
- **Blocked by**: []
- **Priority**: P2

## Objective
Deliver the complete Slack App service entry point at `intake/adapters/slack/main.ts` per TDD-011 §8. Production-ready service supporting both HTTP receiver mode (default) and Socket Mode (alternative); HMAC-SHA256 signature verification with replay protection; 3-second response budget with deferred response pattern; graceful shutdown with 10-second drain (FR-818); deployment manifests for operator workspace setup.

## Scope
### In Scope
- New `intake/adapters/slack/main.ts` per §8.3 — full service architecture
- HTTP receiver: Express server on `/slack/events`, `/slack/commands`, `/slack/interactions`
- Socket Mode alternative using `@slack/socket-mode` (no public endpoint required)
- Request signature verification: HMAC-SHA256 + `crypto.timingSafeEqual` + 5-min replay window
- 3-second response budget enforcement: `Promise.race` + deferred response via `response_url`
- Wire slash command + interaction handlers to existing IntakeRouter through SlackAdapter
- Graceful shutdown: drain in-flight, disconnect Socket Mode, close HTTP server (10s budget)
- Env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN (Socket Mode), SLACK_SIGNING_SECRET
- Config: `intake.channels.slack.{socket_mode, port, rate_limits, timestamp_tolerance}`
- Slack app manifest YAML at `slack-app-manifest.yaml` for operator workspace deployment
- `startSlackService(config, router)` lifecycle entry point
- SIGTERM/SIGINT handlers

### Out of Scope
- CLI/Claude App/Discord (other PLAN-011-*)
- state.json/SQLite handoff (PLAN-012-*)
- Rate limiting (already implemented in `SlackRateLimiter`)
- Block Kit response formatting (already in `SlackComponents`)
- Command parsing (already in `SlackCommandHandler`)

## Tasks

1. **Scaffold main.ts with SlackService class** -- dual-mode arch; constructor injection; lifecycle methods.
   - Files: `intake/adapters/slack/main.ts` (new)
   - Acceptance: SlackService exports; constructor accepts SlackServiceDeps; methods start()/shutdown()/startHttpMode()/startSocketMode() defined.
   - Effort: 1h

2. **Implement HTTP receiver mode** -- Express middleware pipeline; routes via existing SlackServer; health endpoint.
   - Files: `intake/adapters/slack/main.ts`
   - Acceptance: Express app with JSON/URL-encoded parsing; `/slack/events`, `/slack/commands`, `/slack/interactions` registered; `/health` returns status; binds to configured port.
   - Effort: 2h

3. **Implement signature verification middleware** -- HMAC-SHA256, timing-safe compare, 5-min replay window via existing SlackVerifier.
   - Files: `intake/adapters/slack/main.ts`
   - Acceptance: applied to `/slack/*`; invalid signature → 401; timestamp >5min old → reject; failures logged with source IP.
   - Effort: 1.5h

4. **Implement Socket Mode** -- `@slack/socket-mode` client init; event handler registration via existing SlackSocketMode helper.
   - Files: `intake/adapters/slack/main.ts`
   - Acceptance: SocketModeClient with app token from env; structured logging integration; handlers registered; `client.start()` connects.
   - Effort: 2h

5. **Implement 3-second response budget** -- request timeout via Promise.race; deferred response via `response_url`.
   - Files: `intake/adapters/slack/main.ts`
   - Acceptance: 3s timeout triggers deferred response; elapsed time logged; deferred message includes "Processing your request..." + follow-up.
   - Effort: 2.5h

6. **Implement graceful shutdown with 10s drain** -- SIGTERM/SIGINT; ordered shutdown: adapter → Socket Mode → HTTP server.
   - Files: `intake/adapters/slack/main.ts`
   - Acceptance: signal handlers registered; sequence respected; 10s force-shutdown timeout with warning; prevents concurrent shutdowns; exit 0 graceful / 1 forced.
   - Effort: 2h

7. **Add config loading and validation** -- per §8.2; integrate with existing config loader.
   - Files: `intake/adapters/slack/main.ts`
   - Acceptance: `startSlackService()` validates required config; Socket Mode requires SLACK_APP_TOKEN; HTTP requires port; missing config throws clear errors.
   - Effort: 1.5h

8. **Create Slack app manifest YAML** -- complete manifest with permissions, slash commands, interactivity URL.
   - Files: `intake/adapters/slack/slack-app-manifest.yaml` (new)
   - Acceptance: valid YAML; OAuth scopes (chat:write, commands, app_mentions:read); 10 slash commands; interactivity URL; event subscriptions; app metadata.
   - Effort: 1h

9. **Add systemd + launchd service files** -- production deployment with dependency ordering.
   - Files: `intake/adapters/slack/systemd/autonomous-dev-slack.service`, `intake/adapters/slack/launchd/com.autonomous-dev.slack.plist` (new)
   - Acceptance: systemd `After=` deps + restart policy + env file; launchd plist with program args + working dir + env vars.
   - Effort: 1h

10. **Write Jest unit tests** -- mocked Slack APIs; signature verification, timeout, dual-mode startup, shutdown.
    - Files: `intake/__tests__/adapters/slack/main.test.ts` (new)
    - Acceptance: covers valid/invalid signatures, HTTP vs Socket startup, 3s timeout with deferred, graceful vs forced shutdown, config validation, signal handlers; uses mocked clients.
    - Effort: 4h

## Dependencies & Integration Points

**Consumes:**
- PLAN-011-1: shared IntakeRouter
- Existing: SlackAdapter, SlackServer, SlackVerifier, SlackSocketMode, SlackCommandHandler

**Exposes:**
- `startSlackService(config, router)` entry point
- Service lifecycle for container orchestration
- Metrics/logging integration points

## Test Plan

- **Unit:** isolated method testing with mocked deps; signature adversarial; timeout behavior
- **Signature verification:** invalid sigs, expired timestamps, malformed headers; verify timing-safe comparison
- **Timeout:** mock slow adapter responses; verify deferred pattern + cleanup
- **Shutdown:** real SIGTERM; verify graceful within 10s; force-shutdown timeout
- **Integration smoke:** start in HTTP + Socket modes; health check; test slash command; graceful shutdown

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Slack rate limits during signature testing | Medium | Medium | Mocked clients; local HMAC computation; integration tests rate-limited |
| Socket Mode instability in CI | Medium | Medium | Mock in unit tests; real testing only manual; retry logic |
| Env var conflicts HTTP vs Socket Mode | Low | High | Clear config validation; per-mode env requirements documented |
| Response budget interferes with adapter timeout | Medium | Medium | Review existing SlackAdapter; ensure budget at service layer only |

## Acceptance Criteria

- [ ] `main.ts` implements complete SlackService per §8.3
- [ ] Both HTTP receiver and Socket Mode supported with env-based switching
- [ ] Signature verification: HMAC-SHA256 + timing-safe + 5-min replay window
- [ ] 3-second budget enforced with deferred response pattern
- [ ] Graceful shutdown completes within 10s with ordered component shutdown
- [ ] `startSlackService()` validates config and starts successfully
- [ ] `slack-app-manifest.yaml` complete for workspace deployment
- [ ] systemd + launchd files enable production deployment
- [ ] Signal handlers trigger graceful shutdown with clean exit codes
- [ ] Unit tests >90% coverage with comprehensive error testing
- [ ] Manual integration: HTTP startup + slash command + graceful shutdown
- [ ] No TypeScript errors at `--strict`
