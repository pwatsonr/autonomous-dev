/**
 * Discord Slash Command Registration -- Guild-scoped `/ad` command group.
 *
 * Defines the full JSON payload for the `/ad` command group with all 10
 * subcommands and registers them via the Discord REST API bulk overwrite
 * PUT endpoint:
 *
 *   PUT /applications/{application_id}/guilds/{guild_id}/commands
 *
 * The PUT endpoint is idempotent: it replaces all existing guild commands,
 * so re-running registration on every bot startup is safe.
 *
 * Implements SPEC-008-3-01, Task 2.
 *
 * @module discord_commands
 */

import { Client, REST, Routes } from 'discord.js';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within command registration.
 */
export interface CommandRegistrationLogger {
  info(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Default no-op logger (used when none is injected)
// ---------------------------------------------------------------------------

const noopLogger: CommandRegistrationLogger = {
  info: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// Discord option type constants
// ---------------------------------------------------------------------------

/** Discord application command option types used in the payload. */
const OptionType = {
  /** A subcommand nested under a chat input command. */
  SUB_COMMAND: 1,
  /** A string argument. */
  STRING: 3,
  /** A boolean flag. */
  BOOLEAN: 5,
} as const;

// ---------------------------------------------------------------------------
// Command payload (TDD section 3.3.2)
// ---------------------------------------------------------------------------

/**
 * Full slash command payload for the `/ad` command group.
 *
 * Contains all 10 subcommands:
 * submit, status, list, cancel, pause, resume, priority, logs, feedback, kill.
 *
 * Registered as a guild-scoped command via the REST API.
 */
export const DISCORD_COMMANDS = [
  {
    name: 'ad',
    description: 'Autonomous Dev pipeline commands',
    type: 1, // CHAT_INPUT
    options: [
      {
        name: 'submit',
        description: 'Submit a new request to the pipeline',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'description',
            description: 'What do you want built?',
            type: OptionType.STRING,
            required: true,
            max_length: 10000,
          },
          {
            name: 'priority',
            description: 'Request priority',
            type: OptionType.STRING,
            required: false,
            choices: [
              { name: 'High', value: 'high' },
              { name: 'Normal', value: 'normal' },
              { name: 'Low', value: 'low' },
            ],
          },
          {
            name: 'repo',
            description: 'Target repository (owner/name)',
            type: OptionType.STRING,
            required: false,
          },
          {
            name: 'deadline',
            description: 'Deadline (YYYY-MM-DD)',
            type: OptionType.STRING,
            required: false,
          },
        ],
      },
      {
        name: 'status',
        description: 'View current state and progress of a request',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'request-id',
            description: 'Request ID (e.g., REQ-000042)',
            type: OptionType.STRING,
            required: true,
            min_length: 10,
            max_length: 10,
          },
        ],
      },
      {
        name: 'list',
        description: 'List all active requests',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'priority',
            description: 'Filter by priority',
            type: OptionType.STRING,
            required: false,
            choices: [
              { name: 'High', value: 'high' },
              { name: 'Normal', value: 'normal' },
              { name: 'Low', value: 'low' },
            ],
          },
        ],
      },
      {
        name: 'cancel',
        description: 'Cancel a request and clean up artifacts',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'request-id',
            description: 'Request ID',
            type: OptionType.STRING,
            required: true,
          },
        ],
      },
      {
        name: 'pause',
        description: 'Pause a request at the next phase boundary',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'request-id',
            description: 'Request ID',
            type: OptionType.STRING,
            required: true,
          },
        ],
      },
      {
        name: 'resume',
        description: 'Resume a paused request',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'request-id',
            description: 'Request ID',
            type: OptionType.STRING,
            required: true,
          },
        ],
      },
      {
        name: 'priority',
        description: 'Change request priority',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'request-id',
            description: 'Request ID',
            type: OptionType.STRING,
            required: true,
          },
          {
            name: 'level',
            description: 'New priority level',
            type: OptionType.STRING,
            required: true,
            choices: [
              { name: 'High', value: 'high' },
              { name: 'Normal', value: 'normal' },
              { name: 'Low', value: 'low' },
            ],
          },
        ],
      },
      {
        name: 'logs',
        description: 'View activity log for a request',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'request-id',
            description: 'Request ID',
            type: OptionType.STRING,
            required: true,
          },
          {
            name: 'all',
            description: 'Show complete log',
            type: OptionType.BOOLEAN,
            required: false,
          },
        ],
      },
      {
        name: 'feedback',
        description: 'Send feedback or context to an active request',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'request-id',
            description: 'Request ID',
            type: OptionType.STRING,
            required: true,
          },
          {
            name: 'message',
            description: 'Your feedback message',
            type: OptionType.STRING,
            required: true,
            max_length: 4000,
          },
        ],
      },
      {
        name: 'kill',
        description: 'Emergency stop ALL running requests (admin only)',
        type: OptionType.SUB_COMMAND,
      },
      // ---------------------------------------------------------------
      // SPEC-018-3-04: bug intake parity with the CLI
      //
      // Both subcommands open a Discord modal collecting the BugReport
      // fields documented in `schemas/bug-report.json`. `/ad submit-bug`
      // submits with priority=normal; `/ad hotfix` submits with
      // priority=high and severity defaulted to "high".
      // ---------------------------------------------------------------
      {
        name: 'submit-bug',
        description: 'Submit a structured bug report (opens a modal)',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'title',
            description: 'Bug title (1-200 chars)',
            type: OptionType.STRING,
            required: true,
            max_length: 200,
          },
          {
            name: 'repo',
            description: 'Target repository (owner/name)',
            type: OptionType.STRING,
            required: false,
          },
        ],
      },
      {
        name: 'hotfix',
        description: 'Submit a P0 bug requiring immediate attention',
        type: OptionType.SUB_COMMAND,
        options: [
          {
            name: 'title',
            description: 'Bug title (1-200 chars)',
            type: OptionType.STRING,
            required: true,
            max_length: 200,
          },
          {
            name: 'repo',
            description: 'Target repository (owner/name)',
            type: OptionType.STRING,
            required: false,
          },
        ],
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Registration function
// ---------------------------------------------------------------------------

/**
 * Register all `/ad` subcommands as guild-scoped slash commands.
 *
 * Uses the Discord REST API bulk overwrite PUT endpoint:
 *   `PUT /applications/{application_id}/guilds/{guild_id}/commands`
 *
 * This is idempotent -- the PUT replaces all existing guild commands,
 * so re-running on every startup is safe and expected.
 *
 * The guild ID is read from `DISCORD_GUILD_ID` environment variable.
 *
 * @param client  - The authenticated discord.js Client (must be logged in).
 * @param guildId - The Discord guild (server) ID to register commands for.
 *                  Defaults to `DISCORD_GUILD_ID` from the environment.
 * @param logger  - Optional structured logger.
 *
 * @throws {Error} If `DISCORD_BOT_TOKEN` is not set.
 * @throws {Error} If `client.user` is null (client not logged in).
 */
export async function registerCommands(
  client: Client,
  guildId?: string,
  logger?: CommandRegistrationLogger,
): Promise<void> {
  const log = logger ?? noopLogger;
  const resolvedGuildId = guildId ?? process.env.DISCORD_GUILD_ID;

  if (!resolvedGuildId) {
    throw new Error('DISCORD_GUILD_ID environment variable is not set');
  }

  if (!client.user) {
    throw new Error('Discord client is not logged in; client.user is null');
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    throw new Error('DISCORD_BOT_TOKEN environment variable is not set');
  }

  const rest = new REST({ version: '10' }).setToken(token);

  await rest.put(
    Routes.applicationGuildCommands(client.user.id, resolvedGuildId),
    { body: DISCORD_COMMANDS },
  );

  log.info('Discord slash commands registered', {
    guildId: resolvedGuildId,
    commandCount: DISCORD_COMMANDS[0].options!.length,
  });
}
