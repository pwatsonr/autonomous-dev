# SPEC-011-3-01: discord.js Client Setup, Login, and Interaction Event Handler

## Metadata
- **Parent Plan**: PLAN-011-3
- **Tasks Covered**: Task 1 (add discord.js dep), Task 2 (DiscordService skeleton + config), Task 3 (Client init + login + interaction wiring)
- **Estimated effort**: 5 hours

## Description
Establish the foundational `DiscordService` class in `intake/adapters/discord/main.ts`. This spec covers the discord.js dependency installation, configuration loading and validation, Client construction with the minimum required gateway intents, login with a 30-second ready timeout, and wiring the `interactionCreate` event to the existing `DiscordAdapter` so interactions flow into `IntakeRouter`. Webhook secret / `DISCORD_BOT_TOKEN` validation happens at startup — invalid or disabled configurations must fail fast with actionable errors before any network call.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `package.json` | Modify | Add `discord.js@^14.14.0` to `dependencies` |
| `intake/adapters/discord/main.ts` | Create | `DiscordService` class scaffold + start() |
| `intake/adapters/discord/main.ts` | Create | Re-exports `DiscordService` and `DiscordServiceConfig` |

## Implementation Details

### Task 1: Add discord.js Dependency

Add to `package.json` `dependencies`:

```json
"discord.js": "^14.14.0"
```

After `npm install`, verify `node_modules/discord.js/package.json` exists and that no peer-dependency warnings surface for `@discordjs/ws` or `@discordjs/rest`.

### Task 2: `DiscordService` Class Skeleton + Config

```ts
export interface DiscordServiceConfig {
  botToken: string;            // env: DISCORD_BOT_TOKEN
  applicationId: string;       // env: DISCORD_APPLICATION_ID
  guildId?: string;            // env: DISCORD_GUILD_ID (optional → global mode)
  enabled: boolean;            // intake.channels.discord.enabled
  readyTimeoutMs: number;      // default 30_000
  shutdownDrainMs: number;     // default 5_000 (FR-812)
}

export class DiscordService {
  constructor(
    private readonly config: DiscordServiceConfig,
    private readonly adapter: DiscordAdapter,
    private readonly logger: Logger,
  ) { /* validate config */ }

  async start(): Promise<void> { /* Task 3 */ }
  async stop(): Promise<void> { /* SPEC-011-3-04 */ }
}
```

Constructor validation (throw `ConfigurationError` with the listed message):

| Condition | Error message |
|-----------|---------------|
| `config.enabled === false` | `Discord channel is disabled in intake.channels.discord.enabled` |
| `!config.botToken` | `DISCORD_BOT_TOKEN env var is required` |
| `!config.applicationId` | `DISCORD_APPLICATION_ID env var is required` |
| `botToken` does not match `/^[A-Za-z0-9_\-.]{50,}$/` | `DISCORD_BOT_TOKEN format invalid (token redacted)` — never log the token value |
| `guildId` provided but not `^\d{17,20}$` | `DISCORD_GUILD_ID must be a numeric snowflake (17-20 digits)` |

Add `loadConfigFromEnv(): DiscordServiceConfig` — reads env vars, applies defaults, returns the struct. The orchestrator (caller) is responsible for invoking this and passing the result.

### Task 3: Client Initialization, Login, Interaction Handler

`start()` sequence:

1. Construct the Client with the minimum intents required for slash commands:
   ```ts
   this.client = new Client({
     intents: [GatewayIntentBits.Guilds],
     // No message-content intent needed — slash commands only.
   });
   ```
2. Register lifecycle event listeners (signatures only; full reconnection logic is in SPEC-011-3-04):
   - `client.once('ready', ...)` — resolve the ready promise.
   - `client.on('error', err => this.logger.error('discord_client_error', { err }))`.
   - `client.on('shardDisconnect', ...)` and `client.on('shardReconnecting', ...)` — log only in this spec.
3. Register the interaction event handler:
   ```ts
   client.on(Events.InteractionCreate, async (interaction) => {
     try {
       await this.adapter.handleInteraction(interaction);
     } catch (err) {
       this.logger.error('interaction_handler_failed', {
         interactionId: interaction.id,
         interactionType: interaction.type,
         err,
       });
       // SPEC-011-3-04 owns error formatting / ephemeral reply.
     }
   });
   ```
4. Login with timeout:
   ```ts
   await Promise.race([
     this.client.login(this.config.botToken),
     this.timeoutAfter(this.config.readyTimeoutMs, 'discord_login_timeout'),
   ]);
   await this.waitForReady(this.config.readyTimeoutMs);
   ```
   On timeout: call `client.destroy()`, throw `StartupError('Discord ready timeout exceeded (>30s)')`.
5. Log structured startup phases:
   - `discord_service_starting` (no token in payload)
   - `discord_client_logged_in` (with `applicationId`, `guildId`)
   - `discord_client_ready` (with shard count, gateway latency)

### Token redaction

The `botToken` MUST never appear in any log entry, exception message, or thrown error. Implement a `redactToken(s: string): string` helper that replaces matches of `/[A-Za-z0-9_\-.]{50,}/` with `[REDACTED]` and run all error messages through it before throwing or logging.

## Acceptance Criteria

- [ ] `discord.js@^14.14.0` is present in `package.json` and resolves cleanly via `npm install`
- [ ] `new DiscordService(config, adapter, logger)` throws `ConfigurationError` for each row in the validation table with the exact documented message
- [ ] `start()` constructs the Client with `intents: [GatewayIntentBits.Guilds]` and no other intents
- [ ] `start()` resolves successfully when login + ready complete within 30 seconds
- [ ] `start()` rejects with `StartupError('Discord ready timeout exceeded (>30s)')` and calls `client.destroy()` when ready does not fire within `readyTimeoutMs`
- [ ] An `InteractionCreate` event is forwarded to `adapter.handleInteraction(interaction)` exactly once per event
- [ ] Errors thrown by `adapter.handleInteraction` are caught, logged with `interactionId` and `interactionType`, and do NOT crash the process
- [ ] No log entry, error message, or stack trace contains the raw bot token (verified by grep against test logs)
- [ ] `tsc --noEmit` passes; `eslint` passes with zero warnings

## Dependencies

- `DiscordAdapter` from `intake/adapters/discord/discord_adapter.ts` — consumed as-is via constructor injection.
- Logger interface — match the existing project logger contract used by other adapters (JSON to stderr).
- discord.js types: `Client`, `GatewayIntentBits`, `Events`, `Interaction`.

## Notes

- This spec deliberately limits the Client to `GatewayIntentBits.Guilds`. The bot only consumes interactions; it never reads message content. Adding `MessageContent` would require a privileged intent and Discord verification — out of scope.
- The 30-second ready timeout is conservative; Discord typically delivers the ready event in <2s. The timeout exists to fail fast if the gateway is unreachable rather than hang indefinitely.
- Reconnection (FR-814), graceful shutdown drain (FR-812), and slash command registration are intentionally deferred to SPEC-011-3-02 and SPEC-011-3-04. Keep this spec focused on a service that can connect, accept interactions, and route them.
- The `DiscordAdapter` already maps `Interaction` objects to `IncomingCommand` and forwards to `IntakeRouter` — do not duplicate that logic here.
