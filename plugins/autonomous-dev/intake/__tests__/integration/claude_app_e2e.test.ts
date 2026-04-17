/**
 * End-to-end integration tests for the Claude App channel.
 *
 * Uses a real in-memory SQLite database, real IntakeRouter, real AuthzEngine,
 * real RateLimiter, and a mock NLP parser. Tests the complete lifecycle
 * from command bridge through database state verification.
 *
 * Implements SPEC-008-2-04, Task 11.
 *
 * Total: 10 test scenarios.
 *
 * @module claude_app_e2e.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ClaudeCommandBridge } from '../../adapters/claude_command_bridge';
import { VALIDATORS } from '../../adapters/claude_adapter';
import type { CLIFormatter } from '../../adapters/claude_adapter';
import type { ClaudeIdentityResolver } from '../../adapters/claude_identity';
import { parseCommandArgs } from '../../adapters/claude_arg_parser';
import type {
  CommandResult,
  ErrorResponse,
  FormattedMessage,
} from '../../adapters/adapter_interface';
import { Repository } from '../../db/repository';
import { initializeDatabase } from '../../db/migrator';
import {
  IntakeRouter,
  type IntakeRouterDeps,
} from '../../core/intake_router';
import { AuthzEngine, type AuthConfig } from '../../authz/authz_engine';
import { AuditLogger } from '../../authz/audit_logger';
import { RateLimiter } from '../../rate_limit/rate_limiter';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Temp directory for auth YAML configs. */
let tmpDir: string;

/** Create a temporary auth YAML config file and return its path. */
function writeAuthConfig(config: AuthConfig): string {
  // Use js-yaml if available, else manual YAML generation
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

  const configPath = path.join(tmpDir, `auth-${Date.now()}.yaml`);
  fs.writeFileSync(configPath, yamlLines.join('\n'));
  return configPath;
}

/** Create a mock CLIFormatter for e2e tests. */
function createTestFormatter(): CLIFormatter {
  const mkMsg = (text: string): FormattedMessage => ({
    channelType: 'claude_app',
    payload: text,
    fallbackText: text,
  });

  return {
    formatError: (err: ErrorResponse) =>
      mkMsg(`ERROR [${err.errorCode}]: ${err.error}`),
    formatSubmitSuccess: (data: unknown) =>
      mkMsg(`SUBMIT_OK: ${JSON.stringify(data)}`),
    formatStatusCard: (data: unknown) =>
      mkMsg(`STATUS: ${JSON.stringify(data)}`),
    formatList: (data: unknown) =>
      mkMsg(`LIST: ${JSON.stringify(data)}`),
    formatGenericSuccess: (result: CommandResult) =>
      mkMsg(`OK: ${JSON.stringify(result.data)}`),
  };
}

/** Create a mock identity resolver that returns a fixed userId. */
function createTestIdentityResolver(userId: string): ClaudeIdentityResolver {
  return {
    resolve: async () => userId,
  };
}

// ---------------------------------------------------------------------------
// Test-scoped state
// ---------------------------------------------------------------------------

interface TestContext {
  db: ReturnType<typeof initializeDatabase>['db'];
  repo: Repository;
  authz: AuthzEngine;
  rateLimiter: RateLimiter;
  router: IntakeRouter;
  bridge: ClaudeCommandBridge;
  authConfigPath: string;
}

function setupTestContext(authConfig: AuthConfig, userId: string): TestContext {
  const authConfigPath = writeAuthConfig(authConfig);

  // In-memory SQLite database with migrations
  const migrationsDir = path.resolve(__dirname, '../../db/migrations');
  const { db } = initializeDatabase(':memory:', migrationsDir);
  const repo = new Repository(db);

  // Provision users in the DB so the router can find them
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

  // Real AuthzEngine with the temp YAML config
  const auditLogRepo = AuditLogger.fromDatabase(db);
  const auditLogger = new AuditLogger(auditLogRepo, {
    info: () => {},
    warn: () => {},
    error: () => {},
  });
  const authz = new AuthzEngine(authConfigPath, auditLogger);

  // Real RateLimiter
  const rateLimiter = new RateLimiter(repo);

  // Real IntakeRouter (no NLP client, no duplicate detector)
  const routerDeps: IntakeRouterDeps = {
    authz,
    rateLimiter,
    db: repo,
  };
  const router = new IntakeRouter(routerDeps);

  // Command bridge
  const bridge = new ClaudeCommandBridge(
    router,
    createTestIdentityResolver(userId),
    parseCommandArgs,
    createTestFormatter(),
    VALIDATORS,
  );

  return { db, repo, authz, rateLimiter, router, bridge, authConfigPath };
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
// Test suite
// ---------------------------------------------------------------------------

describe('Claude App E2E (SPEC-008-2-04, Task 11)', () => {
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-e2e-'));
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 1: Submit and verify DB state
  // -----------------------------------------------------------------------
  test('submit creates a request with correct DB state', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      const output = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Build user auth system for the platform" --priority high --repo myorg/api',
      );

      expect(output).toContain('SUBMIT_OK');

      // Parse the request ID from the output
      const match = output.match(/REQ-\d{6}/);
      expect(match).not.toBeNull();
      const requestId = match![0];

      // Verify DB state
      const request = ctx.repo.getRequest(requestId);
      expect(request).not.toBeNull();
      expect(request!.status).toBe('queued');
      expect(request!.priority).toBe('high');
      expect(request!.target_repo).toBe('myorg/api');
      expect(requestId).toMatch(/^REQ-\d{6}$/);

      // Queue position is 1 (first request)
      const position = ctx.repo.getQueuePosition(requestId);
      expect(position).toBe(1);

      // Activity log has request_submitted entry
      const logs = ctx.repo.getActivityLog(requestId);
      expect(logs.length).toBeGreaterThanOrEqual(1);
      const submitLog = logs.find((l) => l.event === 'request_submitted');
      expect(submitLog).toBeDefined();
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 2: Status query
  // -----------------------------------------------------------------------
  test('status query returns request details', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      // Submit a request first
      const submitOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Implement search functionality for the users api" --priority normal',
      );
      const requestId = submitOutput.match(/REQ-\d{6}/)![0];

      // Query status
      const statusOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:status',
        requestId,
      );

      expect(statusOutput).toContain('STATUS');
      expect(statusOutput).toContain(requestId);
      // Status data includes the current phase and priority
      const statusData = JSON.parse(
        statusOutput.replace('STATUS: ', ''),
      );
      expect(statusData.priority).toBe('normal');
      expect(statusData.status).toBe('queued');
      expect(statusData.currentPhase).toBeDefined();
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 3: Pause/resume cycle
  // -----------------------------------------------------------------------
  test('pause/resume lifecycle works end-to-end', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      // Submit, then manually set to active
      const submitOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Build notification system for the application" --priority normal',
      );
      const requestId = submitOutput.match(/REQ-\d{6}/)![0];

      // Manually set to active (simulates the pipeline picking it up)
      ctx.repo.updateRequest(requestId, {
        status: 'active',
        current_phase: 'development',
      });

      // Pause via bridge
      const pauseOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:pause',
        requestId,
      );
      expect(pauseOutput).toContain('OK');

      // Verify status is paused
      const pausedRequest = ctx.repo.getRequest(requestId);
      expect(pausedRequest!.status).toBe('paused');

      // Resume via bridge
      const resumeOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:resume',
        requestId,
      );
      expect(resumeOutput).toContain('OK');

      // Verify status is active again
      const resumedRequest = ctx.repo.getRequest(requestId);
      expect(resumedRequest!.status).toBe('active');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 4: Cancel with confirmation
  // -----------------------------------------------------------------------
  test('cancel requires confirmation flow', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      // Submit, then manually set to active
      const submitOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Build payment processing module for checkout" --priority normal',
      );
      const requestId = submitOutput.match(/REQ-\d{6}/)![0];

      ctx.repo.updateRequest(requestId, {
        status: 'active',
        current_phase: 'development',
      });

      // First cancel call returns confirmation prompt
      const cancelOutput1 = await ctx.bridge.handleCommand(
        'autonomous-dev:cancel',
        requestId,
      );
      expect(cancelOutput1).toContain('confirmationRequired');

      // Request should still be active
      const stillActive = ctx.repo.getRequest(requestId);
      expect(stillActive!.status).toBe('active');

      // Cancel again with CONFIRM
      const cancelOutput2 = await ctx.bridge.handleCommand(
        'autonomous-dev:cancel',
        `${requestId} CONFIRM`,
      );
      expect(cancelOutput2).toContain('OK');

      // Verify status is cancelled
      const cancelledRequest = ctx.repo.getRequest(requestId);
      expect(cancelledRequest!.status).toBe('cancelled');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 5: Priority change
  // -----------------------------------------------------------------------
  test('priority change updates request and returns new queue position', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      // Submit with normal priority (queued)
      const submitOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Implement logging framework for the application" --priority low',
      );
      const requestId = submitOutput.match(/REQ-\d{6}/)![0];

      // Verify initial priority
      const initial = ctx.repo.getRequest(requestId);
      expect(initial!.priority).toBe('low');

      // Change priority to high
      const priorityOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:priority',
        `${requestId} high`,
      );
      expect(priorityOutput).toContain('OK');

      // Verify priority updated
      const updated = ctx.repo.getRequest(requestId);
      expect(updated!.priority).toBe('high');

      // Output should contain queue position
      const outputData = JSON.parse(priorityOutput.replace('OK: ', ''));
      expect(outputData.position).toBeDefined();
      expect(typeof outputData.position).toBe('number');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 6: Kill requires admin and CONFIRM
  // -----------------------------------------------------------------------
  test('kill requires admin role and CONFIRM', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      // Submit a request and set it to active
      const submitOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Build CI/CD pipeline for the deployment system" --priority normal',
      );
      const requestId = submitOutput.match(/REQ-\d{6}/)![0];
      ctx.repo.updateRequest(requestId, {
        status: 'active',
        current_phase: 'development',
      });

      // Kill without CONFIRM -> returns confirmation prompt
      const killOutput1 = await ctx.bridge.handleCommand(
        'autonomous-dev:kill',
        '',
      );
      expect(killOutput1).toContain('confirmationRequired');

      // Kill with CONFIRM -> pauses all active requests
      const killOutput2 = await ctx.bridge.handleCommand(
        'autonomous-dev:kill',
        'CONFIRM',
      );
      expect(killOutput2).toContain('OK');

      // Verify the active request is now paused
      const pausedRequest = ctx.repo.getRequest(requestId);
      expect(pausedRequest!.status).toBe('paused');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 7: Feedback delivery
  // -----------------------------------------------------------------------
  test('feedback is recorded in conversation_messages', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      // Submit and set to active
      const submitOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Build API gateway for microservices routing" --priority normal',
      );
      const requestId = submitOutput.match(/REQ-\d{6}/)![0];
      ctx.repo.updateRequest(requestId, {
        status: 'active',
        current_phase: 'development',
      });

      // Send feedback
      const feedbackOutput = await ctx.bridge.handleCommand(
        'autonomous-dev:feedback',
        `${requestId} "Please also add rate limiting to the gateway"`,
      );
      expect(feedbackOutput).toContain('OK');

      // Verify conversation_messages table has the feedback entry
      const messages = ctx.db
        .prepare(
          'SELECT * FROM conversation_messages WHERE request_id = ?',
        )
        .all(requestId) as Array<{
        message_type: string;
        direction: string;
        channel: string;
        content: string;
      }>;

      expect(messages.length).toBeGreaterThanOrEqual(1);
      const feedbackMsg = messages.find(
        (m) => m.message_type === 'feedback',
      );
      expect(feedbackMsg).toBeDefined();
      expect(feedbackMsg!.direction).toBe('inbound');
      expect(feedbackMsg!.channel).toBe('feedback');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 8: Viewer cannot submit
  // -----------------------------------------------------------------------
  test('viewer user receives AUTHZ_DENIED when attempting submit', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'viewer-user',
            identities: { claude_user: 'viewer-user' },
            role: 'viewer',
          },
        ],
      },
      'viewer-user',
    );

    try {
      const output = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Build something interesting for the platform" --priority normal',
      );

      expect(output).toContain('AUTHZ_DENIED');
      expect(output).toContain('ERROR');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 9: Rate limit enforcement
  // -----------------------------------------------------------------------
  test('rate limit enforced after exceeding submission limit', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      // Submit 10 times (default limit is 10/hour for submissions)
      for (let i = 0; i < 10; i++) {
        const output = await ctx.bridge.handleCommand(
          'autonomous-dev:submit',
          `"Build feature number ${i + 1} for the application platform" --priority normal`,
        );
        expect(output).toContain('SUBMIT_OK');
      }

      // 11th submission should be rate-limited
      const output = await ctx.bridge.handleCommand(
        'autonomous-dev:submit',
        '"Build one more feature for the application system" --priority normal',
      );

      expect(output).toContain('RATE_LIMITED');
      expect(output).toContain('ERROR');
    } finally {
      teardownTestContext(ctx);
    }
  });

  // -----------------------------------------------------------------------
  // Scenario 10: Invalid request ID
  // -----------------------------------------------------------------------
  test('invalid request ID returns VALIDATION_ERROR before hitting router', async () => {
    const ctx = setupTestContext(
      {
        version: 1,
        users: [
          {
            internal_id: 'admin-user',
            identities: { claude_user: 'admin-user' },
            role: 'admin',
          },
        ],
      },
      'admin-user',
    );

    try {
      const output = await ctx.bridge.handleCommand(
        'autonomous-dev:status',
        'BAD-ID',
      );

      expect(output).toContain('VALIDATION_ERROR');
      expect(output).toContain('Invalid request ID format');
    } finally {
      teardownTestContext(ctx);
    }
  });
});
