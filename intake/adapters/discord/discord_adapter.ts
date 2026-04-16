/**
 * Discord Adapter -- IntakeAdapter implementation for the Discord channel.
 *
 * Contains:
 * - {@link DiscordAdapter} class implementing the {@link IntakeAdapter}
 *   interface for the Discord bot channel (SPEC-008-3-02, Tasks 3 & 4).
 * - Interaction deferral and response editing pattern to meet Discord's
 *   3-second acknowledgment deadline.
 * - Argument extraction from Discord slash command interaction options.
 * - Graceful shutdown with in-flight interaction draining.
 *
 * Key design decisions:
 * - All slash command interactions are immediately deferred (`deferReply`)
 *   before any processing to avoid the 3-second Discord deadline.
 * - The deferred response is edited with the formatted result after the
 *   IntakeRouter completes processing.
 * - Interaction tokens expire after 15 minutes; expired `editReply` calls
 *   are caught and logged without crashing.
 * - During shutdown, new interactions receive an ephemeral rejection while
 *   in-flight interactions are allowed to complete (up to 10s).
 *
 * @module discord_adapter
 */

import type {
  IntakeAdapter,
  AdapterHandle,
  ChannelType,
  MessageTarget,
  FormattedMessage,
  StructuredPrompt,
  UserResponse,
  TimeoutExpired,
  DeliveryReceipt,
  IncomingCommand,
  CommandResult,
  PromptOption,
} from '../adapter_interface';
import type { Repository } from '../../db/repository';
import type { DiscordIdentityResolver } from './discord_identity';
import { AuthorizationError } from './discord_identity';
import type { DiscordRateLimitHandler } from './discord_rate_limiter';

// ---------------------------------------------------------------------------
// Discord.js type stubs (minimal interfaces for compile-time decoupling)
// ---------------------------------------------------------------------------

/**
 * Minimal discord.js Client interface.
 *
 * Accepts the real discord.js `Client` at runtime; tests can supply a stub.
 */
export interface DiscordJSClient {
  on(event: string, listener: (...args: unknown[]) => void): void;
  user?: { id: string; tag?: string };
  channels?: {
    fetch(channelId: string): Promise<unknown>;
  };
}

/**
 * Minimal wrapper around the discord.js `Client`, providing connect/disconnect
 * lifecycle and access to the underlying client instance.
 *
 * The concrete implementation is in `discord_client.ts` (SPEC-008-3-01).
 */
export interface DiscordClient {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getClient(): DiscordJSClient;
}

/**
 * Minimal discord.js ChatInputCommandInteraction interface.
 */
export interface ChatInputCommandInteraction {
  /** Whether the interaction can be replied to. */
  isRepliable(): boolean;
  /** Whether this is a chat input (slash) command. */
  isChatInputCommand(): boolean;
  /** Whether this is a message component interaction. */
  isMessageComponent(): boolean;
  /** Whether this is a modal submit interaction. */
  isModalSubmit(): boolean;
  /** Defer the reply (acknowledge within 3 seconds). */
  deferReply(): Promise<void>;
  /** Edit the deferred reply with content. */
  editReply(data: { embeds?: unknown[]; content?: string }): Promise<void>;
  /** Reply to the interaction. */
  reply(data: { content: string; ephemeral?: boolean }): Promise<void>;
  /** The interaction options accessor. */
  options: {
    getSubcommand(): string;
    getString(name: string, required: boolean): string;
    getBoolean(name: string, required: boolean): boolean | null;
  };
  /** The interaction user. */
  user: { id: string };
  /** The channel ID where the interaction was received. */
  channelId: string;
  /** String representation of the interaction. */
  toString(): string;
}

/**
 * Minimal discord.js MessageComponentInteraction interface.
 */
export interface MessageComponentInteraction {
  customId: string;
  user: { id: string };
  isRepliable(): boolean;
  reply(data: { content: string; ephemeral?: boolean }): Promise<void>;
  update(data: { content: string; components: unknown[] }): Promise<void>;
}

/**
 * Minimal discord.js ModalSubmitInteraction interface.
 */
export interface ModalSubmitInteraction {
  fields: {
    getTextInputValue(customId: string): string;
  };
  user: { id: string };
  channelId: string;
  deferReply(): Promise<void>;
  editReply(data: { content?: string; embeds?: unknown[] }): Promise<void>;
}

/**
 * Minimal discord.js TextChannel interface for sending messages.
 */
export interface TextChannelLike {
  send(data: {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
  }): Promise<{ id: string; createdTimestamp: number }>;
}

/**
 * Minimal discord.js ThreadChannel interface.
 *
 * Represents a thread created from a message, supporting `send()`.
 */
export interface ThreadChannel {
  id: string;
  send(data: {
    content?: string;
    embeds?: unknown[];
    components?: unknown[];
  }): Promise<{ id: string; createdTimestamp: number }>;
}

/**
 * Minimal discord.js TextChannel interface for thread creation.
 *
 * Extends TextChannelLike with message fetching for `startThread`.
 */
export interface TextChannelWithThreads extends TextChannelLike {
  messages: {
    fetch(messageId: string): Promise<{
      startThread(options: {
        name: string;
        autoArchiveDuration: number;
      }): Promise<ThreadChannel>;
    }>;
  };
}

/**
 * Thread auto-archive duration constants matching discord.js
 * ThreadAutoArchiveDuration enum values.
 */
export const ThreadAutoArchiveDuration = {
  OneHour: 60,
  OneDay: 1440,
  ThreeDays: 4320,
  OneWeek: 10080,
} as const;

/**
 * Minimal message object returned by channel.send(), supporting
 * component collection for promptUser.
 */
export interface SentMessage {
  id: string;
  createdTimestamp: number;
  awaitMessageComponent(options: {
    filter: (i: { user: { id: string }; customId: string }) => boolean;
    time: number;
  }): Promise<{ user: { id: string }; customId: string }>;
}

// ---------------------------------------------------------------------------
// Forward-declared dependency interfaces
// ---------------------------------------------------------------------------

/**
 * Router interface consumed by the adapter.
 *
 * The concrete implementation is in `intake/core/intake_router.ts`.
 */
export interface IntakeRouter {
  route(command: IncomingCommand): Promise<CommandResult>;
}

/**
 * Discord embed formatter interface.
 *
 * Renders structured data into Discord embed objects. The concrete
 * implementation is in `intake/notifications/formatters/discord_formatter.ts`
 * (SPEC-008-3-03, Task 5).
 */
export interface DiscordFormatter {
  formatStatusEmbed(data: unknown): unknown;
  formatError(error: { error: string; errorCode: string }): unknown;
}

/**
 * Handler for button clicks and modal submissions.
 *
 * The concrete implementation is in `discord_interaction_handler.ts`
 * (SPEC-008-3-03, Task 7).
 */
export interface ComponentInteractionHandler {
  handle(interaction: MessageComponentInteraction): Promise<void>;
  handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void>;
}

/**
 * Slash command registration function type.
 *
 * The concrete implementation is in `discord_commands.ts` (SPEC-008-3-01).
 */
export type RegisterCommandsFn = (
  client: DiscordJSClient,
  guildId: string,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Logger (structured JSON to stderr, matching codebase conventions)
// ---------------------------------------------------------------------------

const logger = {
  info(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'info', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'warn', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
  error(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({ level: 'error', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
};

// ---------------------------------------------------------------------------
// Channel resolver helper
// ---------------------------------------------------------------------------

/**
 * Minimal interface for resolving a Discord channel from a target.
 *
 * In production the discord.js Client provides `channels.fetch(id)`.
 */
export interface ChannelResolver {
  resolveChannel(target: MessageTarget): Promise<TextChannelLike>;
}

// ---------------------------------------------------------------------------
// ActionRowBuilder helper for promptUser buttons
// ---------------------------------------------------------------------------

/**
 * Build a simple action row of buttons from prompt options.
 *
 * Returns a discord.js-compatible ActionRow component structure. The actual
 * discord.js `ActionRowBuilder`/`ButtonBuilder` classes are used at runtime;
 * this function constructs the raw JSON payload that discord.js accepts.
 *
 * @param options - The prompt options to convert to buttons.
 * @returns A discord.js action row component.
 */
function buildOptionButtons(
  options: PromptOption[],
): Record<string, unknown> {
  const STYLE_MAP: Record<string, number> = {
    primary: 1,
    secondary: 2,
    danger: 4,
  };

  return {
    type: 1, // ACTION_ROW
    components: options.map((opt) => ({
      type: 2, // BUTTON
      custom_id: opt.value,
      label: opt.label,
      style: STYLE_MAP[opt.style ?? 'secondary'] ?? 2,
    })),
  };
}

// ---------------------------------------------------------------------------
// DiscordAdapter
// ---------------------------------------------------------------------------

/**
 * Discord adapter implementing the {@link IntakeAdapter} interface.
 *
 * Lifecycle:
 * - {@link start} connects the Discord gateway, registers slash commands for
 *   the configured guild, and sets up the interaction event listener. Returns
 *   an {@link AdapterHandle} for disposal.
 * - While running, each slash command interaction is immediately deferred,
 *   routed through the {@link IntakeRouter}, and the deferred response is
 *   edited with the formatted result.
 * - Button and modal interactions are delegated to the
 *   {@link ComponentInteractionHandler}.
 * - {@link sendMessage} sends embeds to the resolved channel and returns a
 *   {@link DeliveryReceipt}.
 * - {@link promptUser} sends buttons and waits for user interaction with a
 *   timeout.
 * - {@link shutdown} sets the shutdown flag, waits for in-flight interactions
 *   to drain (up to 10s), and disconnects the gateway.
 *
 * Implements SPEC-008-3-02, Tasks 3 & 4.
 */
export class DiscordAdapter implements IntakeAdapter {
  readonly channelType: ChannelType = 'discord';

  /** Set to `true` by {@link shutdown}; new interactions are rejected. */
  private shuttingDown = false;

  /** Count of interactions currently being processed. */
  private inFlightInteractions = 0;

  /** Channel resolver for sendMessage/promptUser. */
  private channelResolver: ChannelResolver | null = null;

  constructor(
    private readonly client: DiscordClient,
    private readonly router: IntakeRouter,
    private readonly identityResolver: DiscordIdentityResolver,
    private readonly formatter: DiscordFormatter,
    private readonly componentHandler: ComponentInteractionHandler,
    private readonly registerCommands: RegisterCommandsFn = defaultRegisterCommands,
    private readonly db?: Repository,
    private readonly rateLimiter?: DiscordRateLimitHandler,
  ) {}

  // -----------------------------------------------------------------------
  // IntakeAdapter: start
  // -----------------------------------------------------------------------

  /**
   * Connect the Discord gateway, register slash commands, and start
   * listening for interaction events.
   *
   * @returns An {@link AdapterHandle} whose `dispose` method triggers shutdown.
   */
  async start(): Promise<AdapterHandle> {
    await this.client.connect();

    const guildId = process.env.DISCORD_GUILD_ID!;
    if (!guildId) {
      throw new Error('DISCORD_GUILD_ID environment variable is not set');
    }

    await this.registerCommands(this.client.getClient(), guildId);
    this.setupInteractionListener();

    // Recover pending prompts from before the restart (Task 12)
    await this.startupRecovery();

    logger.info('Discord adapter started', { guildId });

    return { dispose: () => this.shutdown() };
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: sendMessage
  // -----------------------------------------------------------------------

  /**
   * Send a formatted message to the specified Discord channel.
   *
   * Resolves the target channel, sends the embed payload with a fallback
   * text content, and returns a {@link DeliveryReceipt} indicating success
   * or failure.
   *
   * @param target  - Where to send the message.
   * @param payload - The formatted message content.
   * @returns A delivery receipt with the platform message ID on success.
   */
  async sendMessage(
    target: MessageTarget,
    payload: FormattedMessage,
  ): Promise<DeliveryReceipt> {
    try {
      const channel = await this.resolveChannel(target);
      const msg = await channel.send({
        embeds: payload.payload ? [payload.payload] : undefined,
        content: payload.fallbackText,
      });
      return { success: true, platformMessageId: msg.id };
    } catch (error) {
      const err = error as { message?: string; status?: number };
      return {
        success: false,
        error: err.message ?? 'Unknown error',
        retryable: err.status === 429 || (err.status !== undefined && err.status >= 500),
      };
    }
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: promptUser
  // -----------------------------------------------------------------------

  /**
   * Send a structured prompt to a user and await their response.
   *
   * If the prompt includes selectable options, they are rendered as Discord
   * buttons. The method waits for a button click or message reply from the
   * target user, up to the configured timeout.
   *
   * @param target - The user/channel to prompt.
   * @param prompt - The structured prompt with content, options, and timeout.
   * @returns The user's response, or a {@link TimeoutExpired} if no response
   *          was received within the timeout period.
   */
  async promptUser(
    target: MessageTarget,
    prompt: StructuredPrompt,
  ): Promise<UserResponse | TimeoutExpired> {
    const channel = await this.resolveChannel(target);

    // Build message with optional button components
    const components = prompt.options
      ? [buildOptionButtons(prompt.options)]
      : [];

    const msg = (await channel.send({
      content: prompt.content,
      components,
    })) as unknown as SentMessage;

    // Wait for button interaction or message reply
    try {
      const collected = await msg.awaitMessageComponent({
        filter: (i) => i.user.id === target.userId!,
        time: prompt.timeoutSeconds * 1000,
      });
      return {
        responderId: collected.user.id,
        content: collected.customId,
        selectedOption: collected.customId,
        timestamp: new Date(),
      };
    } catch {
      return {
        kind: 'timeout',
        requestId: prompt.requestId,
        promptedAt: new Date(msg.createdTimestamp),
        expiredAt: new Date(),
      };
    }
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: shutdown
  // -----------------------------------------------------------------------

  /**
   * Gracefully shut down the Discord adapter.
   *
   * 1. Sets {@link shuttingDown} to `true` so new interactions are rejected
   *    with an ephemeral "System is shutting down." message.
   * 2. Waits up to 10 seconds for in-flight interactions to complete.
   * 3. Disconnects the Discord gateway.
   */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    // Wait for in-flight interactions to complete (max 10s)
    const deadline = Date.now() + 10_000;
    while (this.inFlightInteractions > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.inFlightInteractions > 0) {
      logger.warn('Forcing shutdown with in-flight interactions', {
        count: this.inFlightInteractions,
      });
    }

    // Disconnect the gateway
    await this.client.disconnect();
    logger.info('Discord adapter shutdown complete');
  }

  // -----------------------------------------------------------------------
  // Accessors for testing
  // -----------------------------------------------------------------------

  /** Whether the adapter is in the process of shutting down. */
  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /** Number of interactions currently being processed. */
  get currentInFlightCount(): number {
    return this.inFlightInteractions;
  }

  // -----------------------------------------------------------------------
  // Channel resolver injection (for testability)
  // -----------------------------------------------------------------------

  /**
   * Set a custom channel resolver for sendMessage/promptUser.
   *
   * In production this delegates to the discord.js client's channel cache.
   * Tests can inject a mock resolver.
   */
  setChannelResolver(resolver: ChannelResolver): void {
    this.channelResolver = resolver;
  }

  // -----------------------------------------------------------------------
  // Thread-based clarifying conversations (Task 9)
  // -----------------------------------------------------------------------

  /**
   * Create a thread on the acknowledgment message for clarifying questions.
   *
   * When the first clarifying question is needed for a request, this method
   * creates a Discord thread on the specified message. Subsequent messages
   * for the same request reuse the existing thread (the caller checks
   * `notification_config.routes[].threadId` before calling this).
   *
   * The thread ID is persisted in:
   * 1. `request.notification_config.routes[].threadId` for routing.
   * 2. `ConversationMessage.thread_id` for message-level tracking.
   *
   * @param channelId  - The Discord channel containing the acknowledgment message.
   * @param messageId  - The acknowledgment message to create the thread on.
   * @param requestId  - The request ID (used in the thread name).
   * @returns The created ThreadChannel.
   * @throws When the channel is not found, not text-based, or the DB is not configured.
   */
  async createClarifyingThread(
    channelId: string,
    messageId: string,
    requestId: string,
  ): Promise<ThreadChannel> {
    const discordClient = this.client.getClient();
    if (!discordClient.channels) {
      throw new Error('Discord client does not support channel fetching');
    }

    const channel = await discordClient.channels.fetch(channelId);
    if (!channel) {
      throw new Error('Channel not found or not text-based');
    }

    const textChannel = channel as unknown as TextChannelWithThreads;
    const message = await textChannel.messages.fetch(messageId);
    const thread = await message.startThread({
      name: `${requestId} - Clarification`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });

    // Persist thread ID in the request's notification_config
    if (this.db) {
      const request = this.db.getRequest(requestId);
      if (request) {
        const existingConfig = JSON.parse(request.notification_config || '{}');
        this.db.updateRequest(requestId, {
          notification_config: JSON.stringify({
            ...existingConfig,
            routes: [{
              channelType: 'discord',
              threadId: thread.id,
              platformChannelId: channelId,
            }],
          }),
        });
      }
    }

    return thread;
  }

  // -----------------------------------------------------------------------
  // Bot startup recovery (Task 12)
  // -----------------------------------------------------------------------

  /**
   * Re-send pending prompts that were awaiting user responses before
   * the bot restarted.
   *
   * Filter criteria:
   * - `channel = 'discord'`
   * - `responded = false` (responded = 0)
   * - `timeout_at > now` (not yet expired)
   *
   * Resent messages include "[Resent]" in the embed title and fallback
   * text to distinguish them from the original prompt.
   *
   * Errors on individual re-sends are logged but do not prevent
   * processing of remaining prompts.
   */
  async startupRecovery(): Promise<void> {
    if (!this.db) return;

    const pendingPrompts = this.db.getPendingPrompts();
    const discordPrompts = pendingPrompts.filter(
      (p) => p.channel === 'discord' && p.timeout_at != null && new Date(p.timeout_at) > new Date(),
    );

    for (const prompt of discordPrompts) {
      try {
        // Resolve the platform channel ID from the request's notification_config
        const request = this.db.getRequest(prompt.request_id);
        let platformChannelId: string | undefined;
        if (request) {
          try {
            const config = JSON.parse(request.notification_config || '{}');
            const route = config.routes?.find(
              (r: { channelType: string }) => r.channelType === 'discord',
            );
            platformChannelId = route?.platformChannelId;
          } catch {
            // notification_config may not be valid JSON
          }
        }

        const target: MessageTarget = {
          channelType: 'discord',
          platformChannelId,
          threadId: prompt.thread_id ?? undefined,
        };

        await this.sendMessage(target, {
          channelType: 'discord',
          payload: {
            title: '[Resent] Pending Question',
            description: prompt.content,
            color: 0xf39c12, // Yellow for resent
          },
          fallbackText: `[Resent] ${prompt.content}`,
        });

        logger.info('Re-sent pending prompt after startup', {
          requestId: prompt.request_id,
          messageId: prompt.message_id,
        });
      } catch (error) {
        logger.error('Failed to re-send pending prompt', {
          requestId: prompt.request_id,
          error: (error as Error).message,
        });
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: interaction listener setup
  // -----------------------------------------------------------------------

  /**
   * Register the `interactionCreate` event handler on the Discord client.
   *
   * Routes interactions by type:
   * - Chat input (slash) commands -> {@link handleSlashCommand}
   * - Message components (buttons) -> {@link ComponentInteractionHandler.handle}
   * - Modal submissions -> {@link ComponentInteractionHandler.handleModalSubmit}
   *
   * During shutdown, all repliable interactions receive an ephemeral
   * "System is shutting down." message.
   */
  private setupInteractionListener(): void {
    this.client.getClient().on('interactionCreate', async (rawInteraction: unknown) => {
      const interaction = rawInteraction as ChatInputCommandInteraction;

      if (this.shuttingDown) {
        if (interaction.isRepliable()) {
          try {
            await interaction.reply({
              content: 'System is shutting down.',
              ephemeral: true,
            });
          } catch {
            // Interaction may already be expired
          }
        }
        return;
      }

      if (interaction.isChatInputCommand()) {
        await this.handleSlashCommand(interaction);
      } else if (interaction.isMessageComponent()) {
        await this.componentHandler.handle(
          rawInteraction as unknown as MessageComponentInteraction,
        );
      } else if (interaction.isModalSubmit()) {
        await this.componentHandler.handleModalSubmit(
          rawInteraction as unknown as ModalSubmitInteraction,
        );
      }
    });
  }

  // -----------------------------------------------------------------------
  // Private: slash command handling (Task 4)
  // -----------------------------------------------------------------------

  /**
   * Handle a slash command interaction through the full pipeline.
   *
   * Flow:
   * 1. IMMEDIATELY defer the reply (must happen within 3 seconds).
   * 2. Extract the subcommand name and options.
   * 3. Resolve the Discord user to an internal identity.
   * 4. Construct an {@link IncomingCommand}.
   * 5. Route through the {@link IntakeRouter}.
   * 6. Edit the deferred response with the formatted result.
   *
   * If the identity resolver throws (unprovisioned user), the error is
   * shown in the deferred response. If `editReply` fails (15-minute
   * interaction expiry), the error is logged without crashing.
   *
   * @param interaction - The Discord slash command interaction.
   */
  private async handleSlashCommand(
    interaction: ChatInputCommandInteraction,
  ): Promise<void> {
    this.inFlightInteractions++;
    try {
      // Step 1: IMMEDIATELY defer (must happen within 3 seconds)
      await interaction.deferReply();

      // Step 2: Extract subcommand and options
      const subcommand = interaction.options.getSubcommand();
      const args = this.extractArgs(interaction, subcommand);
      const flags = this.extractFlags(interaction, subcommand);

      // Step 3: Resolve identity
      let userId: string;
      try {
        userId = await this.identityResolver.resolve(interaction.user.id);
      } catch (error) {
        if (error instanceof AuthorizationError) {
          await interaction.editReply({ content: `Error: ${error.message}` });
          return;
        }
        throw error;
      }

      // Step 4: Construct IncomingCommand
      const command: IncomingCommand = {
        commandName: subcommand,
        args,
        flags,
        rawText: interaction.toString(),
        source: {
          channelType: 'discord',
          userId,
          platformChannelId: interaction.channelId,
          timestamp: new Date(),
        },
      };

      // Step 5: Route through IntakeRouter
      const result = await this.router.route(command);

      // Step 6: Edit the deferred response
      if (result.success) {
        const formatted = this.formatter.formatStatusEmbed(result.data);
        await interaction.editReply({ embeds: [formatted] });
      } else {
        await interaction.editReply({
          content: `Error: ${result.error}`,
        });
      }
    } catch (error) {
      // Handle interaction expiry (15-minute Discord limit) or other errors
      try {
        await interaction.editReply({
          content: 'An error occurred processing your command.',
        });
      } catch {
        logger.warn('Failed to edit expired interaction', {
          error: (error as Error).message,
        });
      }
    } finally {
      this.inFlightInteractions--;
    }
  }

  // -----------------------------------------------------------------------
  // Private: argument extraction from Discord interactions
  // -----------------------------------------------------------------------

  /**
   * Extract positional arguments from a Discord slash command interaction.
   *
   * Maps each subcommand to the specific option names it expects, retrieving
   * them from the interaction's options accessor in the correct order.
   *
   * @param interaction - The Discord slash command interaction.
   * @param subcommand  - The subcommand name being processed.
   * @returns An array of positional argument strings.
   */
  private extractArgs(
    interaction: ChatInputCommandInteraction,
    subcommand: string,
  ): string[] {
    switch (subcommand) {
      case 'submit':
        return [interaction.options.getString('description', true)];
      case 'status':
      case 'cancel':
      case 'pause':
      case 'resume':
      case 'logs':
        return [interaction.options.getString('request-id', true)];
      case 'priority':
        return [
          interaction.options.getString('request-id', true),
          interaction.options.getString('level', true),
        ];
      case 'feedback':
        return [
          interaction.options.getString('request-id', true),
          interaction.options.getString('message', true),
        ];
      case 'list':
      case 'kill':
        return [];
      default:
        return [];
    }
  }

  /**
   * Extract named flags from a Discord slash command interaction.
   *
   * Flags are optional parameters that correspond to the `--flag` syntax
   * in the Claude App adapter. Discord interactions provide these as typed
   * options which are extracted here into a key-value map.
   *
   * @param interaction - The Discord slash command interaction.
   * @param subcommand  - The subcommand name being processed.
   * @returns A record of flag names to their values.
   */
  private extractFlags(
    interaction: ChatInputCommandInteraction,
    subcommand: string,
  ): Record<string, string | boolean> {
    const flags: Record<string, string | boolean> = {};

    switch (subcommand) {
      case 'submit': {
        const priority = interaction.options.getString('priority', false);
        if (priority) flags.priority = priority;
        const repo = interaction.options.getString('repo', false);
        if (repo) flags.repo = repo;
        const deadline = interaction.options.getString('deadline', false);
        if (deadline) flags.deadline = deadline;
        break;
      }
      case 'list': {
        const priority = interaction.options.getString('priority', false);
        if (priority) flags.priority = priority;
        break;
      }
      case 'logs': {
        const all = interaction.options.getBoolean('all', false);
        if (all !== null && all !== undefined) flags.all = all;
        break;
      }
      default:
        break;
    }

    return flags;
  }

  // -----------------------------------------------------------------------
  // Private: channel resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve a {@link MessageTarget} to a Discord text channel.
   *
   * Uses the injected channel resolver if available, otherwise throws.
   * In production, the channel resolver wraps `client.channels.fetch()`.
   *
   * @param target - The message target specifying channel/thread/DM.
   * @returns A text channel that supports `send()`.
   * @throws When no channel resolver is configured or the channel is not found.
   */
  private async resolveChannel(target: MessageTarget): Promise<TextChannelLike> {
    if (this.channelResolver) {
      return this.channelResolver.resolveChannel(target);
    }

    throw new Error(
      'No channel resolver configured. Set one via setChannelResolver() ' +
        `or inject one in the constructor. Target: ${JSON.stringify(target)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Default no-op command registration (overridden at runtime)
// ---------------------------------------------------------------------------

/**
 * Default command registration function (no-op).
 *
 * The real implementation from `discord_commands.ts` is injected at
 * construction time. This default exists so the adapter can be instantiated
 * in tests without the discord.js REST dependency.
 */
async function defaultRegisterCommands(
  _client: DiscordJSClient,
  _guildId: string,
): Promise<void> {
  // No-op; real implementation injected via constructor
}
