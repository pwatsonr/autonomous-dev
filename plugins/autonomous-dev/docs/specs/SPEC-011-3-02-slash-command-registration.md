# SPEC-011-3-02: Slash Command Registration and Interaction-to-IncomingCommand Mapping

## Metadata
- **Parent Plan**: PLAN-011-3
- **Tasks Covered**: Task 4 (register all 10 slash commands; guild-specific vs global modes)
- **Estimated effort**: 4 hours

## Description
Register the ten `/request-*` slash commands with Discord during `DiscordService.start()`. Support two registration modes: guild-specific (instant propagation, used when `DISCORD_GUILD_ID` is set) and global (1-hour propagation, used when no guild ID is configured). Verify the existing `DiscordAdapter`'s interaction-to-`IncomingCommand` mapping covers all 10 commands with all expected options. This spec does not introduce new mapping logic — it ensures registration matches what the adapter already handles and adds regression tests for any gaps.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `intake/adapters/discord/main.ts` | Modify | Add `registerSlashCommands()` private method, called from `start()` |
| `intake/adapters/discord/discord_commands.ts` | Verify/Modify | Confirm all 10 command builders export from this module; add any missing |
| `intake/__tests__/adapters/discord/command_registration.test.ts` | Create | Unit tests for both modes + payload shape |

## Implementation Details

### The 10 Slash Commands

The full set, mirroring the bash dispatcher subcommands (SPEC-011-1-01) and the Slack adapter:

| Command | Required options | Optional options |
|---------|------------------|-------------------|
| `/request-submit` | `description: string` | `priority: enum{high,normal,low}` |
| `/request-status` | `request_id: string` | — |
| `/request-list` | — | `state: enum{active,paused,completed,all}` |
| `/request-cancel` | `request_id: string` | `reason: string` |
| `/request-pause` | `request_id: string` | — |
| `/request-resume` | `request_id: string` | — |
| `/request-priority` | `request_id: string`, `priority: enum{high,normal,low}` | — |
| `/request-logs` | `request_id: string` | `lines: integer (1..1000, default 100)` |
| `/request-feedback` | `request_id: string`, `message: string` | — |
| `/request-kill` | `request_id: string` | — |

`request_id` options must include a `setMinLength(10)` and `setMaxLength(10)` constraint matching `REQ-NNNNNN` format. Discord enforces this client-side; the adapter still validates server-side via the same regex used in SPEC-011-1-01.

### `registerSlashCommands()` Method

```ts
private async registerSlashCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(this.config.botToken);
  const commands = buildAllRequestCommands(); // from discord_commands.ts
  const body = commands.map(c => c.toJSON());

  if (this.config.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(this.config.applicationId, this.config.guildId),
      { body },
    );
    this.logger.info('discord_slash_commands_registered', {
      mode: 'guild',
      guildId: this.config.guildId,
      count: body.length,
    });
  } else {
    await rest.put(
      Routes.applicationCommands(this.config.applicationId),
      { body },
    );
    this.logger.info('discord_slash_commands_registered', {
      mode: 'global',
      count: body.length,
      propagationNote: 'Global commands take up to 1 hour to propagate.',
    });
  }
}
```

Call site in `start()`: register **after** login + ready, **before** the service is considered fully started. If registration fails, `start()` rejects with `StartupError('Slash command registration failed: <discord error>')` and the client is destroyed.

### Error Handling

Map common Discord REST error codes to actionable messages:

| Discord code | Surface message |
|--------------|-----------------|
| `50001` (Missing Access) | `Bot lacks access to guild ${guildId}. Re-invite the bot with applications.commands scope.` |
| `50013` (Missing Permissions) | `Bot is missing permissions in guild ${guildId}.` |
| `30032` (Max guild commands) | `Guild ${guildId} has hit the slash command limit (100). Remove unused commands.` |
| `40060` (Already acknowledged) | Should not occur during registration; log raw error. |
| Network / 5xx | Retry once after 1s; on second failure surface raw error. |

### `discord_commands.ts` Verification

Open the existing `discord_commands.ts` and assert the module exports `buildAllRequestCommands(): SlashCommandBuilder[]` returning exactly 10 builders matching the table above. If any are missing, add them following the existing builder pattern. Do not refactor unrelated builders.

### Interaction-to-IncomingCommand Mapping

The existing `DiscordAdapter.handleInteraction` already maps `ChatInputCommandInteraction` → `IncomingCommand`. Verify (via test) that for each of the 10 commands:

- `IncomingCommand.command` equals the command name minus the `/request-` prefix (e.g., `submit`, `status`).
- All option values are present in `IncomingCommand.args` keyed by option name.
- `IncomingCommand.channel` is `'discord'`.
- `IncomingCommand.user.id` is the Discord user snowflake.

If any of these assertions fail in the existing adapter, file a finding (do not fix here — that belongs to a separate spec). Document the failure in test output.

## Acceptance Criteria

- [ ] `start()` invokes `registerSlashCommands()` after the ready event
- [ ] When `guildId` is set, commands are PUT to `applicationGuildCommands(applicationId, guildId)`
- [ ] When `guildId` is undefined, commands are PUT to `applicationCommands(applicationId)`
- [ ] Exactly 10 commands are registered, names matching the table verbatim
- [ ] Each command's options match the required/optional column with correct types and enum choices
- [ ] `request_id` options include `setMinLength(10)` and `setMaxLength(10)`
- [ ] Registration failure throws `StartupError` with a wrapped Discord error message
- [ ] Discord error codes 50001, 50013, and 30032 produce the documented actionable messages
- [ ] For each of the 10 commands, the existing adapter maps the interaction to a correctly-shaped `IncomingCommand` (asserted by unit test)
- [ ] No bot token appears in any logged registration payload

## Dependencies

- SPEC-011-3-01 (Client setup) — `start()` flow must be complete before registration runs.
- `discord_commands.ts` — existing module exporting command builders.
- `DiscordAdapter` — interaction mapping consumed as-is; tests verify behavior, do not modify.
- discord.js: `REST`, `Routes`, `SlashCommandBuilder`.

## Notes

- Guild-specific registration is preferred for development and for single-tenant deployments. Global registration is only used when the operator wants the bot to work in arbitrary guilds (rare for an autonomous-dev installation).
- The 1-hour global propagation delay is a Discord platform constraint and cannot be worked around. The log entry includes the `propagationNote` so operators are not surprised.
- This spec uses `PUT` (overwrite all) rather than `POST` (incremental add) to ensure the registered set always matches the current code. Removing a command from `discord_commands.ts` and redeploying will deregister it on the next start.
- Slash command quota: each guild has a 100-command limit. Ten is well within that; the 30032 mapping exists for safety only.
