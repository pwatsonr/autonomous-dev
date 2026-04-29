# PLAN-011-3: Discord Bot Service Entry Point

## Metadata
- **Parent TDD**: TDD-011-multi-channel-intake-adapters
- **Estimated effort**: 3 days
- **Dependencies**: ["PLAN-011-1"]
- **Blocked by**: []
- **Priority**: P1

## Objective
Deliver a production-ready Discord bot service entry point that initializes the Discord client, registers slash commands, manages the complete service lifecycle, and wires interaction handling to the existing IntakeRouter via DiscordAdapter. Service supports graceful shutdown with 5-second drain (FR-812) and exponential reconnection backoff (FR-814).

## Scope
### In Scope
- New file `intake/adapters/discord/main.ts` implementing `DiscordService` class per TDD-011 §7
- discord.js Client initialization with `GatewayIntentBits.Guilds` for slash commands
- Slash command registration sequence against `guild_id` from configuration
- Wire interaction handler to existing `IntakeRouter` via `DiscordAdapter`
- Connection event handlers (ready, error, disconnect, reconnecting)
- Graceful shutdown drain on SIGTERM/SIGINT with 5-second budget (FR-812)
- Reconnection: exponential backoff 1s..60s, max 10 attempts (FR-814)
- Configuration loading per §7.2: DISCORD_BOT_TOKEN, DISCORD_APPLICATION_ID, DISCORD_GUILD_ID env vars
- Validate `intake.channels.discord.enabled = true` before starting
- Add `discord.js@^14.14.0` to package.json (TDD-011 §11.1)
- Structured logging for startup, shutdown, interactions, connection state
- systemd service file template + launchd plist for macOS deployment

### Out of Scope
- CLI dispatcher (PLAN-011-1), Claude App stubs (PLAN-011-2), Slack service (PLAN-011-4)
- state.json/SQLite handoff (PLAN-012-*)
- Bot installation and OAuth setup documentation
- Production monitoring/alerting integration

## Tasks

1. **Add discord.js dependency** -- `discord.js@^14.14.0` to package.json; npm install.
   - Files: `package.json`
   - Acceptance: package in node_modules; no dependency conflicts.
   - Effort: 0.5h

2. **Implement DiscordService class skeleton with configuration** -- constructor, config schema, dependency injection.
   - Files: `intake/adapters/discord/main.ts` (new)
   - Acceptance: instantiates with valid config; throws clear errors for missing env vars or disabled channel.
   - Effort: 2h

3. **Implement startup sequence with Client init** -- create Client with required intents; login; 30s ready timeout; wire to existing DiscordAdapter.
   - Files: `intake/adapters/discord/main.ts`
   - Acceptance: starts with valid token; fails gracefully with invalid token; logs startup phases.
   - Effort: 3h

4. **Implement slash command registration** -- register all 10 slash commands per §7.3; support guild-specific (instant) vs global (1h propagation) modes.
   - Files: `intake/adapters/discord/main.ts`
   - Acceptance: commands appear in Discord; both modes work; failures logged with actionable errors.
   - Effort: 4h

5. **Implement graceful shutdown** -- SIGTERM/SIGINT handlers; stop accepting interactions; wait up to 5s for in-flight; force shutdown after timeout; destroy client.
   - Files: `intake/adapters/discord/main.ts`
   - Acceptance: process exits within 5s of SIGTERM; in-flight interactions complete if possible; no zombie processes.
   - Effort: 2.5h

6. **Implement reconnection backoff** -- exponential 1s..60s, max 10 attempts (§7.4 / FR-814); respect shutdown flag.
   - Files: `intake/adapters/discord/main.ts`
   - Acceptance: recovers from network blips; respects max attempts; stops reconnecting during shutdown; logs aid debugging.
   - Effort: 3h

7. **Add structured logging** -- service lifecycle events; connection state; interactions; JSON to stderr matching existing patterns.
   - Files: `intake/adapters/discord/main.ts`
   - Acceptance: logs sufficient for production debugging; consistent format; actionable error messages.
   - Effort: 1.5h

8. **Create systemd + launchd service files** -- production deployment templates.
   - Files: `contrib/systemd/discord-bot.service`, `contrib/launchd/dev.autonomous.discord-bot.plist` (new)
   - Acceptance: install/start correctly on respective platforms; env vars load properly.
   - Effort: 2h

9. **Write Jest unit tests** -- mock discord.js Client; test startup/shutdown/reconnection/config validation/registration.
   - Files: `intake/__tests__/adapters/discord/discord_service.test.ts` (new)
   - Acceptance: >90% code coverage; reliable in CI.
   - Effort: 5h

10. **Write integration test with test guild** -- real Discord connection; complete lifecycle; reconnection from simulated drops; configuration scenarios.
    - Files: `intake/__tests__/integration/discord_service_e2e.test.ts` (new)
    - Acceptance: e2e scenarios pass; clear failure diagnostics.
    - Effort: 4h

## Dependencies & Integration Points

**Consumes from existing codebase:**
- `DiscordAdapter` from `intake/adapters/discord/discord_adapter.ts`
- `IntakeRouter` (consumed as-is)
- `discord_commands.ts` for slash command definitions

**Exposes:**
- `DiscordService` class with full lifecycle management
- Production-ready entry point for deployment automation
- Reconnection patterns reusable for other network services

## Test Plan

- **Unit (Jest):** mocked Client; configuration validation; reconnection algorithm with time mocking; signal handling with process mocks
- **Integration (E2E):** real Discord connection in test guild; full interaction flow; concurrent interactions under load; deployment with service files
- **Manual:** invalid token clear error; SIGTERM during startup; gateway disconnect; long-running interaction with deferred response; configuration disabled

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| discord.js incompatibility | Low | High | Pin to ^14.14.0; test with existing adapter |
| Gateway instability in production | Medium | Medium | Comprehensive reconnection; detailed logging |
| Interaction timeout edge cases | Medium | Medium | Test 3s + 15min Discord limits |
| Signal handling race conditions | Low | High | Process lifecycle testing |
| Test guild config complexity | High | Low | Document setup; fallback to mock-only |

## Acceptance Criteria

- [ ] discord.js@^14.14.0 installed
- [ ] DiscordService implements full lifecycle
- [ ] Service connects to Discord Gateway with valid config
- [ ] All 10 slash commands register (guild + global modes)
- [ ] Interaction handling integrates with DiscordAdapter
- [ ] Graceful shutdown completes within 5 seconds
- [ ] Reconnection: exponential backoff up to 10 attempts
- [ ] Configuration validation gives clear errors
- [ ] Structured logging actionable for debugging
- [ ] systemd + launchd templates work
- [ ] Unit tests >90% coverage
- [ ] Integration tests pass with real Discord API
- [ ] No TypeScript errors; no lint warnings
- [ ] SIGTERM/SIGINT handled with correct exit codes
