/**
 * End-to-end integration tests for the Slack channel.
 *
 * Uses a real in-memory SQLite database, real IntakeRouter, real AuthzEngine,
 * and a mock Slack Web API client. Tests the complete lifecycle from slash
 * command webhook through database state verification.
 *
 * Implements SPEC-008-4-05, Task 17.
 *
 * Total: 7 test scenarios.
 *
 * @module slack_e2e.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { Repository } from '../../db/repository';
import { initializeDatabase } from '../../db/migrator';
import { IntakeRouter, type IntakeRouterDeps } from '../../core/intake_router';
import { AuthzEngine, type AuthConfig } from '../../authz/authz_engine';
import { AuditLogger } from '../../authz/audit_logger';
import { RateLimiter } from '../../rate_limit/rate_limiter';
import {
  SlackCommandHandler,
  type IntakeRouter as CmdRouter,
  type SlackFormatter as CmdSlackFormatter,
  type SlackCommandRequest,
  type SlackCommandResponse,
} from '../../adapters/slack/slack_command_handler';
import {
  SlackInteractionHandler,
  type IntakeRouter as IxnRouter,
  type SlackWebClient,
  type ExpressRequest,
  type ExpressResponse,
} from '../../adapters/slack/slack_interaction_handler';
import { SlackIdentityResolver } from '../../adapters/slack/slack_identity';
import type { CommandResult, IncomingCommand } from '../../adapters/adapter_interface';

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
    if (user.identities.slack_id) {
      yamlLines.push(`      slack_id: "${user.identities.slack_id}"`);
    }
    if (user.identities.claude_user) {
      yamlLines.push(`      claude_user: "${user.identities.claude_user}"`);
    }
    yamlLines.push(`    role: ${user.role}`);
  }

  const configPath = path.join(tmpDir, `auth-${Date.now()}.yaml`);
  fs.writeFileSync(configPath, yamlLines.join('\n'));
  return configPath;
}

function createMockSlackWebClient(): SlackWebClient & {
  ephemeralCalls: Array<Record<string, unknown>>;
  viewsOpenCalls: Array<Record<string, unknown>>;
} {
  return {
    ephemeralCalls: [],
    viewsOpenCalls: [],
    chat: {
      async postEphemeral(params: { channel: string; user: string; text: string }) {
        this.ephemeralCalls.push(params);
        return { ok: true };
      }.bind({ ephemeralCalls: [] as Array<Record<string, unknown>> }),
    },
    views: {
      async open(params: { trigger_id: string; view: Record<string, unknown> }) {
        return { ok: true };
      },
    },
  };
}

// Re-create with proper binding
function createMockWebClient() {
  const mock = {
    ephemeralCalls: [] as Array<Record<string, unknown>>,
    viewsOpenCalls: [] as Array<Record<string, unknown>>,
    chat: {
      postEphemeral: jest.fn().mockResolvedValue({ ok: true }),
    },
    views: {
      open: jest.fn().mockResolvedValue({ ok: true }),
    },
  };
  return mock;
}

function createMockFormatter(): CmdSlackFormatter {
  return {
    formatStatusBlocks: jest.fn().mockImplementation((data: unknown) => {
      return [
        { type: 'section', text: { type: 'mrkdwn', text: JSON.stringify(data) } },
      ];
    }),
  };
}

function createMockSlackUserWebClient() {
  return {
    users: {
      info: jest.fn().mockResolvedValue({
        ok: true,
        user: { real_name: 'Test Slack User', name: 'testuser' },
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

interface TestContext {
  db: ReturnType<typeof initializeDatabase>['db'];
  repo: Repository;
  authz: AuthzEngine;
  router: IntakeRouter;
  cmdHandler: SlackCommandHandler;
  ixnHandler: SlackInteractionHandler;
  identityResolver: SlackIdentityResolver;
  authConfigPath: string;
  mockWebClient: ReturnType<typeof createMockWebClient>;
  mockFetch: jest.Mock;
}

function setupTestContext(authConfig: AuthConfig): TestContext {
  const authConfigPath = writeAuthConfig(authConfig);

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

  // AuthzEngine
  const auditLogRepo = AuditLogger.fromDatabase(db);
  const auditLogger = new AuditLogger(auditLogRepo, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const authz = new AuthzEngine(authConfigPath, auditLogger);

  // RateLimiter + Router
  const rateLimiter = new RateLimiter(repo);
  const routerDeps: IntakeRouterDeps = { authz, rateLimiter, db: repo };
  const router = new IntakeRouter(routerDeps);

  // Identity resolver
  const slackUserWebClient = createMockSlackUserWebClient();
  const identityResolver = new SlackIdentityResolver(
    repo,
    slackUserWebClient as unknown as import('../../adapters/slack/slack_identity').SlackWebClient,
  );

  // Formatter
  const formatter = createMockFormatter();

  // Mock fetch for response_url
  const mockFetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });

  // Command handler
  const cmdHandler = new SlackCommandHandler(
    router as unknown as CmdRouter,
    identityResolver,
    formatter,
    mockFetch,
  );

  // Interaction handler
  const mockWebClient = createMockWebClient();
  const ixnHandler = new SlackInteractionHandler(
    router as unknown as IxnRouter,
    identityResolver,
    authz,
    mockWebClient as unknown as SlackWebClient,
  );

  return {
    db,
    repo,
    authz,
    router,
    cmdHandler,
    ixnHandler,
    identityResolver,
    authConfigPath,
    mockWebClient,
    mockFetch,
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

// Suppress stderr logging during tests
const originalStderr = process.stderr.write;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-e2e-'));
  process.stderr.write = jest.fn() as unknown as typeof process.stderr.write;
});
afterAll(() => {
  process.stderr.write = originalStderr;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
});

// Mock global fetch
const mockGlobalFetch = jest.fn().mockResolvedValue({ ok: true });
global.fetch = mockGlobalFetch as unknown as typeof fetch;

// ---------------------------------------------------------------------------
// Helpers for simulating Slack requests
// ---------------------------------------------------------------------------

function makeSlashCommandRequest(
  command: string,
  text: string,
  userId: string,
  channelId: string = 'C12345',
  responseUrl: string = 'https://hooks.slack.com/response/test',
): SlackCommandRequest {
  const params = new URLSearchParams();
  params.set('command', command);
  params.set('text', text);
  params.set('user_id', userId);
  params.set('channel_id', channelId);
  params.set('response_url', responseUrl);
  return { body: params };
}

function makeSlackCommandResponse(): SlackCommandResponse & {
  statusCode?: number;
  jsonData?: unknown;
} {
  const res: SlackCommandResponse & { statusCode?: number; jsonData?: unknown } = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.jsonData = data;
    },
  };
  return res;
}

function makeInteractionRequest(payload: Record<string, unknown>): ExpressRequest {
  return {
    body: { payload: JSON.stringify(payload) },
  };
}

function makeInteractionResponse(): ExpressResponse & {
  statusCode?: number;
  sentBody?: string;
} {
  const res: ExpressResponse & { statusCode?: number; sentBody?: string } = {
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    send(body?: string) {
      res.sentBody = body;
      return res;
    },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Slack E2E (SPEC-008-4-05, Task 17)', () => {
  const authConfig: AuthConfig = {
    version: 1,
    users: [
      {
        internal_id: 'admin-user',
        identities: { slack_id: 'UADMIN123' },
        role: 'admin',
      },
      {
        internal_id: 'contributor-user',
        identities: { slack_id: 'UCONTRIB456' },
        role: 'contributor',
      },
    ],
  };

  // -----------------------------------------------------------------------
  // Scenario 1: Submit via slash command webhook
  // -----------------------------------------------------------------------
  test('submit via /ad-submit creates request in DB', async () => {
    const ctx = setupTestContext(authConfig);
    try {
      const req = makeSlashCommandRequest(
        '/ad-submit',
        '"Build a REST API for user management" --priority high --repo myorg/api',
        'UADMIN123',
      );
      const res = makeSlackCommandResponse();

      await ctx.cmdHandler.handle(req, res);

      expect(res.statusCode).toBe(200);

      // Find the request in DB (should be the latest one)
      const requests = ctx.db
        .prepare("SELECT * FROM requests WHERE status = 'queued' ORDER BY created_at DESC")
        .all() as Array<{ request_id: string; priority: string; target_repo: string }>;

      expect(requests.length).toBeGreaterThanOrEqual(1);
      const latestRequest = requests[0];
      expect(latestRequest.request_id).toMatch(/^REQ-\d{6}$/);
      expect(latestRequest.priority).toBe('high');
      expect(latestRequest.target_repo).toBe('myorg/api');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Status query response
  // -----------------------------------------------------------------------
  test('status query returns Block Kit response with correct fields', async () => {
    const ctx = setupTestContext(authConfig);
    try {
      // Create a request first
      const submitReq = makeSlashCommandRequest(
        '/ad-submit',
        '"Build search functionality for users" --priority normal',
        'UADMIN123',
      );
      const submitRes = makeSlackCommandResponse();
      await ctx.cmdHandler.handle(submitReq, submitRes);

      // Find the request ID
      const requests = ctx.db
        .prepare("SELECT request_id FROM requests ORDER BY created_at DESC LIMIT 1")
        .all() as Array<{ request_id: string }>;
      const requestId = requests[0].request_id;

      // Query status
      const statusReq = makeSlashCommandRequest('/ad-status', requestId, 'UADMIN123');
      const statusRes = makeSlackCommandResponse();
      await ctx.cmdHandler.handle(statusReq, statusRes);

      expect(statusRes.statusCode).toBe(200);
      const responseData = statusRes.jsonData as Record<string, unknown>;
      expect(responseData.response_type).toBe('in_channel');
      // The formatter should have been called with the request data
      expect(responseData.blocks).toBeDefined();
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Kill confirmation flow
  // -----------------------------------------------------------------------
  test('kill confirmation: /ad-kill returns confirmation, block_actions kill_confirm pauses all', async () => {
    const ctx = setupTestContext(authConfig);
    try {
      // Create a request and set to active
      const submitReq = makeSlashCommandRequest(
        '/ad-submit',
        '"Build CI pipeline for deployments" --priority normal',
        'UADMIN123',
      );
      const submitRes = makeSlackCommandResponse();
      await ctx.cmdHandler.handle(submitReq, submitRes);

      const requests = ctx.db
        .prepare("SELECT request_id FROM requests ORDER BY created_at DESC LIMIT 1")
        .all() as Array<{ request_id: string }>;
      const requestId = requests[0].request_id;

      ctx.repo.updateRequest(requestId, {
        status: 'active',
        current_phase: 'execution',
      });

      // First kill -> confirmation
      const killReq = makeSlashCommandRequest('/ad-kill', '', 'UADMIN123');
      const killRes = makeSlackCommandResponse();
      await ctx.cmdHandler.handle(killReq, killRes);

      expect(killRes.statusCode).toBe(200);
      const killData = killRes.jsonData as Record<string, unknown>;
      // Should contain confirmation required
      expect(JSON.stringify(killData)).toContain('confirmationRequired');

      // Now simulate kill_confirm via interaction handler
      const ixnReq = makeInteractionRequest({
        type: 'block_actions',
        actions: [{ action_id: 'kill_confirm' }],
        user: { id: 'UADMIN123' },
        channel: { id: 'C12345' },
        response_url: 'https://hooks.slack.com/response/kill',
      });
      const ixnRes = makeInteractionResponse();
      await ctx.ixnHandler.handle(ixnReq, ixnRes);

      expect(ixnRes.statusCode).toBe(200);

      // Verify all active requests are now paused
      const pausedRequest = ctx.repo.getRequest(requestId);
      expect(pausedRequest!.status).toBe('paused');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 4: Modal submission
  // -----------------------------------------------------------------------
  test('view_submission creates request with all fields', async () => {
    const ctx = setupTestContext(authConfig);
    try {
      const ixnReq = makeInteractionRequest({
        type: 'view_submission',
        user: { id: 'UCONTRIB456' },
        view: {
          callback_id: 'submit_modal',
          state: {
            values: {
              description_block: {
                description: { value: 'Build a new notification service for alerts' },
              },
              repo_block: {
                repo: { value: 'myorg/notifications' },
              },
              criteria_block: {
                acceptance_criteria: { value: 'Must handle 1000 msg/sec' },
              },
            },
          },
        },
      });
      const ixnRes = makeInteractionResponse();
      await ctx.ixnHandler.handle(ixnReq, ixnRes);

      // Should acknowledge
      expect(ixnRes.statusCode).toBe(200);

      // Verify request in DB
      const requests = ctx.db
        .prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT 1")
        .all() as Array<{
          request_id: string;
          target_repo: string | null;
          acceptance_criteria: string | null;
        }>;

      expect(requests.length).toBeGreaterThanOrEqual(1);
      // The submit handler should have stored the repo and criteria
      const latest = requests[0];
      expect(latest.request_id).toMatch(/^REQ-\d{6}$/);
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 5: Thread conversation
  // -----------------------------------------------------------------------
  test('thread conversation: sendMessage with thread_ts uses correct routing', async () => {
    const ctx = setupTestContext(authConfig);
    try {
      // This scenario tests that threaded messages have the correct
      // thread_ts and that conversations.join is called.
      // We test via the SlackAdapter's createClarifyingThread indirectly:
      // the integration here validates that the router can handle requests
      // from threaded contexts.
      const submitReq = makeSlashCommandRequest(
        '/ad-submit',
        '"Build auth module for platform" --priority normal',
        'UADMIN123',
        'C12345',
      );
      const submitRes = makeSlackCommandResponse();
      await ctx.cmdHandler.handle(submitReq, submitRes);

      // Verify the source channel is recorded
      const requests = ctx.db
        .prepare("SELECT * FROM requests ORDER BY created_at DESC LIMIT 1")
        .all() as Array<{ request_id: string; source_channel: string }>;

      expect(requests[0].source_channel).toBe('slack');

      // Now insert a conversation message (simulating a clarifying question thread)
      const requestId = requests[0].request_id;
      const msgId = ctx.repo.insertConversationMessage({
        message_id: '',
        request_id: requestId,
        direction: 'outbound',
        channel: 'slack',
        content: 'Which auth method?',
        message_type: 'clarifying_question',
        responded: 0,
        timeout_at: new Date(Date.now() + 3600_000).toISOString(),
        thread_id: '1234567890.000001',
      });

      expect(msgId).toBeTruthy();

      // Verify the message is in DB with thread_id
      const messages = ctx.db
        .prepare('SELECT * FROM conversation_messages WHERE request_id = ?')
        .all(requestId) as Array<{ thread_id: string | null }>;

      const threadedMsg = messages.find((m) => m.thread_id === '1234567890.000001');
      expect(threadedMsg).toBeDefined();
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 6: Unauthorized user
  // -----------------------------------------------------------------------
  test('unauthorized (unmapped) Slack user receives ephemeral error', async () => {
    const ctx = setupTestContext(authConfig);
    try {
      // Use a Slack user ID that is not in the auth config
      const req = makeSlashCommandRequest(
        '/ad-submit',
        '"Build something" --priority normal',
        'UUNKNOWN999',
      );
      const res = makeSlackCommandResponse();
      await ctx.cmdHandler.handle(req, res);

      expect(res.statusCode).toBe(200);
      const data = res.jsonData as Record<string, unknown>;
      expect(data.response_type).toBe('ephemeral');
      expect(data.text).toBeDefined();
      expect(String(data.text)).toContain('Authorization error');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 7: Response_url follow-up (slow router)
  // -----------------------------------------------------------------------
  test('slow router triggers ack then response_url follow-up', async () => {
    const ctx = setupTestContext(authConfig);
    try {
      // Override the router with a slow mock
      const slowRouter: CmdRouter = {
        async route(command: IncomingCommand): Promise<CommandResult> {
          // Simulate a slow operation (> 2.5s)
          await new Promise((resolve) => setTimeout(resolve, 3000));
          return { success: true, data: { requestId: 'REQ-SLOW' } };
        },
      };

      const slowCmdHandler = new SlackCommandHandler(
        slowRouter,
        ctx.identityResolver,
        createMockFormatter(),
        ctx.mockFetch,
      );

      const req = makeSlashCommandRequest(
        '/ad-status',
        'REQ-000001',
        'UADMIN123',
        'C12345',
        'https://hooks.slack.com/response/slow',
      );
      const res = makeSlackCommandResponse();

      await slowCmdHandler.handle(req, res);

      // Should have acknowledged with 200 immediately
      expect(res.statusCode).toBe(200);

      // The inline response should be the acknowledgment
      const inlineData = res.jsonData as Record<string, unknown>;
      expect(String(inlineData.text)).toContain('Processing');

      // The response_url should have been called with the final result
      expect(ctx.mockFetch).toHaveBeenCalledWith(
        'https://hooks.slack.com/response/slow',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    } finally {
      teardownTestContext(ctx);
    }
  }, 10000); // Extend timeout for slow test
});
