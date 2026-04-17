# PLAN-008-4: Slack Bot Adapter

## Metadata
- **Parent TDD**: TDD-008-intake-layer
- **Estimated effort**: 8 days
- **Dependencies**: PLAN-008-1 (core infrastructure), PLAN-008-2 (validates IntakeAdapter interface)
- **Blocked by**: PLAN-008-1
- **Priority**: P1

## Objective

Implement the Slack bot adapter, delivering full command parity with the Claude App and Discord adapters over the Slack platform. This includes Slack app manifest deployment, request signature verification (HMAC-SHA256), 10 individual slash commands (Slack does not support subcommand grouping), Block Kit formatting with status emoji, interactive button components, modal forms, thread-based clarifying conversations via `thread_ts`, Slack user identity mapping, `response_url` follow-up pattern for long-running commands, Socket Mode fallback, platform rate limit awareness, bot startup recovery, and graceful shutdown.

## Scope

### In Scope
- `SlackAdapter` implementing the `IntakeAdapter` interface
- Slack app manifest (`slack-app-manifest.yaml`) with all slash commands, bot scopes, event subscriptions, and interactivity configuration per TDD section 3.4.1
- Request signature verification (HMAC-SHA256 with `signing_secret`, 5-minute replay window) per TDD section 3.4.2
- 10 individual slash commands (`/ad-submit`, `/ad-status`, `/ad-list`, `/ad-cancel`, `/ad-pause`, `/ad-resume`, `/ad-priority`, `/ad-logs`, `/ad-feedback`, `/ad-kill`) per TDD section 3.4.1
- 3-second acknowledgment + `response_url` follow-up pattern for commands that take longer per TDD section 3.4.5
- Block Kit formatter with status emoji, sections, fields, context, and actions per TDD section 3.4.3
- Interactive button components for kill confirmation (with Slack's built-in confirm dialog) and cancel confirmation per TDD section 3.4.4
- Slack interaction handler routing `block_actions`, `view_submission`, and `shortcut` payload types per TDD section 3.4.5
- Modal form for complex submissions via `views.open` with `trigger_id`
- Thread-based clarifying conversations using `thread_ts` on `chat.postMessage` and `conversations.join` per TDD section 3.10.3
- Slack user identity mapping to internal user IDs via `user_identities.slack_id`
- Ephemeral messages for error responses (`chat.postEphemeral`)
- In-place message updates for status changes (`chat.update`)
- Socket Mode fallback (configurable via `slack.socket_mode: true`) per TDD TQ-11
- Exponential backoff with jitter for Slack Web API calls, respecting `Retry-After` header per TDD section 3.13.2
- Bot startup recovery: re-send pending prompts per TDD section 3.13.1
- Graceful shutdown
- Slack-specific integration tests (mocked Slack Web API client)

### Out of Scope
- Discord adapter -- PLAN-008-3
- NotificationEngine, digest scheduler -- PLAN-008-5 (Block Kit formatter is created here but proactive push is wired in PLAN-008-5)
- ConversationManager -- PLAN-008-5 (thread creation and `promptUser` implemented here, full bidirectional manager in PLAN-008-5)
- Cross-channel notification (submit in Slack, notify in Discord) -- PLAN-008-5
- HTTPS endpoint setup / Cloudflare Tunnel configuration (infrastructure concern, documented but not implemented)
- Mobile rendering validation (manual task)

## Tasks

1. **Set up Slack module and dependencies** -- Install `@slack/web-api` and optionally `@slack/socket-mode`. Configure HTTP server for webhook endpoints.
   - Files to create: `intake/adapters/slack/slack_client.ts`, `intake/adapters/slack/slack_server.ts`, `package.json` update
   - Acceptance criteria: `@slack/web-api` added as dependency. `@slack/socket-mode` as optional dependency. HTTP server (Express or Fastify) created for `/slack/commands`, `/slack/interactions`, and `/slack/events` endpoints. Bot token loaded from `SLACK_BOT_TOKEN`, signing secret from `SLACK_SIGNING_SECRET` environment variables.
   - Estimated effort: 3 hours

2. **Create Slack app manifest** -- Per TDD section 3.4.1.
   - Files to create: `intake/adapters/slack/slack-app-manifest.yaml`
   - Acceptance criteria: Manifest includes all 10 slash commands with correct URLs, usage hints, and `should_escape` settings. Bot scopes: `commands`, `chat:write`, `chat:write.public`, `im:write`, `users:read`, `channels:read`, `groups:read`. Interactivity enabled with request URL. Event subscriptions for `message.channels`, `message.groups`, `message.im`. `${SLACK_HOST}` template variable for endpoint URLs.
   - Estimated effort: 1 hour

3. **Implement request signature verification** -- Per TDD section 3.4.2.
   - Files to create: `intake/adapters/slack/slack_verifier.ts`
   - Acceptance criteria: Verifies `X-Slack-Request-Timestamp` is within 5 minutes (replay attack prevention). Computes HMAC-SHA256 of `v0:${timestamp}:${body}` with signing secret. Uses `crypto.timingSafeEqual` for constant-time comparison. Rejects requests that fail verification with HTTP 401. Middleware function for the HTTP server.
   - Estimated effort: 2 hours

4. **Implement SlackAdapter class** -- Core adapter implementing `IntakeAdapter`.
   - Files to create: `intake/adapters/slack/slack_adapter.ts`
   - Acceptance criteria: Implements `start()` (starts HTTP server, optionally connects Socket Mode), `sendMessage()` (calls `chat.postMessage` or `chat.postEphemeral` based on target), `promptUser()` (sends structured prompt with buttons in thread, waits for interaction response or timeout), `shutdown()` (stops HTTP server, disconnects Socket Mode). `channelType` is `'slack'`.
   - Estimated effort: 6 hours

5. **Implement slash command endpoint handler** -- Route all 10 slash commands.
   - Files to create: `intake/adapters/slack/slack_command_handler.ts`
   - Acceptance criteria: Receives POST to `/slack/commands`. Extracts `command`, `text`, `user_id`, `channel_id`, `trigger_id`, `response_url`. Maps command name to `commandName` (strip `/ad-` prefix). Parses `text` into args and flags (reuse arg parser from PLAN-008-2 or adapt). Returns HTTP 200 immediately (within 3 seconds) with either the result (if fast) or an acknowledgment. For slow commands, uses `response_url` POST to deliver the final result.
   - Estimated effort: 4 hours

6. **Implement Block Kit formatter** -- Per TDD section 3.4.3.
   - Files to create: `intake/notifications/formatters/slack_formatter.ts`
   - Acceptance criteria: `formatStatusBlocks` returns Block Kit blocks with: header (request ID + title), section fields (Phase with emoji, Priority, Progress, Age), conditional blocker warning section, conditional artifact links section (Slack mrkdwn links), context footer (requester mention + relative time). Status emoji map matches TDD (`white_circle` for queued, `large_blue_circle` for generation, etc.). Implements `NotificationFormatter` interface. `formatPhaseTransition`, `formatDigest`, and `formatError` methods. Respects Slack block limits (50 blocks per message, 3000 chars per text block).
   - Estimated effort: 5 hours

7. **Implement interactive button components** -- Kill confirmation and cancel confirmation per TDD section 3.4.4.
   - Files to create: `intake/adapters/slack/slack_components.ts`
   - Acceptance criteria: `buildKillConfirmationBlocks` returns blocks with danger-style "CONFIRM KILL ALL" button (with Slack's nested `confirm` dialog: "Are you absolutely sure?" / "Kill All" / "Go Back") and secondary "Cancel" button. `buildCancelConfirmationBlocks` returns similar layout. Action IDs follow `{action}_{confirm|cancel}` pattern.
   - Estimated effort: 2 hours

8. **Implement Slack interaction handler** -- Per TDD section 3.4.5.
   - Files to create: `intake/adapters/slack/slack_interaction_handler.ts`
   - Acceptance criteria: Receives POST to `/slack/interactions`. Verifies request signature. Parses `payload` JSON from form-encoded body. Routes by `payload.type`: `block_actions` for button clicks, `view_submission` for modal submissions, `shortcut` for global shortcuts. Extracts `action_id` or `callback_id` and dispatches to command handler. Responds within 3 seconds; if longer, acknowledges immediately and posts follow-up via `response_url`. Validates button clicker authorization.
   - Estimated effort: 4 hours

9. **Implement modal form for complex submissions** -- Via `views.open`.
   - Files to create/modify: `intake/adapters/slack/slack_components.ts`, `intake/adapters/slack/slack_interaction_handler.ts`
   - Acceptance criteria: Modal with description (paragraph, required), repo (short, optional), and acceptance criteria (paragraph, optional) text inputs. Opened via `views.open` with `trigger_id` from the original slash command. Modal submission routed through interaction handler, fields extracted and passed to IntakeRouter as a submit command.
   - Estimated effort: 3 hours

10. **Implement thread-based clarifying conversations** -- Per TDD section 3.10.3.
    - Files to create/modify: `intake/adapters/slack/slack_adapter.ts`
    - Acceptance criteria: When the first clarifying question is needed, post via `chat.postMessage` with `thread_ts` set to the original acknowledgment message's `ts`. Call `conversations.join` on the thread to receive replies. Store `thread_ts` in `ConversationMessage.thread_id` and request's notification config. Subsequent messages for this request use the same `thread_ts`.
    - Estimated effort: 3 hours

11. **Implement Slack user identity mapping** -- Map Slack user ID to internal identity.
    - Files to create: `intake/adapters/slack/slack_identity.ts`
    - Acceptance criteria: Looks up `user_identities.slack_id` to find internal user ID. If no mapping exists, returns unauthorized error (Slack users must be pre-provisioned in `intake-auth.yaml`). Resolves display name via `users.info` API call (cached for 1 hour) for notification context.
    - Estimated effort: 2 hours

12. **Implement Socket Mode fallback** -- Per TDD TQ-11.
    - Files to create: `intake/adapters/slack/slack_socket_mode.ts`
    - Acceptance criteria: When `slack.socket_mode: true` in config, uses `@slack/socket-mode` `SocketModeClient` instead of HTTP server. Same command handling logic; only transport differs. Socket Mode app token loaded from `SLACK_APP_TOKEN` environment variable. Reconnection logic on disconnect.
    - Estimated effort: 3 hours

13. **Implement platform rate limit handling** -- Respect Slack API limits.
    - Files to create: `intake/adapters/slack/slack_rate_limiter.ts`
    - Acceptance criteria: Wraps all Slack Web API calls. On HTTP 429, extracts `Retry-After` header and passes to `withRetry` utility. Respects Slack tier limits (e.g., Tier 3: ~50 req/min for `chat.postMessage`). Logs rate limit events at `warn` level.
    - Estimated effort: 2 hours

14. **Implement bot startup recovery** -- Per TDD section 3.13.1.
    - Files to create/modify: `intake/adapters/slack/slack_adapter.ts`
    - Acceptance criteria: On startup, queries `conversation_messages` for pending outbound prompts with `responded = false` and `timeout_at > now`. Re-sends each pending prompt to the appropriate channel/thread with a "[Resent]" prefix in Block Kit context. Logs each re-sent prompt.
    - Estimated effort: 2 hours

15. **Implement graceful shutdown** -- Stop HTTP server and Socket Mode cleanly.
    - Files to create/modify: `intake/adapters/slack/slack_adapter.ts`
    - Acceptance criteria: `shutdown()` stops accepting new webhook requests, waits for in-flight requests to complete (10s timeout), closes HTTP server (or disconnects Socket Mode client). Integrates with core graceful shutdown framework.
    - Estimated effort: 1 hour

16. **Write Slack adapter tests** -- Per TDD section 8.3.
    - Files to create: `intake/__tests__/adapters/slack/slack_adapter.test.ts`, `intake/__tests__/adapters/slack/slack_verifier.test.ts`, `intake/__tests__/adapters/slack/slack_formatter.test.ts`, `intake/__tests__/adapters/slack/slack_components.test.ts`, `intake/__tests__/adapters/slack/slack_interaction_handler.test.ts`
    - Acceptance criteria: Mock Slack Web API client. Verify request signature verification (valid, stale timestamp rejection, invalid signature rejection). Verify Block Kit payload structure matches Slack schema. Verify modal submission handling. Verify `response_url` follow-up for slow commands. Verify ephemeral error messages. Verify thread creation with `thread_ts`. Verify identity resolution.
    - Estimated effort: 6 hours

17. **Write Slack integration tests** -- Full flow through Slack adapter.
    - Files to create: `intake/__tests__/integration/slack_e2e.test.ts`
    - Acceptance criteria: Submit via mock slash command webhook -> verify request in DB. Status query -> verify Block Kit response. Kill -> verify confirmation button flow with nested confirm dialog. Modal submission -> verify request created. Thread-based conversation -> verify `thread_ts` used correctly.
    - Estimated effort: 4 hours

18. **Write replay attack security test** -- Per TDD section 8.4.
    - Files to create: `intake/__tests__/security/slack_replay.test.ts`
    - Acceptance criteria: Send request with timestamp > 5 minutes old, verify HTTP 401 rejection. Send request with invalid signature, verify rejection. Send request with valid signature and recent timestamp, verify acceptance.
    - Estimated effort: 1 hour

## Dependencies & Integration Points

- **PLAN-008-1 (Core Infrastructure)**: IntakeRouter, AuthzEngine, Repository, all handlers must be complete.
- **PLAN-008-2 (Claude App Adapter)**: Validates IntakeAdapter interface contract. Arg parser can be reused. Not a hard dependency but reduces interface risk.
- **`@slack/web-api`**: NPM dependency for Slack Web API calls.
- **`@slack/socket-mode`**: Optional NPM dependency for Socket Mode fallback.
- **Slack API app**: Must be created in Slack workspace with correct manifest. Bot token and signing secret stored in environment variables.
- **HTTPS endpoint**: Slack requires a publicly accessible HTTPS endpoint for webhook delivery. Cloudflare Tunnel or similar must be configured (infrastructure concern, not part of this plan).
- **PLAN-008-5 (Notifications)**: Block Kit formatter is created here but the proactive push and digest delivery are wired in PLAN-008-5.

## Testing Strategy

- **Unit tests**: Mock Slack Web API client. Test signature verification with known valid/invalid inputs. Test Block Kit formatter output against Slack Block Kit schema. Test component structures. Test interaction handler routing.
- **Integration tests**: Use real SQLite database with mocked Slack Web API. Simulate webhook POST requests, verify full flow through IntakeRouter, and verify database state.
- **Security tests**: Replay attack prevention (stale timestamp), signature tampering, rate limit enforcement.
- **No live Slack workspace needed**: All tests use mocked Slack API components.

## Risks

1. **HTTPS endpoint requirement**: Slack webhooks require a publicly accessible HTTPS endpoint. Mitigation: document Cloudflare Tunnel setup; provide Socket Mode as a fallback for environments without public endpoints.
2. **Slack's 3-second response deadline**: Slash commands must be acknowledged within 3 seconds or Slack shows an error to the user. Mitigation: always acknowledge immediately with HTTP 200, use `response_url` for the actual result.
3. **10 individual slash commands namespace pollution**: Registering 10 `/ad-*` commands may feel cluttered in the Slack command palette. Mitigation: clear descriptions and usage hints; Slack's search/filter makes this manageable. Documented as a platform limitation in TDD section 9.4.
4. **Slack Block Kit limits**: Messages cannot exceed 50 blocks or 3000 chars per text block. Mitigation: formatter truncates and paginates; documented in acceptance criteria.
5. **Socket Mode app token vs bot token**: Socket Mode requires a separate app-level token (`xapp-*`), not the bot token. Mitigation: document the distinction clearly; validate token format on startup.

## Definition of Done

- [ ] `SlackAdapter` implements all `IntakeAdapter` methods
- [ ] Slack app manifest defines all 10 slash commands with correct scopes and URLs
- [ ] Request signature verification rejects stale timestamps and invalid signatures
- [ ] All 10 slash commands handled with 3-second acknowledgment and `response_url` follow-up
- [ ] Block Kit formatter renders status with emoji, fields, context, and conditional sections
- [ ] Interactive buttons render for kill (with nested confirm) and cancel confirmations with authz check
- [ ] Modal form for complex submissions opens via `trigger_id` and routes submission through IntakeRouter
- [ ] Threads used for clarifying conversations via `thread_ts`; thread joined for reply monitoring
- [ ] Slack user identity resolved from `user_identities.slack_id`
- [ ] Ephemeral messages used for errors visible only to the invoking user
- [ ] Socket Mode fallback works when configured
- [ ] Platform rate limits respected (`Retry-After` header, backoff)
- [ ] Bot startup recovery re-sends pending prompts
- [ ] Graceful shutdown stops HTTP server and Socket Mode cleanly
- [ ] Full command parity with Claude App and Discord adapters verified
- [ ] Unit tests pass for all Slack-specific components including signature verification
- [ ] Integration tests pass for full lifecycle through Slack adapter
- [ ] Replay attack security test passes
