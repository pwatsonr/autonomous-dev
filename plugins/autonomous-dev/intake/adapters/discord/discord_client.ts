/**
 * Discord Bot Module -- Client setup and lifecycle management.
 *
 * Configures the discord.js v14+ Client with required gateway intents
 * (Guilds, GuildMessages), handles connection lifecycle (login/disconnect),
 * and exposes the raw Client for use by the command registration module.
 *
 * Implements SPEC-008-3-01, Task 1.
 *
 * @module discord_client
 */

import { Client, GatewayIntentBits, Events } from 'discord.js';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for structured logging within the Discord client.
 */
export interface DiscordClientLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Default no-op logger (used when none is injected)
// ---------------------------------------------------------------------------

const noopLogger: DiscordClientLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// DiscordClient
// ---------------------------------------------------------------------------

/**
 * Manages the discord.js Client lifecycle.
 *
 * - Creates the client with `Guilds` and `GuildMessages` intents.
 * - Loads the bot token from `DISCORD_BOT_TOKEN` environment variable.
 * - Handles gateway errors at `error` log level; gateway disconnects at
 *   `warn` level. Automatic reconnection is managed internally by discord.js.
 * - Exposes {@link getClient} for use by the command registration module.
 *
 * No privileged intents are required -- the bot does not read message
 * content; it only processes slash command interactions.
 */
export class DiscordClient {
  private client: Client;
  private logger: DiscordClientLogger;

  constructor(logger?: DiscordClientLogger) {
    this.logger = logger ?? noopLogger;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
    });
  }

  /**
   * Connect the bot to Discord.
   *
   * Reads `DISCORD_BOT_TOKEN` from the environment. Throws with a
   * descriptive error if the variable is not set. Registers an error
   * listener on the gateway before calling `login()`.
   *
   * @throws {Error} If `DISCORD_BOT_TOKEN` is not set or if `login()` fails.
   */
  async connect(): Promise<void> {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN environment variable is not set');
    }

    this.client.on(Events.Error, (error) => {
      this.logger.error('Discord client error', { error: error.message });
    });

    this.client.on(Events.ShardDisconnect, (event) => {
      this.logger.warn('Discord gateway disconnected', {
        code: event.code,
        reason: event.reason,
      });
    });

    await this.client.login(token);
    this.logger.info('Discord bot connected', {
      user: this.client.user?.tag,
      guilds: this.client.guilds.cache.size,
    });
  }

  /**
   * Disconnect the bot from Discord, releasing all resources.
   */
  async disconnect(): Promise<void> {
    this.client.destroy();
    this.logger.info('Discord bot disconnected');
  }

  /**
   * Return the underlying discord.js Client instance.
   *
   * Used by {@link registerCommands} to obtain the application ID and
   * attach interaction listeners.
   */
  getClient(): Client {
    return this.client;
  }
}
