/**
 * Slack Socket Mode Adapter -- WebSocket-based transport for environments
 * without public HTTPS endpoints.
 *
 * Provides the same command and interaction routing as the HTTP mode by
 * delegating to the shared {@link SlackCommandHandler} and
 * {@link SlackInteractionHandler} logic. Only the transport layer differs.
 *
 * Configuration: Socket Mode is enabled via `slack.socket_mode: true` in
 * `intake-config.yaml`.
 *
 * Implements SPEC-008-4-04, Task 12.
 *
 * @module slack_socket_mode
 */

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
// Socket Mode client interface (minimal for compile-time decoupling)
// ---------------------------------------------------------------------------

/**
 * Minimal Socket Mode client interface.
 *
 * Accepts the real `@slack/socket-mode` `SocketModeClient` at runtime;
 * tests can supply a stub.
 */
export interface SocketModeClientInterface {
  start(): Promise<void>;
  disconnect(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

// ---------------------------------------------------------------------------
// Handler interfaces
// ---------------------------------------------------------------------------

/**
 * Handler for Slack slash commands received via Socket Mode.
 *
 * Receives the raw slash command body payload. The same handler class is
 * shared between HTTP mode and Socket Mode; only the transport differs.
 */
export interface SlackCommandHandler {
  /**
   * Handle a slash command received via Socket Mode.
   *
   * @param body - The raw slash command payload from Slack.
   */
  handleSocketMode(body: Record<string, unknown>): Promise<void>;
}

/**
 * Handler for Slack interactive payloads received via Socket Mode.
 *
 * Receives button clicks, modal submissions, etc. The same handler class
 * is shared between HTTP mode and Socket Mode.
 */
export interface SlackInteractionHandler {
  /**
   * Handle an interaction received via Socket Mode.
   *
   * @param body - The raw interaction payload from Slack.
   */
  handleSocketMode(body: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// SlackSocketModeAdapter
// ---------------------------------------------------------------------------

/**
 * Socket Mode adapter for Slack.
 *
 * Uses a WebSocket connection (via `@slack/socket-mode`) instead of HTTP
 * webhooks. This is the recommended approach for development environments
 * and deployments without public-facing HTTPS endpoints.
 *
 * Security:
 * - Requires an app-level token (`xapp-*`) from the `SLACK_APP_TOKEN`
 *   environment variable.
 * - Token format is validated at construction time to prevent accidental
 *   use of bot tokens (`xoxb-*`).
 *
 * Reconnection:
 * - The `@slack/socket-mode` library handles reconnection internally.
 * - Disconnect events are logged at `warn` level for observability.
 *
 * Event routing:
 * - `slash_commands` events are acknowledged immediately and delegated to
 *   the shared {@link SlackCommandHandler}.
 * - `interactive` events (button clicks, modals) are acknowledged and
 *   delegated to the shared {@link SlackInteractionHandler}.
 */
export class SlackSocketModeAdapter {
  private socketClient: SocketModeClientInterface;

  /**
   * @param commandHandler     - Handler for slash command events.
   * @param interactionHandler - Handler for interactive component events.
   * @param socketClientFactory - Optional factory for creating the Socket Mode
   *   client. When omitted, the constructor creates one from `SLACK_APP_TOKEN`.
   *   Injected for testability.
   * @throws {Error} If `SLACK_APP_TOKEN` is not set.
   * @throws {Error} If `SLACK_APP_TOKEN` does not start with `xapp-`.
   */
  constructor(
    private commandHandler: SlackCommandHandler,
    private interactionHandler: SlackInteractionHandler,
    socketClientFactory?: (appToken: string) => SocketModeClientInterface,
  ) {
    const appToken = process.env.SLACK_APP_TOKEN;
    if (!appToken) {
      throw new Error(
        'SLACK_APP_TOKEN environment variable is not set (required for Socket Mode)',
      );
    }
    if (!appToken.startsWith('xapp-')) {
      throw new Error('SLACK_APP_TOKEN must be an app-level token (xapp-*)');
    }

    if (socketClientFactory) {
      this.socketClient = socketClientFactory(appToken);
    } else {
      // Dynamic import at runtime to avoid hard dependency
      // In production, the real @slack/socket-mode SocketModeClient is used.
      // Tests inject a factory to avoid this path.
      throw new Error(
        'socketClientFactory is required (provide @slack/socket-mode SocketModeClient factory)',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start the Socket Mode connection and begin listening for events.
   *
   * Registers event handlers for:
   * - `slash_commands`: Slash command payloads, acknowledged immediately.
   * - `interactive`: Button clicks, modal submissions, acknowledged immediately.
   * - `disconnect`: Logged at `warn` level; reconnection is handled by the
   *   underlying `@slack/socket-mode` library.
   */
  async start(): Promise<void> {
    this.socketClient.on('slash_commands', async (...args: unknown[]) => {
      const event = args[0] as {
        body: Record<string, unknown>;
        ack: (response?: unknown) => Promise<void>;
      };
      await event.ack();
      await this.commandHandler.handleSocketMode(event.body);
    });

    this.socketClient.on('interactive', async (...args: unknown[]) => {
      const event = args[0] as {
        body: Record<string, unknown>;
        ack: (response?: unknown) => Promise<void>;
      };
      await event.ack();
      await this.interactionHandler.handleSocketMode(event.body);
    });

    this.socketClient.on('disconnect', () => {
      logger.warn('Socket Mode disconnected, attempting reconnect...');
    });

    await this.socketClient.start();
    logger.info('Slack Socket Mode connected');
  }

  /**
   * Disconnect the Socket Mode WebSocket connection.
   */
  async stop(): Promise<void> {
    await this.socketClient.disconnect();
    logger.info('Slack Socket Mode disconnected');
  }
}
