/**
 * Discord Service Orchestrator -- DiscordService class wiring DiscordClient,
 * DiscordAdapter, slash command registration, interaction dispatch, lifecycle,
 * rate limiting, and reconnection backoff.
 *
 * This module is the integration layer for the Discord channel.  It does NOT
 * re-implement the discord.js Client wrapper, the IntakeRouter, the slash
 * command builders, or the interaction handler -- those live in their own
 * sibling modules and are wired together here.
 *
 * Lifecycle (see SPEC-011-3-01 / -02 / -03 / -04):
 * 1. {@link DiscordService.start}
 *    - Construct the discord.js Client with `GatewayIntentBits.Guilds` only.
 *    - Register lifecycle event listeners (`ready`, `error`, `shardDisconnect`).
 *    - Wire the `interactionCreate` event to dispatch to the existing
 *      DiscordAdapter (slash commands), button handler, modal handler, or
 *      log unknown interaction types.
 *    - Login with a 30-second ready timeout.
 *    - Register the 10 `/request-*` slash commands (guild or global mode).
 *    - Install signal handlers for SIGTERM/SIGINT.
 * 2. While running, every interaction is rate-limited per guild (30/min) and
 *    dispatched to the appropriate handler.  In-flight handlers are tracked
 *    so {@link DiscordService.stop} can drain them gracefully.
 * 3. {@link DiscordService.stop}
 *    - Set `shutdownRequested` so new interactions are rejected.
 *    - Wait up to `shutdownDrainMs` for in-flight handlers to finish.
 *    - Destroy the Client.
 *
 * Reconnection (FR-814): on `shardDisconnect` with a non-recoverable code,
 * the service drives an exponential backoff loop (1, 2, 4, 8, 16, 32, 60 s
 * cap, max 10 attempts).  Auth/intent failures (4004 / 4014) exit immediately
 * without entering the loop.
 *
 * Token redaction: the bot token must NEVER appear in logs or error messages.
 * All log payloads and error messages are run through {@link redactToken}
 * before they leave this module.
 *
 * @module discord/main
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type Interaction,
  type ChatInputCommandInteraction as DJSChatInput,
  type ButtonInteraction,
  type ModalSubmitInteraction as DJSModalSubmit,
  type RepliableInteraction,
} from 'discord.js';
import type { DiscordAdapter } from './discord_adapter';
import { DISCORD_COMMANDS, registerCommands } from './discord_commands';
import {
  buildAllRequestCommands,
  type RequestCommandJSON,
} from './discord_commands';
import { handleButtonInteraction, handleModalSubmit } from './discord_threads';
import { consumeGuildBudget, evictIdleBuckets } from './discord_rate_limiter';
import { replyEphemeral, replyError } from './discord_replies';

// ---------------------------------------------------------------------------
// Logger (structured JSON to stderr)
// ---------------------------------------------------------------------------

/**
 * Logger interface for DiscordService.
 *
 * All log payloads are run through {@link redactToken} so the bot token never
 * appears in serialized output.
 */
export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

/** Default JSON-to-stderr logger matching codebase conventions. */
const defaultLogger: Logger = {
  info(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({
        level: 'info',
        msg,
        ...redactObject(data),
        ts: new Date().toISOString(),
      }) + '\n',
    );
  },
  warn(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({
        level: 'warn',
        msg,
        ...redactObject(data),
        ts: new Date().toISOString(),
      }) + '\n',
    );
  },
  error(msg: string, data?: Record<string, unknown>): void {
    process.stderr.write(
      JSON.stringify({
        level: 'error',
        msg,
        ...redactObject(data),
        ts: new Date().toISOString(),
      }) + '\n',
    );
  },
};

// ---------------------------------------------------------------------------
// Custom error types
// ---------------------------------------------------------------------------

/**
 * Thrown by the DiscordService constructor when configuration is invalid
 * (disabled, missing env var, malformed token, malformed guild ID).
 *
 * Callers should fail fast on this error and surface the message to the
 * operator.  The error message is guaranteed to NOT contain the raw token.
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

/**
 * Thrown when the service cannot complete startup (login timeout, ready
 * timeout, slash command registration failure).  Caller should treat as
 * fatal and exit.
 */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

// ---------------------------------------------------------------------------
// Token redaction
// ---------------------------------------------------------------------------

/**
 * Replace any string that looks like a Discord bot token (50+ chars of the
 * token alphabet) with `[REDACTED]`.
 *
 * Discord bot tokens are roughly `MTNNNNNNNNNNNNNNNNNNNNNNNN.NNNNNN.NNN...`
 * -- always >50 characters and composed of `[A-Za-z0-9_\-.]`.  This regex is
 * intentionally permissive to catch tokens even in concatenated error
 * messages.
 *
 * @param s - Any string that may contain a token.
 * @returns The string with all token-like substrings replaced.
 */
export function redactToken(s: string): string {
  return s.replace(/[A-Za-z0-9_\-.]{50,}/g, '[REDACTED]');
}

/**
 * Recursively run all string values in a record through {@link redactToken}.
 * Object keys are preserved verbatim.
 */
function redactObject(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!data) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === 'string') {
      out[k] = redactToken(v);
    } else if (v instanceof Error) {
      out[k] = redactToken(v.message);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Strongly-typed configuration for {@link DiscordService}.
 *
 * Defaults are applied in {@link loadConfigFromEnv}; the constructor
 * validates the resulting struct.
 */
export interface DiscordServiceConfig {
  /** Discord bot token from `DISCORD_BOT_TOKEN`.  Must match the token regex. */
  botToken: string;
  /** Discord application snowflake from `DISCORD_APPLICATION_ID`. */
  applicationId: string;
  /** Optional guild ID for guild-scoped command registration. */
  guildId?: string;
  /** Whether the discord channel is enabled (intake.channels.discord.enabled). */
  enabled: boolean;
  /** Login + ready timeout in ms (default 30000). */
  readyTimeoutMs: number;
  /** Graceful shutdown drain budget in ms (default 5000, FR-812). */
  shutdownDrainMs: number;
}

/** Maximum length on a single regex match for the token shape check. */
const TOKEN_REGEX = /^[A-Za-z0-9_\-.]{50,}$/;
/** Snowflake (17-20 digit) regex used for guild ID validation. */
const SNOWFLAKE_REGEX = /^\d{17,20}$/;

/**
 * Load a {@link DiscordServiceConfig} from environment variables, applying
 * defaults for `readyTimeoutMs` and `shutdownDrainMs`.  Does NOT validate
 * the values -- the {@link DiscordService} constructor performs validation.
 */
export function loadConfigFromEnv(): DiscordServiceConfig {
  return {
    botToken: process.env.DISCORD_BOT_TOKEN ?? '',
    applicationId: process.env.DISCORD_APPLICATION_ID ?? '',
    guildId: process.env.DISCORD_GUILD_ID,
    enabled: process.env.DISCORD_ENABLED !== 'false',
    readyTimeoutMs: 30_000,
    shutdownDrainMs: 5_000,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sleep for `ms` milliseconds. Cancellable via AbortSignal. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('aborted'));
    });
  });
}

// ---------------------------------------------------------------------------
// DiscordService
// ---------------------------------------------------------------------------

/**
 * Production-ready Discord channel service.
 *
 * See module-level documentation for the full lifecycle, dispatch pipeline,
 * rate-limit, and reconnection behavior.
 *
 * Construct with a validated {@link DiscordServiceConfig} (use
 * {@link loadConfigFromEnv} to source from env vars), the existing
 * {@link DiscordAdapter}, and an optional {@link Logger}.  Call
 * {@link DiscordService.start} once; {@link DiscordService.stop} is
 * idempotent.
 */
export class DiscordService {
  /** True after `stop()` is called; rejects new interactions. */
  private shutdownRequested = false;
  /** Promise tracking in-flight interaction handlers (FR-812). */
  private inflight: Set<Promise<void>> = new Set();
  /** discord.js Client instance; set in `start()`. */
  private client: Client | null = null;
  /** Resolved by the `ready` event listener installed in `start()`. */
  private readyResolver: (() => void) | null = null;
  /** Rejected by the `ready` event listener if the bot fails to ready up. */
  private readyRejector: ((err: Error) => void) | null = null;
  /** Installed signal handlers, kept for cleanup in tests. */
  private signalHandlers: Array<{ sig: NodeJS.Signals; fn: () => void }> = [];

  constructor(
    private readonly config: DiscordServiceConfig,
    private readonly adapter: DiscordAdapter,
    private readonly logger: Logger = defaultLogger,
  ) {
    this.validateConfig(config);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Start the Discord service.
   *
   * Sequence:
   * 1. Construct the discord.js Client (Guilds intent only).
   * 2. Register lifecycle event listeners (`ready`, `error`, `shardDisconnect`,
   *    `shardReconnecting`).
   * 3. Register the `interactionCreate` listener to dispatch to slash command,
   *    button, modal, or unknown handlers (with rate limiting).
   * 4. Login with a 30-second ready timeout.
   * 5. Register the 10 `/request-*` slash commands.
   * 6. Install SIGTERM/SIGINT handlers.
   *
   * @throws {StartupError} on login timeout, ready timeout, or registration
   *   failure.  The Client is destroyed before the error propagates.
   */
  async start(): Promise<void> {
    this.logger.info('discord_service_starting', {
      applicationId: this.config.applicationId,
      guildId: this.config.guildId ?? null,
    });

    this.client = new Client({
      intents: [GatewayIntentBits.Guilds],
    });

    this.installLifecycleListeners(this.client);
    this.installInteractionListener(this.client);

    try {
      await this.loginWithTimeout(this.client);
      this.logger.info('discord_client_logged_in', {
        applicationId: this.config.applicationId,
        guildId: this.config.guildId ?? null,
      });

      await this.waitForReady(this.config.readyTimeoutMs);
      this.logger.info('discord_client_ready', {
        shardCount: this.client.shard?.count ?? 1,
        gatewayLatency: this.client.ws?.ping ?? null,
      });

      await this.registerSlashCommands();
    } catch (err) {
      // Best-effort cleanup before rethrow.  Never propagate the token.
      try {
        await this.client?.destroy();
      } catch {
        // ignore destroy failures during error path
      }
      this.client = null;
      if (err instanceof StartupError || err instanceof ConfigurationError) {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new StartupError(redactToken(`Discord startup failed: ${msg}`));
    }

    this.installSignalHandlers();
  }

  /**
   * Gracefully stop the service (FR-812).
   *
   * 1. Set `shutdownRequested = true` so the interaction listener rejects
   *    new events.
   * 2. Wait up to `shutdownDrainMs` for in-flight handlers to complete.
   * 3. Destroy the Client.
   *
   * Idempotent.  Safe to call before `start()`.
   */
  async stop(): Promise<void> {
    if (this.shutdownRequested && !this.client) {
      return; // already stopped
    }
    this.shutdownRequested = true;
    this.logger.info('discord_service_stopping', {
      drainMs: this.config.shutdownDrainMs,
      inflight: this.inflight.size,
    });

    if (this.inflight.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.inflight]),
        sleep(this.config.shutdownDrainMs),
      ]);
    }

    const inflightAtTimeout = this.inflight.size;

    try {
      if (this.client) {
        await this.client.destroy();
      }
    } catch (err) {
      this.logger.warn('discord_client_destroy_failed', {
        err: redactToken(String(err)),
      });
    } finally {
      this.client = null;
    }

    this.logger.info('discord_service_stopped', { inflightAtTimeout });
  }

  // -----------------------------------------------------------------------
  // Test accessors
  // -----------------------------------------------------------------------

  /**
   * Whether `stop()` has been requested.  Test-only accessor.
   * @internal
   */
  get isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /**
   * Number of in-flight interaction handlers.  Test-only accessor.
   * @internal
   */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /**
   * Underlying discord.js Client (or null before start()).  Test-only.
   * @internal
   */
  getClient(): Client | null {
    return this.client;
  }

  // -----------------------------------------------------------------------
  // Configuration validation (SPEC-011-3-01 acceptance criteria)
  // -----------------------------------------------------------------------

  /**
   * Validate a {@link DiscordServiceConfig} per the SPEC-011-3-01 table.
   * Throws {@link ConfigurationError} with the documented exact messages on
   * failure.  Token values are NEVER included in the error message.
   */
  private validateConfig(config: DiscordServiceConfig): void {
    if (config.enabled === false) {
      throw new ConfigurationError(
        'Discord channel is disabled in intake.channels.discord.enabled',
      );
    }
    if (!config.botToken) {
      throw new ConfigurationError('DISCORD_BOT_TOKEN env var is required');
    }
    if (!config.applicationId) {
      throw new ConfigurationError(
        'DISCORD_APPLICATION_ID env var is required',
      );
    }
    if (!TOKEN_REGEX.test(config.botToken)) {
      throw new ConfigurationError(
        'DISCORD_BOT_TOKEN format invalid (token redacted)',
      );
    }
    if (config.guildId !== undefined && !SNOWFLAKE_REGEX.test(config.guildId)) {
      throw new ConfigurationError(
        'DISCORD_GUILD_ID must be a numeric snowflake (17-20 digits)',
      );
    }
  }

  // -----------------------------------------------------------------------
  // Listener installation
  // -----------------------------------------------------------------------

  /** Install `ready`, `error`, `shardDisconnect`, `shardReconnecting` listeners. */
  private installLifecycleListeners(client: Client): void {
    client.once(Events.ClientReady, () => {
      if (this.readyResolver) {
        this.readyResolver();
        this.readyResolver = null;
        this.readyRejector = null;
      }
    });
    client.on(Events.Error, (err: Error) => {
      this.logger.error('discord_client_error', {
        err: redactToken(err.message),
      });
    });
    // Reconnection logic (full implementation lives in `reconnect()`).
    client.on(Events.ShardDisconnect, (event: { code: number; reason?: string }) => {
      this.logger.warn('discord_shard_disconnect', {
        code: event.code,
        reason: event.reason ?? null,
      });
      this.handleShardDisconnect(event.code).catch((err) => {
        this.logger.error('discord_reconnect_loop_failed', {
          err: redactToken(String(err)),
        });
      });
    });
    client.on(Events.ShardReconnecting, () => {
      this.logger.info('discord_shard_reconnecting');
    });
  }

  /**
   * Install the `interactionCreate` listener that:
   * 1. Rejects new interactions during shutdown.
   * 2. Applies per-guild rate limiting.
   * 3. Dispatches by interaction type (slash, button, modal, other).
   * 4. Tracks in-flight handlers for graceful shutdown.
   */
  private installInteractionListener(client: Client): void {
    client.on(Events.InteractionCreate, (interaction: Interaction) => {
      // Wrap the entire dispatch in a tracked promise so `stop()` can drain.
      const p = (async () => {
        if (this.shutdownRequested) {
          await this.tryReplyShuttingDown(interaction);
          return;
        }

        // Per-guild rate limiting (SPEC-011-3-04).  DMs share a single
        // global bucket via guildId === null.
        const decision = consumeGuildBudget(interaction.guildId);
        if (!decision.allowed) {
          this.logger.warn('discord_rate_limit_blocked', {
            guildId: interaction.guildId ?? null,
            userId: interaction.user?.id,
            retryAfterMs: decision.retryAfterMs ?? null,
          });
          if (this.isRepliable(interaction)) {
            const seconds = Math.ceil((decision.retryAfterMs ?? 1000) / 1000);
            await replyEphemeral(
              interaction as unknown as RepliableInteraction,
              `Rate limit reached for this server. Try again in ${seconds}s.`,
            );
          }
          return;
        }

        try {
          if (interaction.isChatInputCommand?.()) {
            await this.adapter.handleInteraction(
              interaction as unknown as Parameters<
                DiscordAdapter['handleInteraction']
              >[0],
            );
          } else if (interaction.isButton?.()) {
            await handleButtonInteraction(
              interaction as ButtonInteraction,
              this.adapter,
              this.logger,
            );
          } else if (interaction.isModalSubmit?.()) {
            await handleModalSubmit(
              interaction as DJSModalSubmit,
              this.adapter,
              this.logger,
            );
          } else {
            this.logger.warn('discord_unhandled_interaction_type', {
              type: (interaction as { type?: number }).type,
              id: interaction.id,
            });
          }
        } catch (err) {
          this.logger.error('interaction_handler_failed', {
            interactionId: interaction.id,
            interactionType: (interaction as { type?: number }).type,
            err: redactToken(err instanceof Error ? err.message : String(err)),
          });
          if (this.isRepliable(interaction)) {
            try {
              await replyError(
                interaction as unknown as RepliableInteraction,
                err,
              );
            } catch {
              // Last-resort: don't crash on reply failure.
            }
          }
        }
      })();

      this.inflight.add(p);
      p.finally(() => this.inflight.delete(p)).catch(() => {
        /* tracked errors already logged above */
      });
    });
  }

  // -----------------------------------------------------------------------
  // Login + ready (SPEC-011-3-01 Task 3)
  // -----------------------------------------------------------------------

  /**
   * Login with a timeout that destroys the client and rejects with a
   * {@link StartupError} on expiration.
   */
  private async loginWithTimeout(client: Client): Promise<void> {
    const timeoutMs = this.config.readyTimeoutMs;
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StartupError('discord_login_timeout')),
        timeoutMs,
      );
    });
    try {
      await Promise.race([
        client.login(this.config.botToken),
        timeoutPromise,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Wait for the `ready` event (resolved by the lifecycle listener).
   * Rejects with {@link StartupError} on timeout.
   */
  private waitForReady(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejector = reject;
      const timer = setTimeout(() => {
        this.readyResolver = null;
        this.readyRejector = null;
        reject(new StartupError('Discord ready timeout exceeded (>30s)'));
      }, timeoutMs);
      // If resolve fires first, clear the timer.
      const origResolve = resolve;
      this.readyResolver = () => {
        clearTimeout(timer);
        origResolve();
      };
    });
  }

  // -----------------------------------------------------------------------
  // Slash command registration (SPEC-011-3-02 Task 4)
  // -----------------------------------------------------------------------

  /**
   * Register all 10 `/request-*` slash commands.
   *
   * Mode selection:
   * - `guildId` set => guild-scoped (instant propagation), PUT to
   *   `applicationGuildCommands(applicationId, guildId)`.
   * - `guildId` undefined => global (1-hour propagation), PUT to
   *   `applicationCommands(applicationId)`.
   *
   * On Discord REST error, surface an actionable message per the SPEC-011-3-02
   * error code mapping table.
   */
  private async registerSlashCommands(): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.config.botToken);
    const builders = buildAllRequestCommands();
    const body = builders.map((c) => c.toJSON());

    try {
      if (this.config.guildId) {
        await rest.put(
          Routes.applicationGuildCommands(
            this.config.applicationId,
            this.config.guildId,
          ),
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
          propagationNote:
            'Global commands take up to 1 hour to propagate.',
        });
      }
    } catch (err) {
      throw new StartupError(this.formatRegistrationError(err));
    }
  }

  /**
   * Map a discord.js REST error into an actionable startup error message
   * per SPEC-011-3-02's error code table.  Token values are redacted.
   */
  private formatRegistrationError(err: unknown): string {
    const e = err as { code?: number; status?: number; message?: string };
    const code = e?.code ?? e?.status;
    const guildId = this.config.guildId ?? '<global>';
    switch (code) {
      case 50001:
        return `Bot lacks access to guild ${guildId}. Re-invite the bot with applications.commands scope.`;
      case 50013:
        return `Bot is missing permissions in guild ${guildId}.`;
      case 30032:
        return `Guild ${guildId} has hit the slash command limit (100). Remove unused commands.`;
      case 40060:
        return `Slash command registration failed: already acknowledged (40060). ${redactToken(e?.message ?? '')}`;
      default:
        return `Slash command registration failed: ${redactToken(e?.message ?? String(err))}`;
    }
  }

  // -----------------------------------------------------------------------
  // Reconnection (SPEC-011-3-04 Task 6)
  // -----------------------------------------------------------------------

  /**
   * Handle a `shardDisconnect` event.  Non-recoverable codes (4004, 4014)
   * exit the process immediately with code 3.  Other codes drive the
   * exponential backoff loop (FR-814).
   */
  private async handleShardDisconnect(code: number): Promise<void> {
    if (this.shutdownRequested) return;
    if (code === 4004 || code === 4014) {
      this.logger.error('discord_unrecoverable_close', { code });
      // Auth/intent failures are config errors -- exit immediately so
      // systemd's `Restart=on-failure` does NOT loop.
      process.exit(3);
    }
    await this.reconnect();
  }

  /**
   * Drive the bounded reconnect loop (max 10 attempts, 1s..60s exponential
   * backoff with cap).  Exits process with code 2 after exhaustion.
   *
   * Cancellable: a mid-loop `shutdownRequested = true` short-circuits.
   *
   * @internal Exposed for testing.
   */
  async reconnect(): Promise<void> {
    if (this.shutdownRequested) return;
    for (let attempt = 1; attempt <= 10; attempt++) {
      if (this.shutdownRequested) return;
      const delayMs = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
      this.logger.warn('discord_reconnect_attempt', { attempt, delayMs });
      try {
        await sleep(delayMs);
      } catch {
        // sleep aborted (shutdown) -- exit loop cleanly.
        return;
      }
      if (this.shutdownRequested) return;
      try {
        if (!this.client) {
          this.client = new Client({ intents: [GatewayIntentBits.Guilds] });
          this.installLifecycleListeners(this.client);
          this.installInteractionListener(this.client);
        }
        await this.client.login(this.config.botToken);
        await this.waitForReady(this.config.readyTimeoutMs);
        this.logger.info('discord_reconnect_success', { attempt });
        return;
      } catch (err) {
        this.logger.warn('discord_reconnect_failed', {
          attempt,
          err: redactToken(err instanceof Error ? err.message : String(err)),
        });
      }
    }
    this.logger.error('discord_reconnect_exhausted', { attempts: 10 });
    process.exit(2);
  }

  // -----------------------------------------------------------------------
  // Signal handlers (SPEC-011-3-04 Task 5)
  // -----------------------------------------------------------------------

  /**
   * Install SIGTERM/SIGINT handlers that call `stop()` and exit with the
   * appropriate code (0 clean / 1 error / 124 drain timeout).
   */
  private installSignalHandlers(): void {
    const onSignal = (sig: NodeJS.Signals) => {
      this.logger.info('discord_service_signal', { signal: sig });
      const inflightSnapshot = this.inflight.size;
      this.stop()
        .then(() => {
          // Per FR-812: exit 124 if drain timed out with stuck handlers.
          // We approximate by checking whether inflight existed at start
          // and remained at stop completion.
          if (inflightSnapshot > 0 && this.inflight.size > 0) {
            process.exit(124);
          }
          process.exit(0);
        })
        .catch(() => process.exit(1));
    };
    const sigterm: NodeJS.Signals = 'SIGTERM';
    const sigint: NodeJS.Signals = 'SIGINT';
    const tHandler = () => onSignal(sigterm);
    const iHandler = () => onSignal(sigint);
    process.on(sigterm, tHandler);
    process.on(sigint, iHandler);
    this.signalHandlers.push(
      { sig: sigterm, fn: tHandler },
      { sig: sigint, fn: iHandler },
    );
  }

  // -----------------------------------------------------------------------
  // Misc helpers
  // -----------------------------------------------------------------------

  /** Type-guard for the discord.js `isRepliable()` check. */
  private isRepliable(i: Interaction): i is RepliableInteraction {
    return typeof (i as { isRepliable?: () => boolean }).isRepliable === 'function'
      && (i as { isRepliable: () => boolean }).isRepliable();
  }

  /**
   * Reply ephemerally with the documented "shutting down" message.
   * Best-effort: errors are suppressed (the interaction may be expired).
   */
  private async tryReplyShuttingDown(interaction: Interaction): Promise<void> {
    if (!this.isRepliable(interaction)) return;
    try {
      await replyEphemeral(
        interaction as unknown as RepliableInteraction,
        'System is shutting down.',
      );
    } catch {
      // Interaction may already be expired -- nothing to do.
    }
  }
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export { DISCORD_COMMANDS, registerCommands, buildAllRequestCommands };
export type { RequestCommandJSON };

// Re-export rate-limiter helpers so external orchestrators can drive the
// idle-bucket eviction sweep on a timer.
export { evictIdleBuckets };
