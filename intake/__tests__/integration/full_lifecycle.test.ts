/**
 * Full lifecycle integration test.
 *
 * Uses a real in-memory SQLite database with full migrations applied.
 * Exercises the complete request lifecycle:
 *   submit -> status -> (set active) -> pause -> resume -> (set active) ->
 *   cancel (confirmation) -> cancel (CONFIRM)
 *
 * Verifies activity log and authz audit log at each step.
 *
 * Implements SPEC-008-1-09, Task 17 -- full_lifecycle.
 *
 * Total: 1 multi-step test.
 *
 * @module full_lifecycle.test
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

interface TestContext {
  db: ReturnType<typeof initializeDatabase>['db'];
  repo: Repository;
  authz: AuthzEngine;
  rateLimiter: RateLimiter;
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

  for (const user of authConfig.users) {
    repo.upsertUser({
      internal_id: user.internal_id,
      role: user.role,
      claude_user: user.identities.claude_user ?? null,
      discord_id: null,
      slack_id: null,
      repo_permissions: '{}',
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

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Full Lifecycle Integration (SPEC-008-1-09)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-lifecycle-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  test('submit -> status -> pause -> resume -> cancel lifecycle with complete audit trail', async () => {
    const ctx = setupTestContext();

    try {
      // Step 1: Submit
      const submitResult = await ctx.router.route(
        makeCommand('submit', ['Build', 'comprehensive', 'user', 'management', 'system', 'with', 'roles'], 'admin-user'),
      );
      expect(submitResult.success).toBe(true);
      const requestId = (submitResult.data as { requestId: string }).requestId;
      expect(requestId).toMatch(/^REQ-\d{6}$/);

      // Verify status is queued
      let dbRow = ctx.repo.getRequest(requestId);
      expect(dbRow!.status).toBe('queued');

      // Step 2: Status check
      const statusResult = await ctx.router.route(
        makeCommand('status', [requestId], 'admin-user'),
      );
      expect(statusResult.success).toBe(true);
      const statusData = statusResult.data as {
        requestId: string;
        status: string;
        title: string;
        priority: string;
        createdAt: string;
        updatedAt: string;
      };
      expect(statusData.requestId).toBe(requestId);
      expect(statusData.status).toBe('queued');
      expect(statusData.title).toBeDefined();
      expect(statusData.priority).toBeDefined();
      expect(statusData.createdAt).toBeDefined();
      expect(statusData.updatedAt).toBeDefined();

      // Step 3: Manually set status to 'active' (simulating pipeline pickup)
      ctx.repo.updateRequest(requestId, { status: 'active' });
      dbRow = ctx.repo.getRequest(requestId);
      expect(dbRow!.status).toBe('active');

      // Step 4: Pause
      const pauseResult = await ctx.router.route(
        makeCommand('pause', [requestId], 'admin-user'),
      );
      expect(pauseResult.success).toBe(true);
      expect((pauseResult.data as { status: string }).status).toBe('paused');

      dbRow = ctx.repo.getRequest(requestId);
      expect(dbRow!.status).toBe('paused');
      expect(dbRow!.paused_at_phase).not.toBeNull();

      // Step 5: Resume
      const resumeResult = await ctx.router.route(
        makeCommand('resume', [requestId], 'admin-user'),
      );
      expect(resumeResult.success).toBe(true);
      expect((resumeResult.data as { status: string }).status).toBe('active');

      dbRow = ctx.repo.getRequest(requestId);
      expect(dbRow!.status).toBe('active');

      // Step 6: Manually set status to 'active' again (already active, but ensures state)
      ctx.repo.updateRequest(requestId, { status: 'active' });

      // Step 7: Cancel (first call -> confirmation required)
      const cancel1 = await ctx.router.route(
        makeCommand('cancel', [requestId], 'admin-user'),
      );
      expect(cancel1.success).toBe(true);
      expect((cancel1.data as { confirmationRequired: boolean }).confirmationRequired).toBe(true);

      // Step 8: Cancel (second call with CONFIRM)
      const cancel2 = await ctx.router.route(
        makeCommand('cancel', [requestId, 'CONFIRM'], 'admin-user'),
      );
      expect(cancel2.success).toBe(true);
      expect((cancel2.data as { status: string }).status).toBe('cancelled');

      dbRow = ctx.repo.getRequest(requestId);
      expect(dbRow!.status).toBe('cancelled');

      // Step 9: Verify activity log has entries for submit, pause, resume, cancel
      const logs = ctx.repo.getActivityLog(requestId);
      const logEvents = logs.map((l) => l.event);
      expect(logEvents).toContain('request_submitted');
      expect(logEvents).toContain('request_paused');
      expect(logEvents).toContain('request_resumed');
      expect(logEvents).toContain('request_cancelled');

      // Step 10: Verify authz_audit_log has entries for all 5 commands
      // (submit, status, pause, resume, cancel x2 = at least 5 grant entries)
      const allAuditLogs = ctx.db
        .prepare(
          "SELECT action, decision FROM authz_audit_log WHERE user_id = 'admin-user' ORDER BY audit_id ASC",
        )
        .all() as Array<{ action: string; decision: string }>;

      const grantedActions = allAuditLogs
        .filter((l) => l.decision === 'grant')
        .map((l) => l.action);

      expect(grantedActions).toContain('submit');
      expect(grantedActions).toContain('status');
      expect(grantedActions).toContain('pause');
      expect(grantedActions).toContain('resume');
      expect(grantedActions).toContain('cancel');
    } finally {
      teardown(ctx);
    }
  });
});
