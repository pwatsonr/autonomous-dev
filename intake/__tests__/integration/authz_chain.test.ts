/**
 * Integration tests for the authorization chain.
 *
 * Uses a real in-memory SQLite database with full migrations applied.
 * Tests RBAC enforcement across 4 roles (admin, operator, contributor, viewer)
 * including repo-scoped overrides and author-of-request special cases.
 *
 * Implements SPEC-008-1-09, Task 17 -- authz_chain.
 *
 * Total: 5 tests.
 *
 * @module authz_chain.test
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
import type { IncomingCommand, ParsedRequest } from '../../adapters/adapter_interface';
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
    if (user.identities.discord_id)
      yamlLines.push(`      discord_id: "${user.identities.discord_id}"`);
    if (user.identities.slack_id)
      yamlLines.push(`      slack_id: "${user.identities.slack_id}"`);
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
  userId: string,
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

const AUTH_CONFIG: AuthConfig = {
  version: 1,
  users: [
    {
      internal_id: 'admin-user',
      identities: { claude_user: 'admin-user' },
      role: 'admin',
    },
    {
      internal_id: 'operator-user',
      identities: { claude_user: 'operator-user' },
      role: 'operator',
    },
    {
      internal_id: 'contributor-user',
      identities: { claude_user: 'contributor-user' },
      role: 'contributor',
    },
    {
      internal_id: 'viewer-user',
      identities: { claude_user: 'viewer-user' },
      role: 'viewer',
    },
    {
      internal_id: 'contributor-repo-override',
      identities: { claude_user: 'contributor-repo-override' },
      role: 'contributor',
      repo_permissions: { 'repo-x': 'operator' },
    },
  ],
};

interface TestContext {
  db: ReturnType<typeof initializeDatabase>['db'];
  repo: Repository;
  authz: AuthzEngine;
  rateLimiter: RateLimiter;
  router: IntakeRouter;
  authConfigPath: string;
}

function setupTestContext(): TestContext {
  const authConfigPath = writeAuthConfig(AUTH_CONFIG);
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const { db } = initializeDatabase(':memory:', migrationsDir);
  const repo = new Repository(db);

  for (const user of AUTH_CONFIG.users) {
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

  return { db, repo, authz, rateLimiter, router, authConfigPath };
}

function teardown(ctx: TestContext): void {
  ctx.authz.stopWatching();
  try {
    fs.unlinkSync(ctx.authConfigPath);
  } catch {
    // ignore
  }
}

/** Helper: get all authz audit log entries for a user. */
function getAuditLogs(
  db: ReturnType<typeof initializeDatabase>['db'],
  userId: string,
): Array<{
  user_id: string;
  action: string;
  decision: string;
  reason: string;
}> {
  return db
    .prepare('SELECT user_id, action, decision, reason FROM authz_audit_log WHERE user_id = ? ORDER BY audit_id ASC')
    .all(userId) as Array<{
    user_id: string;
    action: string;
    decision: string;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Authorization Chain Integration (SPEC-008-1-09)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-authz-chain-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // -----------------------------------------------------------------------
  // Test 1: Viewer denied submit, granted status query
  // -----------------------------------------------------------------------
  test('viewer is denied submit but granted status query', async () => {
    const ctx = setupTestContext();
    try {
      // Viewer submits -> denied
      const submitResult = await ctx.router.route(
        makeCommand('submit', ['Build', 'a', 'feature', 'for', 'user', 'login', 'system'], 'viewer-user'),
      );
      expect(submitResult.success).toBe(false);
      expect(submitResult.errorCode).toBe('AUTHZ_DENIED');

      // Create a request as admin for status check
      const adminSubmit = await ctx.router.route(
        makeCommand('submit', ['Build', 'a', 'feature', 'for', 'user', 'login', 'system'], 'admin-user'),
      );
      expect(adminSubmit.success).toBe(true);
      const requestId = (adminSubmit.data as { requestId: string }).requestId;

      // Viewer queries status -> granted
      const statusResult = await ctx.router.route(
        makeCommand('status', [requestId], 'viewer-user'),
      );
      expect(statusResult.success).toBe(true);

      // Verify audit log entries
      const viewerLogs = getAuditLogs(ctx.db, 'viewer-user');
      const submitDeny = viewerLogs.find((l) => l.action === 'submit' && l.decision === 'deny');
      expect(submitDeny).toBeDefined();
      const statusGrant = viewerLogs.find((l) => l.action === 'status' && l.decision === 'grant');
      expect(statusGrant).toBeDefined();
    } finally {
      teardown(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Test 2: Contributor submits, cancels own, denied cancel other's
  // -----------------------------------------------------------------------
  test('contributor can submit and cancel own request, but cannot cancel another user\'s', async () => {
    const ctx = setupTestContext();
    try {
      // Contributor submits -> granted
      const submitResult = await ctx.router.route(
        makeCommand('submit', ['Implement', 'OAuth', 'integration', 'for', 'login', 'page'], 'contributor-user'),
      );
      expect(submitResult.success).toBe(true);
      const ownRequestId = (submitResult.data as { requestId: string }).requestId;

      // Contributor cancels own -> granted (first call is confirmation)
      const cancelOwn1 = await ctx.router.route(
        makeCommand('cancel', [ownRequestId], 'contributor-user'),
      );
      expect(cancelOwn1.success).toBe(true);
      expect((cancelOwn1.data as { confirmationRequired: boolean }).confirmationRequired).toBe(true);

      // Contributor cancels own (with CONFIRM) -> granted
      const cancelOwn2 = await ctx.router.route(
        makeCommand('cancel', [ownRequestId, 'CONFIRM'], 'contributor-user'),
      );
      expect(cancelOwn2.success).toBe(true);

      // Admin submits a request (to test cancelling other's)
      const adminSubmit = await ctx.router.route(
        makeCommand('submit', ['Build', 'admin', 'dashboard', 'for', 'monitoring', 'system'], 'admin-user'),
      );
      expect(adminSubmit.success).toBe(true);
      const otherRequestId = (adminSubmit.data as { requestId: string }).requestId;

      // Contributor cancels other's -> denied
      const cancelOther = await ctx.router.route(
        makeCommand('cancel', [otherRequestId], 'contributor-user'),
      );
      expect(cancelOther.success).toBe(false);
      expect(cancelOther.errorCode).toBe('AUTHZ_DENIED');

      // Verify audit logs
      const contribLogs = getAuditLogs(ctx.db, 'contributor-user');
      expect(contribLogs.some((l) => l.action === 'submit' && l.decision === 'grant')).toBe(true);
      expect(contribLogs.some((l) => l.action === 'cancel' && l.decision === 'deny')).toBe(true);
    } finally {
      teardown(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: Operator can cancel anyone's request
  // -----------------------------------------------------------------------
  test('operator can cancel any request regardless of owner', async () => {
    const ctx = setupTestContext();
    try {
      // Contributor submits a request
      const submitResult = await ctx.router.route(
        makeCommand('submit', ['Create', 'a', 'notification', 'service', 'for', 'the', 'platform'], 'contributor-user'),
      );
      expect(submitResult.success).toBe(true);
      const requestId = (submitResult.data as { requestId: string }).requestId;

      // Operator cancels (first call: confirmation)
      const cancel1 = await ctx.router.route(
        makeCommand('cancel', [requestId], 'operator-user'),
      );
      expect(cancel1.success).toBe(true);
      expect((cancel1.data as { confirmationRequired: boolean }).confirmationRequired).toBe(true);

      // Operator cancels (with CONFIRM)
      const cancel2 = await ctx.router.route(
        makeCommand('cancel', [requestId, 'CONFIRM'], 'operator-user'),
      );
      expect(cancel2.success).toBe(true);
      expect((cancel2.data as { status: string }).status).toBe('cancelled');

      // Verify audit log
      const operatorLogs = getAuditLogs(ctx.db, 'operator-user');
      expect(operatorLogs.some((l) => l.action === 'cancel' && l.decision === 'grant')).toBe(true);
    } finally {
      teardown(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Test 4: Non-admin denied kill, admin granted kill (with confirmation)
  // -----------------------------------------------------------------------
  test('non-admin is denied kill; admin is granted kill with confirmation', async () => {
    const ctx = setupTestContext();
    try {
      // Operator tries kill -> denied
      const opKill = await ctx.router.route(
        makeCommand('kill', ['CONFIRM'], 'operator-user'),
      );
      expect(opKill.success).toBe(false);
      expect(opKill.errorCode).toBe('AUTHZ_DENIED');

      // Admin kill (first call: confirmation)
      const adminKill1 = await ctx.router.route(
        makeCommand('kill', [], 'admin-user'),
      );
      expect(adminKill1.success).toBe(true);
      expect((adminKill1.data as { confirmationRequired: boolean }).confirmationRequired).toBe(true);

      // Admin kill (with CONFIRM)
      const adminKill2 = await ctx.router.route(
        makeCommand('kill', ['CONFIRM'], 'admin-user'),
      );
      expect(adminKill2.success).toBe(true);
      expect((adminKill2.data as { killed: boolean }).killed).toBe(true);

      // Verify audit logs
      const opLogs = getAuditLogs(ctx.db, 'operator-user');
      expect(opLogs.some((l) => l.action === 'kill' && l.decision === 'deny')).toBe(true);

      const adminLogs = getAuditLogs(ctx.db, 'admin-user');
      expect(adminLogs.some((l) => l.action === 'kill' && l.decision === 'grant')).toBe(true);
    } finally {
      teardown(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Test 5: Contributor with repo override to operator on repo X
  // -----------------------------------------------------------------------
  test('contributor with repo override to operator can cancel any request on that repo', async () => {
    const ctx = setupTestContext();
    try {
      // Admin submits a request targeting repo-x
      const submitResult = await ctx.router.route(
        makeCommand(
          'submit',
          ['Fix', 'deployment', 'pipeline', 'for', 'repo-x', 'production', 'environment'],
          'admin-user',
          { '--repo': 'repo-x' },
        ),
      );
      expect(submitResult.success).toBe(true);
      const requestId = (submitResult.data as { requestId: string }).requestId;

      // contributor-repo-override (contributor base, operator on repo-x) cancels -> granted
      const cancel1 = await ctx.router.route(
        makeCommand('cancel', [requestId], 'contributor-repo-override'),
      );
      expect(cancel1.success).toBe(true);
      expect((cancel1.data as { confirmationRequired: boolean }).confirmationRequired).toBe(true);

      const cancel2 = await ctx.router.route(
        makeCommand('cancel', [requestId, 'CONFIRM'], 'contributor-repo-override'),
      );
      expect(cancel2.success).toBe(true);
      expect((cancel2.data as { status: string }).status).toBe('cancelled');

      // Verify audit log
      const overrideLogs = getAuditLogs(ctx.db, 'contributor-repo-override');
      expect(overrideLogs.some((l) => l.action === 'cancel' && l.decision === 'grant')).toBe(true);
    } finally {
      teardown(ctx);
    }
  });
});
