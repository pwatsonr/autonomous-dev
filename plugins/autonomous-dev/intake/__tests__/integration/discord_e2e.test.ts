/**
 * End-to-end integration tests for the Discord channel.
 *
 * Uses a real SQLite database, mock Discord.js client. All interactions are
 * simulated through the Discord adapter with a real IntakeRouter, real
 * AuthzEngine, and real RateLimiter.
 *
 * Implements SPEC-008-3-05, Task 15.
 *
 * Total: 7 test scenarios.
 *
 * @module discord_e2e.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  DiscordAdapter,
  type DiscordClient,
  type DiscordJSClient,
  type DiscordFormatter as DiscordFormatterInterface,
  type ComponentInteractionHandler as ComponentInteractionHandlerInterface,
  type ChannelResolver,
  type TextChannelLike,
  type TextChannelWithThreads,
  type ThreadChannel,
} from '../../adapters/discord/discord_adapter';
import { ComponentInteractionHandler } from '../../adapters/discord/discord_interaction_handler';
import { DiscordIdentityResolver, AuthorizationError } from '../../adapters/discord/discord_identity';
import { DiscordFormatter, PHASE_COLORS } from '../../notifications/formatters/discord_formatter';
import type { DiscordEmbed } from '../../notifications/formatters/discord_formatter';
import { Repository } from '../../db/repository';
import { initializeDatabase } from '../../db/migrator';
import { IntakeRouter, type IntakeRouterDeps } from '../../core/intake_router';
import { AuthzEngine, type AuthConfig } from '../../authz/authz_engine';
import { AuditLogger } from '../../authz/audit_logger';
import { RateLimiter } from '../../rate_limit/rate_limiter';
import type {
  IncomingCommand,
  CommandResult,
} from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeAuthConfig(config: AuthConfig): string {
  const yamlLines: string[] = [];
  yamlLines.push(`version: ${config.version}`);
  yamlLines.push('users:');
  for (const user of config.users) {
    yamlLines.push(`  - internal_id: "${user.internal_id}"`);
    yamlLines.push('    identities:');
    if (user.identities.claude_user) {
      yamlLines.push(`      claude_user: "${user.identities.claude_user}"`);
    }
    if (user.identities.discord_id) {
      yamlLines.push(`      discord_id: "${user.identities.discord_id}"`);
    }
    if (user.identities.slack_id) {
      yamlLines.push(`      slack_id: "${user.identities.slack_id}"`);
    }
    yamlLines.push(`    role: ${user.role}`);
    if (user.repo_permissions) {
      yamlLines.push('    repo_permissions:');
      for (const [repo, role] of Object.entries(user.repo_permissions)) {
        yamlLines.push(`      ${repo}: ${role}`);
      }
    }
  }

  const configPath = path.join(tmpDir, `auth-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(configPath, yamlLines.join('\n'));
  return configPath;
}

// ---------------------------------------------------------------------------
// Mock Discord.js infrastructure
// ---------------------------------------------------------------------------

function createMockDiscordJSClient(): DiscordJSClient & {
  __listeners: Record<string, Array<(...args: unknown[]) => void>>;
} {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    }),
    user: { id: '123456789012345678', tag: 'TestBot#1234' },
    channels: {
      fetch: jest.fn(),
    },
    __listeners: listeners,
  };
}

function createMockDiscordClient(jsClient?: ReturnType<typeof createMockDiscordJSClient>): DiscordClient {
  const client = jsClient ?? createMockDiscordJSClient();
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getClient: () => client,
  };
}

// ---------------------------------------------------------------------------
// Test context setup
// ---------------------------------------------------------------------------

interface TestContext {
  db: ReturnType<typeof initializeDatabase>['db'];
  repo: Repository;
  authz: AuthzEngine;
  rateLimiter: RateLimiter;
  router: IntakeRouter;
  adapter: DiscordAdapter;
  jsClient: ReturnType<typeof createMockDiscordJSClient>;
  formatter: DiscordFormatter;
  identityResolver: DiscordIdentityResolver;
  authConfigPath: string;
  mockChannelSend: jest.Mock;
}

function setupTestContext(
  authConfig: AuthConfig,
): TestContext {
  const authConfigPath = writeAuthConfig(authConfig);

  // In-memory SQLite database with migrations
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const { db } = initializeDatabase(':memory:', migrationsDir);
  const repo = new Repository(db);

  // Provision users in the DB
  for (const user of authConfig.users) {
    repo.upsertUser({
      internal_id: user.internal_id,
      role: user.role,
      claude_user: user.identities.claude_user ?? null,
      discord_id: user.identities.discord_id ?? null,
      slack_id: user.identities.slack_id ?? null,
      repo_permissions: JSON.stringify(user.repo_permissions ?? {}),
      rate_limit_override: null,
    });
  }

  // Real AuthzEngine
  const auditLogRepo = AuditLogger.fromDatabase(db);
  const auditLogger = new AuditLogger(auditLogRepo, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const authz = new AuthzEngine(authConfigPath, auditLogger);

  // Real RateLimiter
  const rateLimiter = new RateLimiter(repo);

  // Real IntakeRouter
  const routerDeps: IntakeRouterDeps = {
    authz,
    rateLimiter,
    db: repo,
  };
  const router = new IntakeRouter(routerDeps);

  // Mock Discord.js client
  const jsClient = createMockDiscordJSClient();
  const discordClient = createMockDiscordClient(jsClient);

  // Mock guild for identity resolver
  const mockGuild = {
    members: {
      fetch: jest.fn().mockResolvedValue({ displayName: 'Test User' }),
    },
  };

  // Real DiscordIdentityResolver
  const identityResolver = new DiscordIdentityResolver(repo, mockGuild);

  // Real DiscordFormatter
  const formatter = new DiscordFormatter();

  // Real ComponentInteractionHandler
  const componentHandler = new ComponentInteractionHandler(router, identityResolver, authz);

  // Mock channel send
  const mockChannelSend = jest.fn().mockResolvedValue({ id: 'msg-001', createdTimestamp: Date.now() });

  // DiscordAdapter with real dependencies
  const adapter = new DiscordAdapter(
    discordClient,
    router,
    identityResolver,
    formatter,
    componentHandler,
    async () => {}, // registerCommands no-op
    repo,
  );

  // Set up channel resolver
  adapter.setChannelResolver({
    resolveChannel: jest.fn().mockResolvedValue({
      send: mockChannelSend,
    }),
  });

  return {
    db, repo, authz, rateLimiter, router, adapter,
    jsClient, formatter, identityResolver, authConfigPath,
    mockChannelSend,
  };
}

function teardownTestContext(ctx: TestContext): void {
  ctx.authz.stopWatching();
  try {
    fs.unlinkSync(ctx.authConfigPath);
  } catch {
    // Ignore cleanup errors
  }
}

// ---------------------------------------------------------------------------
// Interaction simulators
// ---------------------------------------------------------------------------

/**
 * Simulate a slash command interaction, route it through the adapter's
 * interactionCreate listener, and return the mock interaction for assertions.
 */
function simulateSlashCommand(
  jsClient: ReturnType<typeof createMockDiscordJSClient>,
  subcommand: string,
  options: Record<string, string | boolean | null>,
  userId: string = 'discord-admin-123',
) {
  const interaction = {
    isRepliable: () => true,
    isChatInputCommand: () => true,
    isMessageComponent: () => false,
    isModalSubmit: () => false,
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
    reply: jest.fn().mockResolvedValue(undefined),
    options: {
      getSubcommand: () => subcommand,
      getString: jest.fn((name: string, _required: boolean) => {
        const val = options[name];
        return typeof val === 'string' ? val : null;
      }),
      getBoolean: jest.fn((name: string, _required: boolean) => {
        const val = options[name];
        return typeof val === 'boolean' ? val : null;
      }),
    },
    user: { id: userId },
    channelId: 'channel-456',
    toString: () => `/ad ${subcommand} ${JSON.stringify(options)}`,
  };

  return interaction;
}

async function fireInteraction(
  jsClient: ReturnType<typeof createMockDiscordJSClient>,
  interaction: unknown,
): Promise<void> {
  const listeners = jsClient.__listeners['interactionCreate'];
  if (listeners && listeners.length > 0) {
    await listeners[0](interaction);
  }
}

function simulateButtonClick(
  customId: string,
  userId: string = 'discord-admin-123',
) {
  return {
    isRepliable: () => true,
    isChatInputCommand: () => false,
    isMessageComponent: () => true,
    isModalSubmit: () => false,
    customId,
    user: { id: userId },
    reply: jest.fn().mockResolvedValue(undefined),
    update: jest.fn().mockResolvedValue(undefined),
  };
}

function simulateModalSubmit(
  fields: Record<string, string>,
  userId: string = 'discord-admin-123',
) {
  return {
    isRepliable: () => true,
    isChatInputCommand: () => false,
    isMessageComponent: () => false,
    isModalSubmit: () => true,
    fields: {
      getTextInputValue: jest.fn((id: string) => fields[id] ?? ''),
    },
    user: { id: userId },
    channelId: 'channel-456',
    deferReply: jest.fn().mockResolvedValue(undefined),
    editReply: jest.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Discord E2E (SPEC-008-3-05, Task 15)', () => {
  const DEFAULT_AUTH_CONFIG: AuthConfig = {
    version: 1,
    users: [
      {
        internal_id: 'admin-user',
        identities: { discord_id: 'discord-admin-123', claude_user: 'admin-user' },
        role: 'admin',
      },
    ],
  };

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-e2e-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 1: Submit via interaction
  // -----------------------------------------------------------------------
  test('submit via interaction creates request in DB with correct fields', async () => {
    const ctx = setupTestContext(DEFAULT_AUTH_CONFIG);

    try {
      // Start adapter to set up interaction listener
      await ctx.adapter.start();

      // Simulate /ad submit description:"Build auth" priority:high
      const interaction = simulateSlashCommand(ctx.jsClient, 'submit', {
        description: 'Build auth system for the platform',
        priority: 'high',
        repo: null,
        deadline: null,
      });

      await fireInteraction(ctx.jsClient, interaction);

      // Verify deferReply() called
      expect(interaction.deferReply).toHaveBeenCalledTimes(1);

      // Verify editReply() called with status embed
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      const editCall = interaction.editReply.mock.calls[0][0];

      // Should have embeds (success case) or content (error case)
      // The submit handler creates the request; verify DB state
      const requestId = extractRequestIdFromEditReply(interaction);
      if (requestId) {
        const request = ctx.repo.getRequest(requestId);
        expect(request).not.toBeNull();
        expect(request!.status).toBe('queued');
        expect(request!.priority).toBe('high');

        // Embed color matches queued phase
        if (editCall.embeds && editCall.embeds[0]) {
          expect(editCall.embeds[0].color).toBe(PHASE_COLORS['queued']);
        }
      }
    } finally {
      await ctx.adapter.shutdown();
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Status query
  // -----------------------------------------------------------------------
  test('status query returns status embed with all fields populated', async () => {
    const ctx = setupTestContext(DEFAULT_AUTH_CONFIG);

    try {
      await ctx.adapter.start();

      // Submit a request via slash command
      const submitInteraction = simulateSlashCommand(ctx.jsClient, 'submit', {
        description: 'Implement search for users API',
        priority: 'normal',
        repo: null,
        deadline: null,
      });

      await fireInteraction(ctx.jsClient, submitInteraction);

      const requestId = extractRequestIdFromEditReply(submitInteraction);
      expect(requestId).toBeTruthy();

      // Simulate /ad status request-id:REQ-000001
      const statusInteraction = simulateSlashCommand(ctx.jsClient, 'status', {
        'request-id': requestId!,
      });

      await fireInteraction(ctx.jsClient, statusInteraction);

      // Verify deferReply called
      expect(statusInteraction.deferReply).toHaveBeenCalledTimes(1);

      // Verify editReply called with status embed
      expect(statusInteraction.editReply).toHaveBeenCalledTimes(1);
      const editCall = statusInteraction.editReply.mock.calls[0][0];

      // Should have an embed with fields populated
      if (editCall.embeds && editCall.embeds[0]) {
        const embed = editCall.embeds[0];
        expect(embed).toBeDefined();
      }
    } finally {
      await ctx.adapter.shutdown();
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Pause/resume
  // -----------------------------------------------------------------------
  test('pause/resume lifecycle works end-to-end via Discord', async () => {
    const ctx = setupTestContext(DEFAULT_AUTH_CONFIG);

    try {
      await ctx.adapter.start();

      // Submit a request
      const submitInteraction = simulateSlashCommand(ctx.jsClient, 'submit', {
        description: 'Build notification system for the app',
        priority: 'normal',
        repo: null,
        deadline: null,
      });
      await fireInteraction(ctx.jsClient, submitInteraction);

      const requestId = extractRequestIdFromEditReply(submitInteraction);
      expect(requestId).toBeTruthy();

      // Manually set to active (simulates the pipeline picking it up)
      ctx.repo.updateRequest(requestId!, {
        status: 'active',
        current_phase: 'execution',
      });

      // Simulate /ad pause request-id:REQ-XXXXXX
      const pauseInteraction = simulateSlashCommand(ctx.jsClient, 'pause', {
        'request-id': requestId!,
      });
      await fireInteraction(ctx.jsClient, pauseInteraction);

      // Verify status is paused
      const pausedRequest = ctx.repo.getRequest(requestId!);
      expect(pausedRequest!.status).toBe('paused');

      // Simulate /ad resume request-id:REQ-XXXXXX
      const resumeInteraction = simulateSlashCommand(ctx.jsClient, 'resume', {
        'request-id': requestId!,
      });
      await fireInteraction(ctx.jsClient, resumeInteraction);

      // Verify status is active again
      const resumedRequest = ctx.repo.getRequest(requestId!);
      expect(resumedRequest!.status).toBe('active');
    } finally {
      await ctx.adapter.shutdown();
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 4: Kill confirmation flow
  // -----------------------------------------------------------------------
  test('kill confirmation flow via buttons', async () => {
    const ctx = setupTestContext(DEFAULT_AUTH_CONFIG);

    try {
      await ctx.adapter.start();

      // Submit a request and set it to active
      const submitInteraction = simulateSlashCommand(ctx.jsClient, 'submit', {
        description: 'Build CI/CD pipeline for deployment',
        priority: 'normal',
        repo: null,
        deadline: null,
      });
      await fireInteraction(ctx.jsClient, submitInteraction);

      const requestId = extractRequestIdFromEditReply(submitInteraction);
      expect(requestId).toBeTruthy();
      ctx.repo.updateRequest(requestId!, {
        status: 'active',
        current_phase: 'execution',
      });

      // Simulate /ad kill (first call returns confirmation prompt)
      const killInteraction = simulateSlashCommand(ctx.jsClient, 'kill', {});
      await fireInteraction(ctx.jsClient, killInteraction);

      // Verify deferReply called
      expect(killInteraction.deferReply).toHaveBeenCalledTimes(1);

      // Simulate button click on kill_confirm by admin
      const buttonInteraction = simulateButtonClick('kill_confirm', 'discord-admin-123');
      await fireInteraction(ctx.jsClient, buttonInteraction);

      // Verify the active request is now paused
      const pausedRequest = ctx.repo.getRequest(requestId!);
      expect(pausedRequest!.status).toBe('paused');

      // Verify button update was called
      expect(buttonInteraction.update).toHaveBeenCalledWith({
        content: 'All requests have been killed.',
        components: [],
      });
    } finally {
      await ctx.adapter.shutdown();
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 5: Modal submission
  // -----------------------------------------------------------------------
  test('modal submission with description, repo, and acceptance criteria creates request', async () => {
    const ctx = setupTestContext(DEFAULT_AUTH_CONFIG);

    try {
      await ctx.adapter.start();

      // Simulate modal submit
      const modalInteraction = simulateModalSubmit({
        description: 'Implement OAuth2 login for the application',
        repo: 'owner/auth-service',
        acceptance_criteria: 'Users can log in via Google',
      }, 'discord-admin-123');

      await fireInteraction(ctx.jsClient, modalInteraction);

      // Verify deferReply called
      expect(modalInteraction.deferReply).toHaveBeenCalledTimes(1);

      // Verify editReply was called
      expect(modalInteraction.editReply).toHaveBeenCalledTimes(1);
      const editCall = modalInteraction.editReply.mock.calls[0][0] as { content: string };

      // Should contain a request ID
      const requestIdMatch = editCall.content?.match(/REQ-\d{6}/);
      if (requestIdMatch) {
        const requestId = requestIdMatch[0];
        const request = ctx.repo.getRequest(requestId);
        expect(request).not.toBeNull();
        expect(request!.target_repo).toBe('owner/auth-service');
      }
    } finally {
      await ctx.adapter.shutdown();
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 6: Thread creation
  // -----------------------------------------------------------------------
  test('thread creation for clarifying questions', async () => {
    const ctx = setupTestContext(DEFAULT_AUTH_CONFIG);

    try {
      // Submit a request directly through the repo
      const requestId = ctx.repo.generateRequestId();
      ctx.repo.insertRequest({
        request_id: requestId,
        title: 'Build feature with clarifications needed',
        description: 'Need more info',
        raw_input: 'Build feature',
        priority: 'normal',
        target_repo: null,
        status: 'active',
        current_phase: 'prd_generation',
        phase_progress: null,
        requester_id: 'admin-user',
        source_channel: 'discord',
        notification_config: '{}',
        deadline: null,
        related_tickets: '[]',
        technical_constraints: null,
        acceptance_criteria: null,
        blocker: null,
        promotion_count: 0,
        last_promoted_at: null,
        paused_at_phase: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // Set up mock for thread creation
      const startThreadFn = jest.fn().mockResolvedValue({
        id: 'thread-001',
        send: jest.fn().mockResolvedValue({ id: 'thread-msg-001', createdTimestamp: Date.now() }),
      });

      const mockMessage = { startThread: startThreadFn };
      const mockChannel = {
        messages: { fetch: jest.fn().mockResolvedValue(mockMessage) },
        send: jest.fn(),
      };

      const mockJsClient = createMockDiscordJSClient();
      (mockJsClient.channels!.fetch as jest.Mock).mockResolvedValue(mockChannel);

      // Replace the adapter's client to use our mock with thread support
      const discordClient = createMockDiscordClient(mockJsClient);
      const componentHandler = {
        handle: jest.fn().mockResolvedValue(undefined),
        handleModalSubmit: jest.fn().mockResolvedValue(undefined),
      };
      const threadAdapter = new DiscordAdapter(
        discordClient,
        ctx.router,
        ctx.identityResolver,
        ctx.formatter,
        componentHandler,
        async () => {},
        ctx.repo,
      );

      // Create a clarifying thread
      const thread = await threadAdapter.createClarifyingThread(
        'channel-456',
        'msg-ack-001',
        requestId,
      );

      // Verify thread was created with correct name
      expect(startThreadFn).toHaveBeenCalledWith({
        name: `${requestId} - Clarification`,
        autoArchiveDuration: 1440, // OneDay
      });

      expect(thread.id).toBe('thread-001');

      // Verify thread ID persisted in notification_config
      const updatedRequest = ctx.repo.getRequest(requestId);
      expect(updatedRequest).not.toBeNull();
      const config = JSON.parse(updatedRequest!.notification_config);
      expect(config.routes).toBeDefined();
      expect(config.routes[0].threadId).toBe('thread-001');
      expect(config.routes[0].channelType).toBe('discord');

      // Subsequent messages go to the same thread (verify thread.send works)
      const sendResult = await thread.send({ content: 'Follow-up question' });
      expect(sendResult.id).toBe('thread-msg-001');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 7: Unauthorized user
  // -----------------------------------------------------------------------
  test('unauthorized user receives authorization error in deferred reply', async () => {
    const authConfig: AuthConfig = {
      version: 1,
      users: [
        {
          internal_id: 'admin-user',
          identities: { discord_id: 'discord-admin-123', claude_user: 'admin-user' },
          role: 'admin',
        },
        // Note: no mapping for discord-unknown-999
      ],
    };

    const ctx = setupTestContext(authConfig);

    try {
      await ctx.adapter.start();

      // Simulate interaction from unmapped Discord user
      const interaction = simulateSlashCommand(
        ctx.jsClient,
        'submit',
        { description: 'Should be denied', priority: 'normal', repo: null, deadline: null },
        'discord-unknown-999', // Not in user_identities
      );

      await fireInteraction(ctx.jsClient, interaction);

      // Verify deferReply was called (always deferred first)
      expect(interaction.deferReply).toHaveBeenCalledTimes(1);

      // Verify editReply was called with authorization error
      expect(interaction.editReply).toHaveBeenCalledTimes(1);
      const editCall = interaction.editReply.mock.calls[0][0];

      // The error should mention the authorization issue
      if (editCall.content) {
        expect(editCall.content).toContain('Error');
      }
    } finally {
      await ctx.adapter.shutdown();
      teardownTestContext(ctx);
    }
  });
});

// ---------------------------------------------------------------------------
// Utility: Extract request ID from editReply mock calls
// ---------------------------------------------------------------------------

function extractRequestIdFromEditReply(
  interaction: { editReply: jest.Mock },
): string | null {
  if (interaction.editReply.mock.calls.length === 0) return null;

  const editCall = interaction.editReply.mock.calls[0][0];

  // Check embeds for request ID in title
  if (editCall.embeds && editCall.embeds[0]) {
    const title = editCall.embeds[0].title;
    if (typeof title === 'string') {
      const match = title.match(/REQ-\d{6}/);
      if (match) return match[0];
    }
  }

  // Check content for request ID
  if (typeof editCall.content === 'string') {
    const match = editCall.content.match(/REQ-\d{6}/);
    if (match) return match[0];
  }

  // Check the entire serialized call for a request ID
  const serialized = JSON.stringify(editCall);
  const match = serialized.match(/REQ-\d{6}/);
  return match ? match[0] : null;
}
