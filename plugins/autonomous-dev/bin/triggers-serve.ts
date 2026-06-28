#!/usr/bin/env bun
/**
 * ONBOARD Phase 4 (#596 follow-up) — triggers SERVE entrypoint (bun-run,
 * OUTSIDE tsconfig). Best-effort host-process glue that starts the Discord
 * and/or Slack INBOUND listeners so a `/autodev` chat command reaches the
 * already-built, already-registered TriggerHandler.
 *
 * This is the live-bot counterpart to `triggers-cli.ts watch-tick` (which only
 * polls for completions). Everything load-bearing — the inbound mapping
 * (`trigger_command_map` + the Discord/Slack `/autodev` branches), the
 * `TriggerHandler` (auto-registered by `IntakeRouter.registerHandlers`), and
 * the platform services — is already built and unit-tested. This file ONLY
 * constructs the concrete service graphs and `.start()`s them.
 *
 * Wiring (see docs/ONBOARD-phase4-deploy.md):
 *  - Router: `initRouter()` (cli_adapter.ts) — wires Repository, AuthzEngine,
 *    RateLimiter, injection rules, AND auto-registers the TriggerHandler. We do
 *    NOT rebuild it. It returns an `IntakeRouterLike` ({ route() }) which every
 *    platform service / handler accepts structurally.
 *  - Platform gating: Discord starts only if `DISCORD_BOT_TOKEN` is set; Slack
 *    only if `SLACK_BOT_TOKEN` is set. Neither set → print + exit 0, no network.
 *  - Best-effort: one platform's construction/start throwing is logged and does
 *    NOT kill the other. SIGTERM/SIGINT drain both and exit.
 *
 * Identity/authz note: `initRouter()` intentionally encapsulates (does not
 * expose) the Repository + AuthzEngine. The Discord/Slack identity resolvers
 * and component/interaction handlers need those for user-provisioning and
 * destructive-action authz checks. We therefore open a SECOND, read-only
 * Repository + AuthzEngine against the SAME default paths the router uses
 * (`~/.autonomous-dev/intake.db` + `~/.autonomous-dev/intake-auth.yaml`). This
 * is lookup infrastructure only — it does NOT duplicate any routing logic.
 *
 * No secrets are ever logged (tokens are read from env and handed straight to
 * the concrete clients; the structured logger here only emits event names).
 */

import * as os from 'os';
import * as path from 'path';

// Router (also re-exports the IntakeRouterLike contract every service accepts).
import { initRouter, type IntakeRouterLike } from '../intake/adapters/cli_adapter';

// ---------------------------------------------------------------------------
// Structured logger (JSON to stderr; matches the bin/* + service conventions).
// Never receives a token — only event names + non-secret context.
// ---------------------------------------------------------------------------

interface ServeLogger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

const logger: ServeLogger = {
  info(msg, data) {
    process.stderr.write(
      JSON.stringify({ level: 'info', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
  warn(msg, data) {
    process.stderr.write(
      JSON.stringify({ level: 'warn', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
  error(msg, data) {
    process.stderr.write(
      JSON.stringify({ level: 'error', msg, ...data, ts: new Date().toISOString() }) + '\n',
    );
  },
};

// ---------------------------------------------------------------------------
// Default paths — MUST mirror cli_adapter.ts's initRouter() so the read-only
// identity/authz deps point at the same DB + auth file the router opened.
// ---------------------------------------------------------------------------

/** `~/.autonomous-dev/intake.db` — same as cli_adapter.defaultDbPath(). */
function defaultDbPath(): string {
  return path.join(process.env.HOME ?? os.homedir(), '.autonomous-dev', 'intake.db');
}

/** `~/.autonomous-dev/intake-auth.yaml` — same as cli_adapter.defaultAuthConfigPath(). */
function defaultAuthConfigPath(): string {
  return path.join(process.env.HOME ?? os.homedir(), '.autonomous-dev', 'intake-auth.yaml');
}

/**
 * Shared identity/authz dependencies the platform handlers need but the router
 * does not expose. Read-only: a Repository (user_identities lookups) and an
 * AuthzEngine (destructive-action authz on button/modal interactions).
 */
interface SharedAuthDeps {
  repo: import('../intake/db/repository').Repository;
  authz: import('../intake/authz/authz_engine').AuthzEngine;
}

/**
 * Open a second, read-only Repository + AuthzEngine against the same default
 * paths initRouter() uses. Dynamic imports keep these heavy modules off the
 * no-token fast path (so the "no platforms enabled" exit touches no sqlite).
 *
 * @throws Propagates DB/migration/auth-load failures to the per-platform
 *   try/catch in main() so one platform's failure stays isolated.
 */
async function buildSharedAuthDeps(): Promise<SharedAuthDeps> {
  const { Repository } = await import('../intake/db/repository');
  const { initializeDatabase } = await import('../intake/db/migrator');
  const { AuthzEngine } = await import('../intake/authz/authz_engine');
  const { AuditLogger } = await import('../intake/authz/audit_logger');

  const dbPath = defaultDbPath();
  const migrationsDir = path.resolve(__dirname, '..', 'intake', 'db', 'migrations');
  const { db } = initializeDatabase(dbPath, migrationsDir);
  const repo = new Repository(db);

  // Silent audit logger — authz audit lines are the AuthzEngine's concern; the
  // inbound listener should not double-emit them to the daemon log.
  const auditLogger = new AuditLogger(AuditLogger.fromDatabase(db), {
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const authz = new AuthzEngine(defaultAuthConfigPath(), auditLogger);

  return { repo, authz };
}

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

/**
 * Construct the real Discord service graph and start it.
 *
 * `DiscordService` (discord/main.ts) owns its own discord.js Client, logs in
 * with `config.botToken`, installs the `interactionCreate` listener, registers
 * the slash commands, and dispatches each interaction to
 * `adapter.handleInteraction()`. It NEVER calls `adapter.start()` — so the
 * DiscordClient we hand the adapter is only there to satisfy construction (its
 * `connect()`/guild are never used on this path), and the identity resolver's
 * `guild` is likewise never live (its `resolve()` does not touch the guild;
 * only `resolveDisplayName()` does, and that has a documented fallback).
 *
 * @returns A `{ stop }` handle for graceful shutdown, or null if disabled.
 */
async function startDiscord(
  router: IntakeRouterLike,
  shared: SharedAuthDeps,
): Promise<{ stop: () => Promise<void> } | null> {
  if (!process.env.DISCORD_BOT_TOKEN) return null;

  const { loadConfigFromEnv, DiscordService } = await import('../intake/adapters/discord/main');
  const { DiscordAdapter } = await import('../intake/adapters/discord/discord_adapter');
  const { DiscordClient } = await import('../intake/adapters/discord/discord_client');
  const { DiscordIdentityResolver } = await import('../intake/adapters/discord/discord_identity');
  const { ComponentInteractionHandler } = await import(
    '../intake/adapters/discord/discord_interaction_handler'
  );
  const { DiscordFormatter } = await import('../intake/notifications/formatters/discord_formatter');

  const config = loadConfigFromEnv();

  // The DiscordClient passed to the adapter is constructed but never connected
  // by DiscordService (which owns its own Client). It exists only to satisfy
  // the adapter constructor; the adapter is used purely as the interaction
  // handler on the `/autodev` path.
  const client = new DiscordClient();

  // The identity resolver's guild is never live in this topology (DiscordService
  // owns the gateway, not the adapter). resolve() — the only method on the
  // /autodev path — does not touch the guild; resolveDisplayName() does, and a
  // failed members.fetch() yields the documented `Discord User <id>` fallback.
  const guildStub = {
    members: {
      fetch: async (): Promise<{ displayName: string }> => {
        throw new Error('discord guild not available in inbound-listener topology');
      },
    },
  };
  const identityResolver = new DiscordIdentityResolver(shared.authz, guildStub);
  const formatter = new DiscordFormatter();
  // Every handler's local `IntakeRouter` interface is structurally `{ route() }`
  // — identical to IntakeRouterLike — so the router passes directly, no cast.
  const componentHandler = new ComponentInteractionHandler(
    router,
    identityResolver,
    shared.authz,
  );

  const adapter = new DiscordAdapter(
    client,
    router,
    identityResolver,
    formatter,
    componentHandler,
  );

  const service = new DiscordService(config, adapter, logger);
  await service.start();
  logger.info('triggers-serve: discord listener started');
  return { stop: () => service.stop() };
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

/**
 * Construct the real Slack service graph and start it via `startSlackService`.
 *
 * Socket Mode when `SLACK_APP_TOKEN` is set (no public HTTPS endpoint needed),
 * else HTTP mode. `startSlackService` validates config + env, builds the
 * verifier/rate-limiter defaults, registers SIGTERM/SIGINT handlers, and
 * starts the receiver. We supply the concrete adapter + handlers it requires.
 *
 * @returns A `{ stop }` handle for graceful shutdown, or null if disabled.
 */
async function startSlack(
  router: IntakeRouterLike,
  shared: SharedAuthDeps,
): Promise<{ stop: () => Promise<void> } | null> {
  if (!process.env.SLACK_BOT_TOKEN) return null;

  const { startSlackService } = await import('../intake/adapters/slack/main');
  const { SlackAdapter } = await import('../intake/adapters/slack/slack_adapter');
  const { SlackClient } = await import('../intake/adapters/slack/slack_client');
  const { SlackIdentityResolver } = await import('../intake/adapters/slack/slack_identity');
  const { SlackCommandHandler } = await import('../intake/adapters/slack/slack_command_handler');
  const { SlackInteractionHandler } = await import('../intake/adapters/slack/slack_interaction_handler');
  const { SlackFormatter } = await import('../intake/notifications/formatters/slack_formatter');

  const socketMode = Boolean(process.env.SLACK_APP_TOKEN);

  // SlackClient reads SLACK_BOT_TOKEN itself and exposes the real @slack/web-api
  // WebClient, which structurally satisfies the SlackWebClient stubs used by the
  // identity resolver (users.info) and interaction handler (chat/views).
  const slackClient = new SlackClient();
  const web = slackClient.getClient();

  const identityResolver = new SlackIdentityResolver(shared.authz, web);
  const formatter = new SlackFormatter();

  // Router structurally satisfies each handler's local `{ route() }` interface,
  // so it passes directly (same contract as IntakeRouterLike), no cast.
  const commandHandler = new SlackCommandHandler(router, identityResolver, formatter);
  const interactionHandler = new SlackInteractionHandler(
    router,
    identityResolver,
    shared.authz,
    web,
  );

  // The SlackAdapter wraps the same client/handlers; startSlackService drives it
  // and exposes drain() for graceful shutdown. HTTP mode uses the service's own
  // Express receiver, so no SlackServer factory is required here.
  const adapterConfig = {
    socket_mode: socketMode,
    port: Number(process.env.SLACK_PORT ?? '3000'),
    default_timeout_seconds: 300,
  };

  let socketModeFactory:
    | ((appToken: string) => import('../intake/adapters/slack/slack_adapter').SocketModeClient)
    | undefined;
  let serviceSocketClient:
    | import('../intake/adapters/slack/main').SocketModeClient
    | undefined;
  if (socketMode) {
    const { SocketModeClient } = await import('@slack/socket-mode');
    const made = new SocketModeClient({ appToken: process.env.SLACK_APP_TOKEN as string });
    socketModeFactory = () =>
      made as unknown as import('../intake/adapters/slack/slack_adapter').SocketModeClient;
    serviceSocketClient = made as unknown as import('../intake/adapters/slack/main').SocketModeClient;
  }

  const adapter = new SlackAdapter(
    slackClient,
    router, // structurally `{ route() }`; same contract the adapter declares
    identityResolver,
    formatter,
    adapterConfig,
    commandHandler,
    shared.repo,
    socketModeFactory,
  );

  // Let startSlackService install its OWN SIGTERM/SIGINT handlers (they call
  // service.shutdown()); we still return a stop() so our top-level handler can
  // drive shutdown deterministically too (shutdown() is idempotent).
  const service = await startSlackService({
    router,
    adapter,
    commandHandler,
    interactionHandler,
    config: {
      socket_mode: socketMode,
      port: adapterConfig.port,
    },
    socketModeClient: serviceSocketClient,
    logger,
  });
  logger.info('triggers-serve: slack listener started', { mode: socketMode ? 'socket' : 'http' });
  return { stop: () => service.shutdown() };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Best-effort serve loop. Starts whichever platforms have a bot token; if a
 * platform's construction/start throws it is logged and the other continues.
 * With neither token set, prints the documented line and exits 0 with no
 * network attempted.
 */
async function main(): Promise<number> {
  const discordEnabled = Boolean(process.env.DISCORD_BOT_TOKEN);
  const slackEnabled = Boolean(process.env.SLACK_BOT_TOKEN);

  if (!discordEnabled && !slackEnabled) {
    process.stdout.write(
      'triggers-serve: no platforms enabled (set DISCORD_BOT_TOKEN and/or SLACK_BOT_TOKEN)\n',
    );
    return 0;
  }

  // Router first (auto-registers the TriggerHandler), then the read-only
  // identity/authz deps the platform handlers need.
  const router = await initRouter();
  const shared = await buildSharedAuthDeps();

  const stops: Array<{ name: string; stop: () => Promise<void> }> = [];

  if (discordEnabled) {
    try {
      const handle = await startDiscord(router, shared);
      if (handle) stops.push({ name: 'discord', stop: handle.stop });
    } catch (err) {
      logger.error('triggers-serve: discord start failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (slackEnabled) {
    try {
      const handle = await startSlack(router, shared);
      if (handle) stops.push({ name: 'slack', stop: handle.stop });
    } catch (err) {
      logger.error('triggers-serve: slack start failed (continuing)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (stops.length === 0) {
    // Both tokens were present but every platform failed to start. Surface a
    // non-zero exit so the operator/daemon notices, but do not crash-loop hard.
    logger.error('triggers-serve: all enabled platforms failed to start');
    return 1;
  }

  // Graceful shutdown: drain every started service, then exit. Idempotent with
  // the services' own signal handlers (Slack installs its own; Discord installs
  // its own inside start()).
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('triggers-serve: shutting down', { signal, services: stops.map((s) => s.name) });
    Promise.allSettled(stops.map((s) => s.stop()))
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info('triggers-serve: running', { services: stops.map((s) => s.name) });

  // Keep the process alive while the services run. This promise never resolves,
  // so main() never returns and the top-level `.then(process.exit)` never fires;
  // the process stays up until a signal handler calls process.exit(). The
  // started services also hold the event loop open (gateway socket / HTTP
  // listener), so this is purely the explicit, never-settling keep-alive.
  await new Promise<never>(() => {
    /* intentionally never resolves; SIGTERM/SIGINT drive the exit */
  });
  // Unreachable (the promise never resolves); satisfies the return type.
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
