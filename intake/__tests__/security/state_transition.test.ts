/**
 * Security tests for state transition enforcement.
 *
 * Uses a real in-memory SQLite database and real router.
 * Creates requests in each state, attempts every possible action,
 * and verifies valid transitions succeed while invalid ones return
 * INVALID_STATE error code.
 *
 * Also tests specific abuse cases.
 *
 * Implements SPEC-008-1-09, Task 18 -- state_transition.
 *
 * Total: 30+ tests.
 *
 * @module state_transition.test
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
import { STATE_TRANSITIONS } from '../../handlers/state_machine';
import type {
  IncomingCommand,
  ParsedRequest,
  RequestStatus,
} from '../../adapters/adapter_interface';
import type { ClaudeApiClient } from '../../core/request_parser';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function writeAuthConfig(config: AuthConfig): string {
  const yamlLines: string[] = [];
  yamlLines.push(`version: ${config.version}`);
  yamlLines.push('users:');
  for (const user of config.users) {
    yamlLines.push(`  - internal_id: "${user.internal_id}"`);
    yamlLines.push('    identities:');
    if (user.identities.claude_user)
      yamlLines.push(`      claude_user: "${user.identities.claude_user}"`);
    yamlLines.push(`    role: ${user.role}`);
  }
  const configPath = path.join(tmpDir, `auth-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
  fs.writeFileSync(configPath, yamlLines.join('\n'));
  return configPath;
}

function createMockClaudeClient(): ClaudeApiClient {
  return {
    async createMessage(_systemPrompt: string, userMessage: string): Promise<string> {
      const parsed: ParsedRequest = {
        title: userMessage.slice(0, 80),
        description: userMessage,
        priority: 'normal',
        target_repo: null,
        deadline: null,
        related_tickets: [],
        technical_constraints: null,
        acceptance_criteria: null,
        confidence: 0.9,
      };
      return JSON.stringify(parsed);
    },
  };
}

function makeCommand(
  name: string,
  args: string[],
  userId: string = 'admin-user',
  flags: Record<string, string | boolean> = {},
): IncomingCommand {
  return {
    commandName: name,
    args,
    flags,
    rawText: `${name} ${args.join(' ')}`,
    source: {
      channelType: 'claude_app',
      userId,
      timestamp: new Date(),
    },
  };
}

interface TestContext {
  db: ReturnType<typeof initializeDatabase>['db'];
  repo: Repository;
  authz: AuthzEngine;
  router: IntakeRouter;
  authConfigPath: string;
}

function setupTestContext(): TestContext {
  const authConfig: AuthConfig = {
    version: 1,
    users: [
      {
        internal_id: 'admin-user',
        identities: { claude_user: 'admin-user' },
        role: 'admin',
      },
    ],
  };

  const authConfigPath = writeAuthConfig(authConfig);
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const { db } = initializeDatabase(':memory:', migrationsDir);
  const repo = new Repository(db);

  repo.upsertUser({
    internal_id: 'admin-user',
    role: 'admin',
    claude_user: 'admin-user',
    discord_id: null,
    slack_id: null,
    repo_permissions: '{}',
    rate_limit_override: null,
  });

  const auditLogRepo = AuditLogger.fromDatabase(db);
  const auditLogger = new AuditLogger(auditLogRepo, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const authz = new AuthzEngine(authConfigPath, auditLogger);
  const rateLimiter = new RateLimiter(repo);

  const routerDeps: IntakeRouterDeps = {
    authz,
    rateLimiter,
    db: repo,
    claudeClient: createMockClaudeClient(),
  };
  const router = new IntakeRouter(routerDeps);

  return { db, repo, authz, router, authConfigPath };
}

function teardown(ctx: TestContext): void {
  ctx.authz.stopWatching();
  try {
    fs.unlinkSync(ctx.authConfigPath);
  } catch {
    // ignore
  }
}

/**
 * Create a request in a given state by first submitting, then
 * manually transitioning to the desired state.
 */
function createRequestInState(
  ctx: TestContext,
  status: RequestStatus,
): string {
  const reqId = ctx.repo.generateRequestId();
  const now = new Date().toISOString().replace(/(\.\d{3})\d*Z$/, '$1Z');

  ctx.repo.insertRequest({
    request_id: reqId,
    title: `Test request in ${status} state`,
    description: `Description for request in ${status} state`,
    raw_input: `Raw input for ${status}`,
    priority: 'normal',
    target_repo: null,
    status,
    current_phase: 'intake',
    phase_progress: null,
    requester_id: 'admin-user',
    source_channel: 'claude_app',
    notification_config: '{}',
    deadline: null,
    related_tickets: '[]',
    technical_constraints: null,
    acceptance_criteria: null,
    blocker: null,
    promotion_count: 0,
    last_promoted_at: null,
    paused_at_phase: status === 'paused' ? 'intake' : null,
    created_at: now,
    updated_at: now,
  });

  return reqId;
}

// ---------------------------------------------------------------------------
// All state-mutating actions that go through the router
// ---------------------------------------------------------------------------

/**
 * Actions that require a request ID and validate state transitions.
 * (submit and kill are excluded: submit creates new requests, kill operates globally)
 */
const STATE_ACTIONS = ['cancel', 'pause', 'resume', 'priority', 'feedback'] as const;

/**
 * Build the args array for a given action + requestId.
 */
function buildArgs(action: string, requestId: string): string[] {
  switch (action) {
    case 'cancel':
      return [requestId, 'CONFIRM']; // skip confirmation step
    case 'priority':
      return [requestId, 'high'];
    case 'feedback':
      return [requestId, 'This', 'is', 'test', 'feedback'];
    default:
      return [requestId];
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('State Transition Security (SPEC-008-1-09)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-state-trans-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // -----------------------------------------------------------------------
  // Exhaustive valid/invalid transition matrix
  // -----------------------------------------------------------------------
  const ALL_STATUSES: RequestStatus[] = ['queued', 'active', 'paused', 'cancelled', 'done', 'failed'];

  describe('exhaustive state x action matrix', () => {
    for (const status of ALL_STATUSES) {
      for (const action of STATE_ACTIONS) {
        const allowed = STATE_TRANSITIONS[status]?.includes(action) ?? false;
        const label = allowed ? 'succeeds' : 'returns INVALID_STATE';

        test(`${action} on ${status} request ${label}`, async () => {
          const ctx = setupTestContext();
          try {
            const reqId = createRequestInState(ctx, status);
            const args = buildArgs(action, reqId);
            const result = await ctx.router.route(makeCommand(action, args));

            if (allowed) {
              expect(result.success).toBe(true);
            } else {
              expect(result.success).toBe(false);
              expect(result.errorCode).toBe('INVALID_STATE');
            }
          } finally {
            teardown(ctx);
          }
        });
      }
    }
  });

  // -----------------------------------------------------------------------
  // Specific abuse cases
  // -----------------------------------------------------------------------
  describe('specific abuse cases', () => {
    test('cancel a done request -> INVALID_STATE', async () => {
      const ctx = setupTestContext();
      try {
        const reqId = createRequestInState(ctx, 'done');
        const result = await ctx.router.route(
          makeCommand('cancel', [reqId, 'CONFIRM']),
        );
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('INVALID_STATE');
      } finally {
        teardown(ctx);
      }
    });

    test('resume an active request -> INVALID_STATE', async () => {
      const ctx = setupTestContext();
      try {
        const reqId = createRequestInState(ctx, 'active');
        const result = await ctx.router.route(
          makeCommand('resume', [reqId]),
        );
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('INVALID_STATE');
      } finally {
        teardown(ctx);
      }
    });

    test('pause a queued request -> INVALID_STATE', async () => {
      const ctx = setupTestContext();
      try {
        const reqId = createRequestInState(ctx, 'queued');
        const result = await ctx.router.route(
          makeCommand('pause', [reqId]),
        );
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('INVALID_STATE');
      } finally {
        teardown(ctx);
      }
    });

    test('priority change on active request -> INVALID_STATE', async () => {
      const ctx = setupTestContext();
      try {
        const reqId = createRequestInState(ctx, 'active');
        const result = await ctx.router.route(
          makeCommand('priority', [reqId, 'high']),
        );
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('INVALID_STATE');
      } finally {
        teardown(ctx);
      }
    });

    test('feedback on cancelled request -> INVALID_STATE', async () => {
      const ctx = setupTestContext();
      try {
        const reqId = createRequestInState(ctx, 'cancelled');
        const result = await ctx.router.route(
          makeCommand('feedback', [reqId, 'Some', 'feedback', 'text', 'here']),
        );
        expect(result.success).toBe(false);
        expect(result.errorCode).toBe('INVALID_STATE');
      } finally {
        teardown(ctx);
      }
    });
  });
});
