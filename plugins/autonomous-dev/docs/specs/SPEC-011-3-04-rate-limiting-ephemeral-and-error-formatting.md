# SPEC-011-3-04: Per-Guild Rate Limiting, Ephemeral Preferences, Error Formatting, and Lifecycle (Shutdown + Reconnect)

## Metadata
- **Parent Plan**: PLAN-011-3
- **Tasks Covered**: Task 5 (graceful shutdown drain), Task 6 (reconnection backoff), Task 7 (structured logging), Task 8 (systemd + launchd)
- **Estimated effort**: 6 hours

## Description
Round out the production-readiness layer of `DiscordService`: enforce per-guild rate limiting on inbound interactions to protect downstream services, route every reply through a single ephemeral-aware formatter, and unify error responses so users always see actionable messages. Add the graceful shutdown drain (FR-812: 5 seconds), exponential reconnection backoff (FR-814: 1s..60s, 10 attempts), and the systemd/launchd deployment templates.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/discord/main.ts` | Modify | Add `stop()`, signal handlers, reconnect loop |
| `intake/adapters/discord/discord_rate_limiter.ts` | Verify/Modify | Confirm per-guild bucket; expose `consume(guildId): RateLimitDecision` |
| `intake/adapters/discord/discord_replies.ts` | Create | `replyEphemeral`, `replyError`, ephemeral preference resolver |
| `contrib/systemd/discord-bot.service` | Create | systemd unit file template |
| `contrib/launchd/dev.autonomous.discord-bot.plist` | Create | launchd plist for macOS |
| `intake/__tests__/adapters/discord/lifecycle.test.ts` | Create | Shutdown + reconnect unit tests |

## Implementation Details

### Per-Guild Rate Limiting

Use the existing `discord_rate_limiter.ts`. If the file already exposes a token-bucket per guild, consume it in the interaction handler. If it does not yet enforce the spec'd limits, extend it.

Required behavior:

```ts
interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number;
  remaining: number;
}

export function consumeGuildBudget(guildId: string | null): RateLimitDecision;
```

Bucket parameters:

| Parameter | Value |
|-----------|-------|
| Capacity (burst) | 30 interactions |
| Refill rate | 30 per 60 seconds (sliding window via token-bucket math) |
| Scope | Per `guildId`; DMs (no guild) share a single global bucket |
| Eviction | Buckets idle > 10 minutes are removed to bound memory |

Wiring: in `interactionCreate`, before dispatching to slash/button/modal handlers, call `consumeGuildBudget(interaction.guildId)`. If `allowed === false`:

1. Reply ephemerally: `Rate limit reached for this server. Try again in ${Math.ceil(retryAfterMs/1000)}s.`
2. Log `discord_rate_limit_blocked` with `guildId`, `userId`, `retryAfterMs`.
3. Return without forwarding to the adapter.

### Ephemeral Reply Preferences

User preference: `ephemeralReplies: 'always' | 'errors-only' | 'never'`. Default `'always'` for slash command responses; errors and rate-limit messages are ALWAYS ephemeral regardless of preference.

`discord_replies.ts` exports:

```ts
export async function replyEphemeral(
  interaction: RepliableInteraction,
  content: string,
): Promise<void>;

export async function replyError(
  interaction: RepliableInteraction,
  err: unknown,
): Promise<void>;

export function shouldBeEphemeral(
  pref: EphemeralPref,
  isError: boolean,
): boolean;
```

`replyError` formatting:

| Error type | Surface message |
|------------|-----------------|
| `ConfigurationError` | `Configuration error: ${err.message}. Contact your operator.` |
| `ValidationError` | `${err.message}` (already user-facing) |
| `IntakeRouterError` (downstream) | `Could not process request: ${err.message}` |
| Any other `Error` | `Internal error (id: ${correlationId}). Check logs.` (do not leak `err.message`) |
| Non-`Error` thrown value | `Internal error (id: ${correlationId}).` |

For unknown errors, `correlationId = interaction.id`; the stack trace is logged with the same correlationId so operators can connect the user-facing message to the log entry.

`replyError` chooses between `interaction.reply`, `interaction.editReply`, and `interaction.followUp` based on whether the interaction has been deferred or already replied to. This logic lives once in this helper.

### Graceful Shutdown (FR-812)

```ts
async stop(): Promise<void> {
  this.shutdownRequested = true;
  this.logger.info('discord_service_stopping', { drainMs: this.config.shutdownDrainMs });

  // 1. Stop accepting new interactions: install a guard at the head of interactionCreate.
  // 2. Wait for in-flight handlers (tracked via a Set<Promise<void>>).
  await Promise.race([
    Promise.allSettled([...this.inflight]),
    sleep(this.config.shutdownDrainMs),
  ]);

  // 3. Destroy the client.
  await this.client.destroy();
  this.logger.info('discord_service_stopped', {
    inflightAtTimeout: this.inflight.size,
  });
}
```

Track in-flight handlers in a `Set<Promise<void>>`:

```ts
const p = (async () => { /* handler */ })();
this.inflight.add(p);
p.finally(() => this.inflight.delete(p));
```

Signal handlers (installed in `start()`):

```ts
const onSignal = (sig: string) => {
  this.logger.info('discord_service_signal', { signal: sig });
  this.stop().then(() => process.exit(0)).catch(() => process.exit(1));
};
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT',  () => onSignal('SIGINT'));
```

Exit codes: `0` on clean drain, `1` on error during stop, `124` if drain timed out with non-zero `inflightAtTimeout`.

### Reconnection Backoff (FR-814)

Listen for `shardDisconnect`. On disconnect (with non-recoverable close code), do NOT auto-let discord.js reconnect; instead drive the loop:

```ts
async reconnect(): Promise<void> {
  if (this.shutdownRequested) return;
  for (let attempt = 1; attempt <= 10; attempt++) {
    if (this.shutdownRequested) return;
    const delayMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1)); // 1,2,4,8,16,32,60,60,60,60
    this.logger.warn('discord_reconnect_attempt', { attempt, delayMs });
    await sleep(delayMs);
    try {
      await this.client.login(this.config.botToken);
      await this.waitForReady(this.config.readyTimeoutMs);
      this.logger.info('discord_reconnect_success', { attempt });
      return;
    } catch (err) {
      this.logger.warn('discord_reconnect_failed', { attempt, err: redactToken(String(err)) });
    }
  }
  this.logger.error('discord_reconnect_exhausted', { attempts: 10 });
  process.exit(2);
}
```

Recoverable close codes (per discord.js): allow discord.js's built-in reconnect. Non-recoverable codes (4004 auth failed, 4014 disallowed intents): exit immediately with code 3 — these are config errors, not transient.

### systemd Unit (`contrib/systemd/discord-bot.service`)

```ini
[Unit]
Description=autonomous-dev Discord Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=/etc/autonomous-dev/discord.env
WorkingDirectory=/opt/autonomous-dev
ExecStart=/usr/bin/node /opt/autonomous-dev/intake/adapters/discord/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
KillSignal=SIGTERM
StandardOutput=journal
StandardError=journal
User=autonomous
Group=autonomous

[Install]
WantedBy=multi-user.target
```

`/etc/autonomous-dev/discord.env` (operator-supplied, mode 0600):

```
DISCORD_BOT_TOKEN=...
DISCORD_APPLICATION_ID=...
DISCORD_GUILD_ID=...
NODE_ENV=production
```

### launchd Plist (`contrib/launchd/dev.autonomous.discord-bot.plist`)

Standard `LaunchAgents` plist with `KeepAlive`, `RunAtLoad`, `EnvironmentVariables` keys. `StandardOutPath` and `StandardErrorPath` to `~/Library/Logs/autonomous-dev/discord-bot.{out,err}.log`. `ProgramArguments` array: `["/usr/local/bin/node", "/Users/.../main.js"]`.

## Acceptance Criteria

- [ ] When a guild exceeds 30 interactions/min, the 31st within the window receives the documented ephemeral rate-limit message and does NOT reach the adapter
- [ ] Idle rate-limit buckets are evicted after 10 minutes
- [ ] Errors and rate-limit messages are ALWAYS ephemeral regardless of `ephemeralReplies` preference
- [ ] `replyError` produces the exact surface message documented per error type
- [ ] Internal (unknown) errors do NOT leak the raw `err.message` to the user; only the correlationId is shown
- [ ] `stop()` resolves within `shutdownDrainMs + 100ms` (margin for client.destroy)
- [ ] In-flight handlers complete normally if they finish before drain timeout
- [ ] In-flight handlers in progress at drain timeout produce exit code 124
- [ ] SIGTERM and SIGINT both trigger `stop()` and exit with code 0 on clean drain
- [ ] Reconnect attempts follow the documented delay sequence: 1, 2, 4, 8, 16, 32, 60, 60, 60, 60 seconds (with `Math.min(60s)` cap)
- [ ] Reconnect loop terminates immediately if `shutdownRequested` flips to true mid-loop
- [ ] After 10 failed reconnect attempts, process exits with code 2 and logs `discord_reconnect_exhausted`
- [ ] Close codes 4004 and 4014 cause immediate exit code 3 without entering the reconnect loop
- [ ] `systemd-analyze verify contrib/systemd/discord-bot.service` reports zero issues
- [ ] `plutil -lint contrib/launchd/dev.autonomous.discord-bot.plist` reports OK

## Dependencies

- SPEC-011-3-01 (Client setup), SPEC-011-3-02 (registration), SPEC-011-3-03 (reply routing) — all interact with the lifecycle and rate limiter installed here.
- `discord_rate_limiter.ts` — existing module; extend if missing the bucket parameters.
- discord.js: `Events.ShardDisconnect`, `RepliableInteraction`.

## Notes

- The reconnect loop deliberately drives login itself rather than relying on discord.js's internal reconnection, because we need bounded retries (max 10) and need to participate in the shutdown lifecycle (cancel mid-wait).
- Exit codes (0/1/2/3/124) are documented so systemd's `Restart=on-failure` correctly distinguishes "config broken — do not restart" (3) from "transient failure — restart" (1, 2).
- The 30/min/guild rate limit is a service-protection floor, not a user-facing limit. Discord's own gateway rate limits are stricter and enforced at the library layer; this is purely for backpressure on the downstream `IntakeRouter`.
- Ephemeral preference resolution may later move to the user/identity service. For now, it lives as a per-call argument with `'always'` as the default.
