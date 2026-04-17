# SPEC-008-3-01: Discord Bot Setup & Slash Command Registration

## Metadata
- **Parent Plan**: PLAN-008-3
- **Tasks Covered**: Task 1, Task 2
- **Estimated effort**: 5 hours

## Description

Set up the Discord bot module with `discord.js` v14+, configure the client with required gateway intents, and implement guild-scoped slash command registration using the bulk overwrite PUT endpoint for the `/ad` command group with all 10 subcommands.

## Files to Create/Modify

| File | Action |
|------|--------|
| `intake/adapters/discord/discord_client.ts` | Create |
| `intake/adapters/discord/discord_commands.ts` | Create |
| `package.json` | Modify (add discord.js) |

## Implementation Details

### Task 1: Discord Bot Module Setup

```typescript
import { Client, GatewayIntentBits, Events } from 'discord.js';

class DiscordClient {
  private client: Client;

  constructor() {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
    });
  }

  async connect(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN environment variable is not set');
    }

    this.client.on(Events.Error, (error) => {
      logger.error('Discord client error', { error: error.message });
    });

    await this.client.login(token);
    logger.info('Discord bot connected', {
      user: this.client.user?.tag,
      guilds: this.client.guilds.cache.size,
    });
  }

  async disconnect(): Promise<void> {
    this.client.destroy();
  }

  getClient(): Client {
    return this.client;
  }
}
```

**Dependencies to add to `package.json`:**
```json
{
  "discord.js": "^14.14.0"
}
```

**Required intents:**
- `GatewayIntentBits.Guilds` -- required for guild member resolution and channel access.
- `GatewayIntentBits.GuildMessages` -- required for thread message monitoring.

**No privileged intents required** (the bot does not read message content; it only processes slash command interactions).

**Connection error handling:**
- On gateway disconnect, log at `warn` level.
- The `discord.js` client handles automatic reconnection internally.
- If initial `login()` fails, throw with a descriptive error.

### Task 2: Guild-Scoped Slash Command Registration

The `/ad` command group is registered via the Discord REST API bulk overwrite endpoint:

```
PUT /applications/{application_id}/guilds/{guild_id}/commands
```

**Full command payload** (from TDD section 3.3.2):

```typescript
const DISCORD_COMMANDS = [
  {
    name: 'ad',
    description: 'Autonomous Dev pipeline commands',
    type: 1, // CHAT_INPUT
    options: [
      {
        name: 'submit',
        description: 'Submit a new request to the pipeline',
        type: 1, // SUB_COMMAND
        options: [
          { name: 'description', description: 'What do you want built?', type: 3, required: true, max_length: 10000 },
          { name: 'priority', description: 'Request priority', type: 3, required: false,
            choices: [
              { name: 'High', value: 'high' },
              { name: 'Normal', value: 'normal' },
              { name: 'Low', value: 'low' },
            ]
          },
          { name: 'repo', description: 'Target repository (owner/name)', type: 3, required: false },
          { name: 'deadline', description: 'Deadline (YYYY-MM-DD)', type: 3, required: false },
        ],
      },
      {
        name: 'status',
        description: 'View current state and progress of a request',
        type: 1,
        options: [
          { name: 'request-id', description: 'Request ID (e.g., REQ-000042)', type: 3, required: true, min_length: 10, max_length: 10 },
        ],
      },
      {
        name: 'list',
        description: 'List all active requests',
        type: 1,
        options: [
          { name: 'priority', description: 'Filter by priority', type: 3, required: false,
            choices: [
              { name: 'High', value: 'high' },
              { name: 'Normal', value: 'normal' },
              { name: 'Low', value: 'low' },
            ]
          },
        ],
      },
      { name: 'cancel', description: 'Cancel a request and clean up artifacts', type: 1,
        options: [{ name: 'request-id', description: 'Request ID', type: 3, required: true }] },
      { name: 'pause', description: 'Pause a request at the next phase boundary', type: 1,
        options: [{ name: 'request-id', description: 'Request ID', type: 3, required: true }] },
      { name: 'resume', description: 'Resume a paused request', type: 1,
        options: [{ name: 'request-id', description: 'Request ID', type: 3, required: true }] },
      { name: 'priority', description: 'Change request priority', type: 1,
        options: [
          { name: 'request-id', description: 'Request ID', type: 3, required: true },
          { name: 'level', description: 'New priority level', type: 3, required: true,
            choices: [
              { name: 'High', value: 'high' },
              { name: 'Normal', value: 'normal' },
              { name: 'Low', value: 'low' },
            ]
          },
        ],
      },
      { name: 'logs', description: 'View activity log for a request', type: 1,
        options: [
          { name: 'request-id', description: 'Request ID', type: 3, required: true },
          { name: 'all', description: 'Show complete log', type: 5, required: false },
        ],
      },
      { name: 'feedback', description: 'Send feedback or context to an active request', type: 1,
        options: [
          { name: 'request-id', description: 'Request ID', type: 3, required: true },
          { name: 'message', description: 'Your feedback message', type: 3, required: true, max_length: 4000 },
        ],
      },
      { name: 'kill', description: 'Emergency stop ALL running requests (admin only)', type: 1 },
    ],
  },
];
```

**Option type codes**: `1` = SUB_COMMAND, `3` = STRING, `5` = BOOLEAN.

**Registration function:**

```typescript
async function registerCommands(client: Client, guildId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN!);
  await rest.put(
    Routes.applicationGuildCommands(client.user!.id, guildId),
    { body: DISCORD_COMMANDS },
  );
  logger.info('Discord slash commands registered', { guildId, commandCount: DISCORD_COMMANDS[0].options.length });
}
```

**Guild ID** is configured via `DISCORD_GUILD_ID` environment variable. The registration runs on bot startup.

**Idempotent**: The PUT endpoint replaces all existing commands, so re-running is safe.

## Acceptance Criteria

1. `discord.js` v14+ added as a dependency.
2. Bot client connects with `Guilds` and `GuildMessages` intents.
3. Bot token loaded from `DISCORD_BOT_TOKEN` environment variable; throws on missing.
4. Guild ID loaded from `DISCORD_GUILD_ID` environment variable.
5. All 10 subcommands registered under the `/ad` command group.
6. Each subcommand has correct option types: STRING (3) for text args, BOOLEAN (5) for `--all`.
7. `priority` options use `choices` enum with `high`, `normal`, `low`.
8. `description` option has `max_length: 10000`.
9. `request-id` on `status` has `min_length: 10, max_length: 10`.
10. `feedback` message has `max_length: 4000`.
11. Registration is idempotent (re-running does not error).

## Test Cases

1. **Client creation**: Verify client created with `GatewayIntentBits.Guilds` and `GatewayIntentBits.GuildMessages`.
2. **Missing token**: Set `DISCORD_BOT_TOKEN` to undefined; verify `connect()` throws descriptive error.
3. **Command payload structure**: Assert the JSON payload has exactly 1 top-level command named `ad` with 10 sub-commands.
4. **Subcommand names**: Verify all 10 names: submit, status, list, cancel, pause, resume, priority, logs, feedback, kill.
5. **Submit options**: Verify 4 options: description (required, string, max 10000), priority (optional, string, 3 choices), repo (optional, string), deadline (optional, string).
6. **Status options**: Verify 1 option: request-id (required, string, min 10, max 10).
7. **Priority choices**: Verify choices are `[{High, high}, {Normal, normal}, {Low, low}]` on submit, list, and priority subcommands.
8. **Logs boolean option**: Verify `all` option has type 5 (BOOLEAN).
9. **Kill no options**: Verify kill subcommand has no options array (or empty).
10. **Registration API call**: Mock REST client; verify `PUT` to correct route with correct body.
