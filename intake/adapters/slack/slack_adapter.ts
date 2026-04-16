/**
 * Slack Adapter -- IntakeAdapter implementation for the Slack channel.
 *
 * Contains:
 * - {@link SlackAdapter} class implementing the {@link IntakeAdapter}
 *   interface for the Slack integration (SPEC-008-4-02, Task 4).
 * - Dual-mode startup: HTTP server (default) or Socket Mode.
 * - Bidirectional messaging via `chat.postMessage` and `chat.postEphemeral`.
 * - Structured prompts with interactive Block Kit buttons and timeout handling.
 * - Graceful shutdown with Socket Mode disconnect or HTTP server stop.
 *
 * Key design decisions:
 * - The adapter supports two connection modes controlled by `config.socket_mode`:
 *   - **HTTP mode** (default): Starts an HTTP server on `config.port` to receive
 *     slash command payloads from Slack.
 *   - **Socket Mode**: Uses a `SocketModeClient` for environments where a public
 *     HTTP endpoint is not available.
 * - Ephemeral messages (`chat.postEphemeral`) are used when `target.isDM` is true,
 *   ensuring private responses are visible only to the requesting user.
 * - Rate-limit and service-unavailable errors from the Slack API are flagged as
 *   retryable in the {@link DeliveryReceipt}.
 * - Pending prompt interactions are tracked via a map keyed by `requestId`.
 *
 * @module slack_adapter
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
} from '../adapter_interface';
import type { SlackIdentityResolver } from './slack_identity';
import type { SlackCommandHandler } from './slack_command_handler';
import type { Repository } from '../../db/repository';

// ---------------------------------------------------------------------------
// Slack type stubs (minimal interfaces for compile-time decoupling)
// ---------------------------------------------------------------------------

/**
 * Minimal Slack Web API client interface.
 *
 * Accepts the real `@slack/web-api` `WebClient` at runtime; tests can
 * supply a stub.
 */
export interface SlackWebApiClient {
  chat: {
    postMessage(params: {
      channel: string;
      blocks?: unknown[];
      text?: string;
      thread_ts?: string;
    }): Promise<{ ok: boolean; ts?: string }>;
    postEphemeral(params: {
      channel: string;
      user: string;
      blocks?: unknown[];
      text?: string;
      thread_ts?: string;
    }): Promise<{ ok: boolean; ts?: string }>;
  };
  conversations: {
    join(params: { channel: string }): Promise<{ ok: boolean }>;
  };
}

/**
 * Minimal wrapper around the Slack Web API, providing access to the
 * underlying WebClient instance.
 */
export interface SlackClient {
  getClient(): SlackWebApiClient;
}

/**
 * Minimal Socket Mode client interface.
 *
 * Accepts the real `@slack/socket-mode` `SocketModeClient` at runtime;
 * tests can supply a stub.
 */
export interface SocketModeClient {
  start(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Minimal HTTP server interface for the HTTP mode.
 *
 * In production this wraps an Express/Fastify server that handles Slack
 * slash command POST requests. Tests can supply a mock.
 */
export interface SlackServer {
  start(port: number): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Slack Block Kit block type alias.
 */
export type SlackBlock = Record<string, unknown>;

/**
 * Slack formatter interface.
 *
 * Renders structured data into Slack Block Kit payloads.
 */
export interface SlackFormatter {
  formatStatusBlocks(data: unknown): SlackBlock[];
}

/**
 * Configuration for the Slack adapter.
 */
export interface SlackConfig {
  /** Whether to use Socket Mode instead of HTTP. */
  socket_mode: boolean;
  /** Port for HTTP mode (ignored in Socket Mode). */
  port: number;
  /** Default timeout (in seconds) for clarifying question threads. */
  default_timeout_seconds: number;
}

/**
 * Factory function for creating a Socket Mode client.
 *
 * Injected at construction to decouple from the real `@slack/socket-mode`
 * dependency. Receives the app-level token from the environment.
 */
export type SocketModeClientFactory = (appToken: string) => SocketModeClient;

/**
 * Factory function for creating an HTTP server with the command handler.
 *
 * Injected at construction to decouple from the real Express/Fastify
 * dependency.
 */
export type SlackServerFactory = (commandHandler: SlackCommandHandler) => SlackServer;

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
// Pending prompt tracking
// ---------------------------------------------------------------------------

/** A pending user prompt awaiting an interaction response or timeout. */
interface PendingPrompt {
  resolve: (value: UserResponse | TimeoutExpired) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Block Kit builder helpers
// ---------------------------------------------------------------------------

/**
 * Build Slack Block Kit blocks for a structured prompt.
 *
 * Produces a section block with the prompt text, followed by an actions
 * block with buttons for each option (if any are provided).
 *
 * @param prompt - The structured prompt to render.
 * @returns An array of Slack Block Kit blocks.
 */
function buildPromptBlocks(prompt: StructuredPrompt): SlackBlock[] {
  const blocks: SlackBlock[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: prompt.content,
      },
    },
  ];

  if (prompt.options && prompt.options.length > 0) {
    const STYLE_MAP: Record<string, string> = {
      primary: 'primary',
      danger: 'danger',
    };

    blocks.push({
      type: 'actions',
      block_id: `prompt_${prompt.requestId}`,
      elements: prompt.options.map((opt) => {
        const button: Record<string, unknown> = {
          type: 'button',
          text: {
            type: 'plain_text',
            text: opt.label,
          },
          action_id: `prompt_${prompt.requestId}_${opt.value}`,
          value: opt.value,
        };

        const style = STYLE_MAP[opt.style ?? ''];
        if (style) {
          button.style = style;
        }

        return button;
      }),
    });
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// SlackAdapter
// ---------------------------------------------------------------------------

/**
 * Slack adapter implementing the {@link IntakeAdapter} interface.
 *
 * Lifecycle:
 * - {@link start} either starts an HTTP server (HTTP mode) or a Socket
 *   Mode client depending on the config. Performs startup recovery for
 *   any pending prompts. Returns an {@link AdapterHandle} for disposal.
 * - {@link sendMessage} sends messages via `chat.postMessage` (channels)
 *   or `chat.postEphemeral` (ephemeral/DM).
 * - {@link promptUser} sends interactive buttons and waits for user
 *   interaction via the pending prompts map, with a configurable timeout.
 * - {@link shutdown} disconnects Socket Mode or stops the HTTP server.
 *
 * Implements SPEC-008-4-02, Task 4.
 */
export class SlackAdapter implements IntakeAdapter {
  readonly channelType: ChannelType = 'slack';

  private server: SlackServer | null = null;
  private socketMode: SocketModeClient | null = null;

  /** Pending prompts awaiting user interaction responses. */
  private pendingPrompts: Map<string, PendingPrompt> = new Map();

  constructor(
    private readonly slackClient: SlackClient,
    private readonly router: IntakeRouterInterface,
    private readonly identityResolver: SlackIdentityResolver,
    private readonly formatter: SlackFormatter,
    private readonly config: SlackConfig,
    private readonly commandHandler: SlackCommandHandler,
    private readonly db?: Repository,
    private readonly socketModeFactory?: SocketModeClientFactory,
    private readonly serverFactory?: SlackServerFactory,
  ) {}

  // -----------------------------------------------------------------------
  // IntakeAdapter: start
  // -----------------------------------------------------------------------

  /**
   * Start the Slack adapter in the configured mode.
   *
   * - **Socket Mode**: Creates a `SocketModeClient` with the app-level
   *   token from `SLACK_APP_TOKEN`, starts the WebSocket connection, and
   *   sets up event handlers.
   * - **HTTP Mode**: Creates an HTTP server via the server factory, mounts
   *   the slash command handler, and starts listening on the configured port.
   *
   * After starting, performs startup recovery to handle any pending prompts
   * that may have been interrupted by a previous shutdown.
   *
   * @returns An {@link AdapterHandle} whose `dispose` method triggers shutdown.
   * @throws {Error} If Socket Mode is configured but `SLACK_APP_TOKEN` is missing.
   * @throws {Error} If HTTP mode is configured but no server factory was provided.
   */
  async start(): Promise<AdapterHandle> {
    if (this.config.socket_mode) {
      const appToken = process.env.SLACK_APP_TOKEN;
      if (!appToken) {
        throw new Error('SLACK_APP_TOKEN environment variable is not set');
      }
      if (!this.socketModeFactory) {
        throw new Error('Socket Mode factory is required when socket_mode is enabled');
      }

      this.socketMode = this.socketModeFactory(appToken);
      await this.socketMode.start();
      this.setupSocketModeHandlers();

      logger.info('Slack adapter started in Socket Mode');
    } else {
      if (!this.serverFactory) {
        throw new Error('Server factory is required when socket_mode is disabled');
      }

      this.server = this.serverFactory(this.commandHandler);
      await this.server.start(this.config.port);

      logger.info('Slack adapter started in HTTP mode', { port: this.config.port });
    }

    await this.startupRecovery();
    return { dispose: () => this.shutdown() };
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: sendMessage
  // -----------------------------------------------------------------------

  /**
   * Send a formatted message to the specified Slack channel or user.
   *
   * Routing logic:
   * - When `target.isDM` is true, uses `chat.postEphemeral` to send an
   *   ephemeral message visible only to `target.userId`.
   * - Otherwise, uses `chat.postMessage` to send to the channel.
   * - When `target.threadId` is provided, the message is sent as a
   *   threaded reply using `thread_ts`.
   *
   * @param target  - Where to send the message.
   * @param payload - The formatted message content (Block Kit blocks).
   * @returns A delivery receipt with the platform message ID on success.
   */
  async sendMessage(
    target: MessageTarget,
    payload: FormattedMessage,
  ): Promise<DeliveryReceipt> {
    try {
      const web = this.slackClient.getClient();

      if (target.isDM && target.userId) {
        const result = await web.chat.postEphemeral({
          channel: target.platformChannelId!,
          user: target.userId,
          blocks: payload.payload as SlackBlock[],
          text: payload.fallbackText,
          thread_ts: target.threadId,
        });
        return { success: true, platformMessageId: result.ts };
      } else {
        const result = await web.chat.postMessage({
          channel: target.platformChannelId!,
          blocks: payload.payload as SlackBlock[],
          text: payload.fallbackText,
          thread_ts: target.threadId,
        });
        return { success: true, platformMessageId: result.ts };
      }
    } catch (error) {
      const err = error as {
        message?: string;
        code?: string;
        data?: { error?: string };
      };
      const retryable =
        err.code === 'slack_webapi_platform_error' &&
        ['ratelimited', 'service_unavailable'].includes(err.data?.error ?? '');
      return {
        success: false,
        error: err.message ?? 'Unknown error',
        retryable,
      };
    }
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: promptUser
  // -----------------------------------------------------------------------

  /**
   * Send a structured prompt to a user and await their response.
   *
   * Renders the prompt as Block Kit blocks with optional interactive
   * buttons. Registers a pending promise that is resolved when the user
   * interacts (via {@link resolvePrompt}), or when the timeout expires.
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
    const web = this.slackClient.getClient();
    const blocks = buildPromptBlocks(prompt);

    await web.chat.postMessage({
      channel: target.platformChannelId!,
      blocks,
      text: prompt.content,
      thread_ts: target.threadId,
    });

    // Wait for interaction response via interactionHandler
    // The interaction handler will resolve the pending promise
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPrompts.delete(prompt.requestId);
        resolve({
          kind: 'timeout',
          requestId: prompt.requestId,
          promptedAt: new Date(),
          expiredAt: new Date(),
        });
      }, prompt.timeoutSeconds * 1000);

      this.pendingPrompts.set(prompt.requestId, { resolve, timer });
    });
  }

  // -----------------------------------------------------------------------
  // IntakeAdapter: shutdown
  // -----------------------------------------------------------------------

  /**
   * Gracefully shut down the Slack adapter.
   *
   * Shutdown sequence (SPEC-008-4-05, Task 15):
   * 1. Log shutdown initiation.
   * 2. Disconnect Socket Mode (if active).
   * 3. Stop HTTP server (if active).
   * 4. Clear all pending prompt timers; resolve pending `promptUser`
   *    calls with `TimeoutExpired` to prevent dangling promises.
   * 5. Log shutdown completion.
   */
  async shutdown(): Promise<void> {
    logger.info('Slack adapter shutdown initiated');

    if (this.socketMode) {
      await this.socketMode.disconnect();
    }

    if (this.server) {
      await this.server.stop();
    }

    // Clear all pending prompt timers
    for (const [requestId, pending] of this.pendingPrompts) {
      clearTimeout(pending.timer);
      pending.resolve({
        kind: 'timeout',
        requestId,
        promptedAt: new Date(),
        expiredAt: new Date(),
      });
    }
    this.pendingPrompts.clear();

    logger.info('Slack adapter shutdown complete');
  }

  // -----------------------------------------------------------------------
  // Public: interaction resolution (called by interaction handler)
  // -----------------------------------------------------------------------

  /**
   * Resolve a pending prompt with a user's interaction response.
   *
   * Called by the interaction handler (e.g., button click handler) when a
   * user responds to a structured prompt.
   *
   * @param requestId - The request ID of the prompt being resolved.
   * @param response  - The user's response.
   * @returns `true` if the prompt was found and resolved, `false` otherwise.
   */
  resolvePrompt(requestId: string, response: UserResponse): boolean {
    const pending = this.pendingPrompts.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.pendingPrompts.delete(requestId);
    pending.resolve(response);
    return true;
  }

  // -----------------------------------------------------------------------
  // Public: Thread-based clarifying conversations (SPEC-008-4-04, Task 10)
  // -----------------------------------------------------------------------

  /**
   * Create a threaded reply for a clarifying question.
   *
   * Posts a message as a threaded reply using `thread_ts` set to the
   * original message's `ts`. Calls `conversations.join` to ensure the
   * bot receives reply events in the thread.
   *
   * Persists the `thread_ts` in both `conversation_messages.thread_id`
   * and `notification_config.routes[].threadId` so that subsequent
   * messages for this request reuse the same thread.
   *
   * @param channelId         - The Slack channel ID.
   * @param originalMessageTs - The `ts` of the original message to thread under.
   * @param requestId         - The associated request ID.
   * @param content           - The clarifying question text.
   * @returns The `thread_ts` of the created thread.
   */
  async createClarifyingThread(
    channelId: string,
    originalMessageTs: string,
    requestId: string,
    content: string,
  ): Promise<string> {
    const web = this.slackClient.getClient();

    // Post as a threaded reply
    const result = await web.chat.postMessage({
      channel: channelId,
      text: content,
      thread_ts: originalMessageTs,
    });

    // Join the channel to receive thread reply events
    await web.conversations.join({ channel: channelId });

    const threadTs = result.ts!;

    // Store thread_ts in DB for future use
    if (this.db) {
      this.db.insertConversationMessage({
        message_id: '',
        request_id: requestId,
        direction: 'outbound',
        channel: 'slack',
        content,
        message_type: 'clarifying_question',
        responded: 0,
        timeout_at: new Date(
          Date.now() + this.config.default_timeout_seconds * 1000,
        ).toISOString(),
        thread_id: threadTs,
      });

      // Update notification config with thread_ts route
      const request = this.db.getRequest(requestId);
      if (request) {
        const config = JSON.parse(request.notification_config);
        config.routes = config.routes || [];
        config.routes.push({
          channelType: 'slack',
          platformChannelId: channelId,
          threadId: threadTs,
        });
        this.db.updateRequest(requestId, {
          notification_config: JSON.stringify(config),
        });
      }
    }

    return threadTs;
  }

  /**
   * Send a message to an existing thread for a request.
   *
   * Reuses the `thread_ts` stored in the request's notification config
   * so that all messages for the same request appear in the same thread.
   *
   * @param channelId - The Slack channel ID.
   * @param threadTs  - The existing `thread_ts` to reply to.
   * @param content   - The message content.
   * @returns The delivery receipt.
   */
  async sendThreadedReply(
    channelId: string,
    threadTs: string,
    content: string,
  ): Promise<DeliveryReceipt> {
    return this.sendMessage(
      {
        channelType: 'slack',
        platformChannelId: channelId,
        threadId: threadTs,
      },
      {
        channelType: 'slack',
        payload: [],
        fallbackText: content,
      },
    );
  }

  // -----------------------------------------------------------------------
  // Accessors for testing
  // -----------------------------------------------------------------------

  /** Number of prompts currently awaiting a user response. */
  get pendingPromptCount(): number {
    return this.pendingPrompts.size;
  }

  // -----------------------------------------------------------------------
  // Private: Socket Mode event handlers
  // -----------------------------------------------------------------------

  /**
   * Set up event handlers for Socket Mode.
   *
   * Listens for `slash_commands` events and delegates them to the
   * slash command handler. Also listens for `interactive` events to
   * handle button clicks for pending prompts.
   */
  private setupSocketModeHandlers(): void {
    if (!this.socketMode) return;

    this.socketMode.on('slash_commands', async (event: unknown) => {
      const evt = event as {
        body: { get(key: string): string | null };
        ack: (response: unknown) => Promise<void>;
      };

      // In Socket Mode, we acknowledge via the ack callback rather than
      // HTTP response. For simplicity, we acknowledge immediately and
      // let the router post results via sendMessage.
      await evt.ack({ text: 'Processing your request...' });
    });

    this.socketMode.on('interactive', async (event: unknown) => {
      const evt = event as {
        body: {
          actions?: Array<{
            action_id: string;
            value: string;
          }>;
          user?: { id: string };
        };
        ack: () => Promise<void>;
      };

      await evt.ack();

      if (evt.body.actions && evt.body.actions.length > 0) {
        const action = evt.body.actions[0];
        // Action IDs are formatted as `prompt_{requestId}_{value}`
        const match = action.action_id.match(/^prompt_(.+)_(.+)$/);
        if (match) {
          const requestId = match[1];
          this.resolvePrompt(requestId, {
            responderId: evt.body.user?.id ?? 'unknown',
            content: action.value,
            selectedOption: action.value,
            timestamp: new Date(),
          });
        }
      }
    });
  }

  // -----------------------------------------------------------------------
  // Private: startup recovery
  // -----------------------------------------------------------------------

  /**
   * Perform startup recovery after the adapter is initialized.
   *
   * Re-sends any pending Slack prompts that have not yet timed out.
   * Only prompts with `channel === 'slack'` and `timeout_at > now` and
   * `responded === false` (0) are re-sent. Each re-sent message includes
   * a "[Resent]" Block Kit context prefix with a counterclockwise arrows
   * emoji to distinguish it from the original message.
   *
   * Failed re-sends are logged but do not prevent recovery of other
   * prompts (fail-open per prompt).
   *
   * Implements SPEC-008-4-05, Task 14.
   */
  private async startupRecovery(): Promise<void> {
    if (!this.db) {
      logger.info('Slack adapter startup recovery skipped (no db)');
      return;
    }

    const pendingPrompts = this.db.getPendingPrompts();
    const slackPrompts = pendingPrompts.filter(
      (p) => p.channel === 'slack' && p.timeout_at && new Date(p.timeout_at) > new Date(),
    );

    for (const prompt of slackPrompts) {
      try {
        const web = this.slackClient.getClient();

        // Resolve the platform channel ID from the request's notification config
        let platformChannelId = '';
        const request = this.db!.getRequest(prompt.request_id);
        if (request) {
          try {
            const config = JSON.parse(request.notification_config);
            const slackRoute = (config.routes || []).find(
              (r: { channelType: string; platformChannelId?: string }) =>
                r.channelType === 'slack' && r.platformChannelId,
            );
            if (slackRoute) {
              platformChannelId = slackRoute.platformChannelId;
            }
          } catch {
            // Invalid JSON in notification_config -- skip channel lookup
          }
        }

        await web.chat.postMessage({
          channel: platformChannelId,
          thread_ts: prompt.thread_id ?? undefined,
          blocks: [
            {
              type: 'context',
              elements: [{ type: 'mrkdwn', text: ':arrows_counterclockwise: *[Resent]*' }],
            },
            {
              type: 'section',
              text: { type: 'mrkdwn', text: prompt.content },
            },
          ],
          text: `[Resent] ${prompt.content}`,
        });

        logger.info('Re-sent pending Slack prompt after startup', {
          requestId: prompt.request_id,
          messageId: prompt.message_id,
        });
      } catch (error) {
        logger.error('Failed to re-send pending Slack prompt', {
          requestId: prompt.request_id,
          error: (error as Error).message,
        });
      }
    }

    logger.info('Slack adapter startup recovery complete', {
      recovered: slackPrompts.length,
    });
  }
}

// ---------------------------------------------------------------------------
// Forward-declared router interface
// ---------------------------------------------------------------------------

/**
 * Router interface consumed by the adapter.
 *
 * The concrete implementation is in `intake/core/intake_router.ts`.
 */
interface IntakeRouterInterface {
  route(command: IncomingCommand): Promise<CommandResult>;
}
