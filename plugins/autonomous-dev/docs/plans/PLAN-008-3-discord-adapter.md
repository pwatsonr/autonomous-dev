# PLAN-008-3: Discord Bot Adapter

## Metadata
- **Parent TDD**: TDD-008-intake-layer
- **Estimated effort**: 8 days
- **Dependencies**: PLAN-008-1 (core infrastructure), PLAN-008-2 (validates IntakeAdapter interface)
- **Blocked by**: PLAN-008-1
- **Priority**: P1

## Objective

Implement the Discord bot adapter, delivering full command parity with the Claude App adapter over the Discord platform. This includes Discord OAuth2 bot setup, guild-scoped slash command registration, interaction deferral/response editing, rich embed formatting with color-coded status, thread-based clarifying conversations, button components for confirmations, modal forms for complex submissions, Discord user identity mapping, platform rate limit awareness, bot startup recovery, and graceful shutdown of the gateway connection.

## Scope

### In Scope
- `DiscordAdapter` implementing the `IntakeAdapter` interface
- Discord bot setup guidance (OAuth2 scopes: `bot`, `applications.commands`; permissions: Send Messages, Send Messages in Threads, Create Public Threads, Embed Links, Read Message History, Use Slash Commands, Add Reactions)
- Guild-scoped slash command registration (bulk overwrite via PUT) for the `/ad` command group with all 10 subcommands per TDD section 3.3.2
- Interaction flow: receive slash command via gateway, immediately defer (type 5), route through IntakeRouter, edit deferred response with result
- Discord embed formatter with color-coded status per phase (gray=queued, blue=generation, orange=review, purple=planning, green=execution/done, yellow=paused, red=cancelled/failed)
- Button components for kill confirmation and cancel confirmation per TDD section 3.3.5
- Modal form for complex submissions (description, repo, acceptance criteria) per TDD section 3.3.6
- `ComponentInteractionHandler` for routing button clicks with authz validation
- Thread creation for clarifying conversations (`channel.threads.create()` on acknowledgment message)
- Discord user identity mapping to internal user IDs via `user_identities.discord_id`
- Platform rate limit awareness: read `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `X-RateLimit-Bucket` headers; pause when `Remaining` = 0
- Exponential backoff with jitter for Discord REST API calls per TDD section 3.13.2
- Bot startup recovery: re-send pending prompts per TDD section 3.13.1
- Graceful shutdown for Discord gateway connection
- Discord-specific integration tests (mocked Discord.js REST client and gateway)

### Out of Scope
- Slack adapter -- PLAN-008-4
- NotificationEngine, digest scheduler -- PLAN-008-5 (this plan implements the Discord embed formatter but does not implement the proactive notification push system)
- ConversationManager -- PLAN-008-5 (this plan implements thread creation and `promptUser` but does not implement the full bidirectional communication manager)
- Mobile rendering validation (manual task, not automatable)
- DM-based notifications (implemented in PLAN-008-5 via NotificationEngine routing)
- Global slash command registration (guild-scoped only; global registration deferred)

## Tasks

1. **Set up Discord bot module and dependencies** -- Install `discord.js` (v14+), configure bot client with required intents and partials.
   - Files to create: `intake/adapters/discord/discord_client.ts`, `package.json` update
   - Acceptance criteria: `discord.js` added as dependency. Client created with `GatewayIntentBits.Guilds` and `GatewayIntentBits.GuildMessages`. Bot token loaded from `DISCORD_BOT_TOKEN` environment variable. Connection error handling with retry.
   - Estimated effort: 2 hours

2. **Implement guild-scoped slash command registration** -- Register the `/ad` command group with all subcommands per TDD section 3.3.2.
   - Files to create: `intake/adapters/discord/discord_commands.ts`
   - Acceptance criteria: All 10 subcommands defined as a single application command group with correct option types (string=3, boolean=5), required flags, max_length constraints, and choice enums for priority. Commands registered via bulk overwrite PUT on bot startup. Guild ID configurable via `DISCORD_GUILD_ID` environment variable.
   - Estimated effort: 3 hours

3. **Implement DiscordAdapter class** -- Core adapter implementing `IntakeAdapter` per TDD section 3.3.
   - Files to create: `intake/adapters/discord/discord_adapter.ts`
   - Acceptance criteria: Implements `start()` (connects gateway, registers commands, sets up interaction listener), `sendMessage()` (sends to channel/DM/thread), `promptUser()` (sends structured prompt with buttons, waits for response or timeout), `shutdown()` (disconnects gateway after draining). `channelType` is `'discord'`.
   - Estimated effort: 6 hours

4. **Implement interaction deferral and response editing** -- Per TDD section 3.3.3 interaction flow.
   - Files to create/modify: `intake/adapters/discord/discord_adapter.ts`
   - Acceptance criteria: On slash command interaction, immediately defer with `InteractionResponseType.DeferredChannelMessageWithSource` (type 5) within 3 seconds. Construct `IncomingCommand` and route through `IntakeRouter`. Edit the deferred response with the formatted result. Handle interaction expiry (15-minute Discord limit) gracefully.
   - Estimated effort: 3 hours

5. **Implement Discord embed formatter** -- Color-coded rich embeds per TDD section 3.3.4.
   - Files to create: `intake/notifications/formatters/discord_formatter.ts`
   - Acceptance criteria: `formatStatusEmbed` returns a Discord embed with: title (request ID + truncated title), color mapped by phase, fields (Phase, Priority, Progress, Age, Blocker -- all inline), footer (requester display name), timestamp. Implements `NotificationFormatter` interface. Handles all phase colors from TDD color map. Truncates title at 50 chars. `formatPhaseTransition`, `formatDigest`, and `formatError` methods.
   - Estimated effort: 4 hours

6. **Implement button components** -- Kill confirmation and cancel confirmation per TDD section 3.3.5.
   - Files to create: `intake/adapters/discord/discord_components.ts`
   - Acceptance criteria: `buildKillConfirmation` returns an `ActionRow` with DANGER-style "CONFIRM KILL ALL" button and SECONDARY "Cancel" button. `buildCancelConfirmation` returns similar layout. Custom IDs follow `{action}_{confirm|cancel}` pattern. Components are attached to deferred response edits.
   - Estimated effort: 2 hours

7. **Implement ComponentInteractionHandler** -- Route button clicks with authorization.
   - Files to create: `intake/adapters/discord/discord_interaction_handler.ts`
   - Acceptance criteria: Listens for `interactionCreate` events of type `MessageComponent`. Extracts `custom_id` and routes to appropriate handler. Validates that the button clicker is authorized (e.g., only the original command invoker or an admin can confirm kill). Responds with update or ephemeral error. Handles expired interactions.
   - Estimated effort: 3 hours

8. **Implement modal form for complex submissions** -- Per TDD section 3.3.6.
   - Files to create/modify: `intake/adapters/discord/discord_components.ts`, `intake/adapters/discord/discord_interaction_handler.ts`
   - Acceptance criteria: `buildSubmitModal` returns modal with description (paragraph, required, max 10000), repo (short, optional), and acceptance criteria (paragraph, optional, max 2000) fields. Modal submission routed through interaction handler, fields extracted and passed to IntakeRouter as a submit command. `trigger_id` from the original interaction used to open modal.
   - Estimated effort: 3 hours

9. **Implement thread-based clarifying conversations** -- Per TDD section 3.10.3.
   - Files to create/modify: `intake/adapters/discord/discord_adapter.ts`
   - Acceptance criteria: When the first clarifying question is needed, create a thread on the acknowledgment message via `channel.threads.create()`. Store thread ID in `ConversationMessage.thread_id` and request's notification config. Subsequent messages for this request use `thread.send()`. Thread name includes request ID.
   - Estimated effort: 3 hours

10. **Implement Discord user identity mapping** -- Map Discord user ID to internal identity.
    - Files to create: `intake/adapters/discord/discord_identity.ts`
    - Acceptance criteria: Looks up `user_identities.discord_id` to find internal user ID. If no mapping exists, returns an unauthorized error (Discord users must be pre-provisioned in `intake-auth.yaml`, unlike Claude App's auto-provision). Resolves display name via guild member fetch for notification context.
    - Estimated effort: 2 hours

11. **Implement platform rate limit awareness** -- Per TDD section 5.1.
    - Files to create: `intake/adapters/discord/discord_rate_limiter.ts`
    - Acceptance criteria: Wraps all Discord REST API calls. Reads `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `X-RateLimit-Bucket` headers from responses. When `Remaining` reaches 0, queues subsequent requests until reset time. Respects global rate limit (50 req/s). Integrates with the shared `withRetry` utility for 429 and 5xx errors.
    - Estimated effort: 3 hours

12. **Implement bot startup recovery** -- Per TDD section 3.13.1.
    - Files to create/modify: `intake/adapters/discord/discord_adapter.ts`
    - Acceptance criteria: On startup, queries `conversation_messages` for pending outbound prompts with `responded = false` and `timeout_at > now`. Re-sends each pending prompt to the appropriate channel/thread with a "[Resent]" prefix. Logs each re-sent prompt.
    - Estimated effort: 2 hours

13. **Implement graceful shutdown for Discord** -- Disconnect gateway cleanly.
    - Files to create/modify: `intake/adapters/discord/discord_adapter.ts`
    - Acceptance criteria: `shutdown()` sets a flag to stop accepting new interactions, waits for any in-flight interaction to complete (with 10s timeout), calls `client.destroy()` to close the gateway. Integrates with the core graceful shutdown framework.
    - Estimated effort: 1 hour

14. **Write Discord adapter tests** -- Per TDD section 8.3.
    - Files to create: `intake/__tests__/adapters/discord/discord_adapter.test.ts`, `intake/__tests__/adapters/discord/discord_commands.test.ts`, `intake/__tests__/adapters/discord/discord_formatter.test.ts`, `intake/__tests__/adapters/discord/discord_components.test.ts`, `intake/__tests__/adapters/discord/discord_interaction_handler.test.ts`
    - Acceptance criteria: Mock Discord.js REST client and gateway. Verify slash command registration payload matches TDD section 3.3.2 JSON structure. Verify interaction acknowledgment timing (deferred within handler). Verify embed formatting (colors, fields, truncation). Verify thread creation on first clarifying question. Verify button components structure. Verify modal structure. Verify identity resolution with pre-provisioned users.
    - Estimated effort: 6 hours

15. **Write Discord integration tests** -- Full flow through Discord adapter.
    - Files to create: `intake/__tests__/integration/discord_e2e.test.ts`
    - Acceptance criteria: Submit via mock Discord interaction -> verify request in DB. Status query -> verify embed response. Pause/resume -> verify state transitions. Kill -> verify confirmation button flow. Modal submission -> verify request created.
    - Estimated effort: 4 hours

## Dependencies & Integration Points

- **PLAN-008-1 (Core Infrastructure)**: IntakeRouter, AuthzEngine, Repository, all handlers must be complete.
- **PLAN-008-2 (Claude App Adapter)**: Validates the `IntakeAdapter` interface contract. Discord adapter implements the same interface. Not a hard dependency, but completing PLAN-008-2 first reduces risk of interface changes.
- **Discord.js v14+**: NPM dependency. Uses the REST API and gateway websocket.
- **Discord Developer Portal**: Bot must be created and invited to the target guild with correct permissions. Bot token stored in `DISCORD_BOT_TOKEN` environment variable.
- **PLAN-008-5 (Notifications)**: The Discord embed formatter is created here but the proactive notification push (NotificationEngine calling `DiscordAdapter.sendMessage`) is wired in PLAN-008-5.

## Testing Strategy

- **Unit tests**: Mock the Discord.js client (`Client`, `REST`, `WebSocketManager`). Test command registration payloads, embed formatting output, component structures, interaction routing logic, and identity resolution.
- **Integration tests**: Use real SQLite database with mocked Discord.js client. Simulate interaction events, verify full flow through IntakeRouter, and verify database state.
- **Rate limit tests**: Simulate 429 responses from Discord REST, verify backoff behavior and request queuing.
- **No live Discord server needed**: All tests use mocked Discord.js components.

## Risks

1. **Discord.js API breaking changes**: Discord.js v14+ has frequent minor releases. Mitigation: pin to a specific minor version; test against that version in CI.
2. **3-second interaction deadline**: If the IntakeRouter takes longer than expected (e.g., NLP parsing + duplicate detection), the deferred response pattern handles this, but the deferral itself must happen within 3 seconds. Mitigation: defer immediately before any processing; never do work before deferring.
3. **Thread creation rate limits**: Discord limits thread creation. Mitigation: only create one thread per request (not per question); reuse the thread for all clarifying exchanges on that request.
4. **Guild-scoped vs global commands**: Guild-scoped commands update instantly but only work in one guild. Mitigation: document this limitation; add configurable multi-guild support in a future iteration.
5. **Bot token security**: The Discord bot token grants full bot access. Mitigation: load from environment variable only, never log or store in config files; rotate token if compromised.

## Definition of Done

- [ ] `DiscordAdapter` implements all `IntakeAdapter` methods
- [ ] `/ad` command group with all 10 subcommands registered in target guild
- [ ] Interaction deferral within 3 seconds, response edited with formatted result
- [ ] Rich embeds display color-coded status with all fields (phase, priority, progress, age, blocker, artifacts)
- [ ] Button components render for kill and cancel confirmations with authorization check on click
- [ ] Modal form for complex submissions with description, repo, and acceptance criteria fields
- [ ] Threads created for clarifying conversations; thread ID persisted for reuse
- [ ] Discord user identity resolved from `user_identities.discord_id`
- [ ] Platform rate limits respected (header parsing, request queuing, backoff)
- [ ] Bot startup recovery re-sends pending prompts
- [ ] Graceful shutdown disconnects gateway after draining in-flight interactions
- [ ] Full command parity with Claude App adapter verified
- [ ] Unit tests pass for all Discord-specific components
- [ ] Integration tests pass for full lifecycle through Discord adapter
