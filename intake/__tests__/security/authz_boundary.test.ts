/**
 * Security tests for authorization boundaries.
 *
 * Full matrix test: 4 roles x 12 actions = 48 assertions, plus 2 repo-scoped
 * overrides and 2 author-of-request cases = 52 total.
 *
 * Uses a real in-memory SQLite database and real AuthzEngine (no mocks).
 *
 * Implements SPEC-008-1-09, Task 18 -- authz_boundary.
 *
 * Total: 52 tests.
 *
 * @module authz_boundary.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { initializeDatabase } from '../../db/migrator';
import { AuthzEngine, type AuthConfig, type Role } from '../../authz/authz_engine';
import { AuditLogger } from '../../authz/audit_logger';
import type { AuthzAction, AuthzContext } from '../../adapters/adapter_interface';

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
// Permission matrix
// ---------------------------------------------------------------------------

/**
 * Expected grant/deny for each role x action combination.
 *
 * The minimum role required per action:
 *   status: viewer, list: viewer, logs: viewer,
 *   submit: contributor, feedback: contributor,
 *   cancel: contributor (own), pause: contributor (own),
 *   resume: contributor (own), priority: contributor (own),
 *   approve_review: operator,
 *   kill: admin, config_change: admin
 *
 * For contributor-level author-only actions (cancel, pause, resume, priority, feedback),
 * when no requesterId is provided in context, the engine grants at the base role level.
 * The author check only triggers when context.requesterId !== userId.
 */
const ALL_ACTIONS: AuthzAction[] = [
  'status', 'list', 'logs',
  'submit', 'feedback',
  'cancel', 'pause', 'resume', 'priority',
  'approve_review',
  'kill', 'config_change',
];

const ROLES: Role[] = ['viewer', 'contributor', 'operator', 'admin'];

/** Expected grant for role x action with no requesterId context (own-request assumption). */
const EXPECTED: Record<Role, Record<AuthzAction, boolean>> = {
  viewer: {
    status: true, list: true, logs: true,
    submit: false, feedback: false,
    cancel: false, pause: false, resume: false, priority: false,
    approve_review: false,
    kill: false, config_change: false,
  },
  contributor: {
    status: true, list: true, logs: true,
    submit: true, feedback: true,
    cancel: true, pause: true, resume: true, priority: true,
    approve_review: false,
    kill: false, config_change: false,
  },
  operator: {
    status: true, list: true, logs: true,
    submit: true, feedback: true,
    cancel: true, pause: true, resume: true, priority: true,
    approve_review: true,
    kill: false, config_change: false,
  },
  admin: {
    status: true, list: true, logs: true,
    submit: true, feedback: true,
    cancel: true, pause: true, resume: true, priority: true,
    approve_review: true,
    kill: true, config_change: true,
  },
};

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Authorization Boundary Security (SPEC-008-1-09)', () => {
  let authzEngine: AuthzEngine;
  let authConfigPath: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-authz-boundary-'));

    const authConfig: AuthConfig = {
      version: 1,
      users: [
        { internal_id: 'viewer-user', identities: { claude_user: 'viewer-user' }, role: 'viewer' },
        { internal_id: 'contributor-user', identities: { claude_user: 'contributor-user' }, role: 'contributor' },
        { internal_id: 'operator-user', identities: { claude_user: 'operator-user' }, role: 'operator' },
        { internal_id: 'admin-user', identities: { claude_user: 'admin-user' }, role: 'admin' },
        {
          internal_id: 'repo-override-user',
          identities: { claude_user: 'repo-override-user' },
          role: 'contributor',
          repo_permissions: { 'special-repo': 'operator' },
        },
        {
          internal_id: 'repo-admin-user',
          identities: { claude_user: 'repo-admin-user' },
          role: 'viewer',
          repo_permissions: { 'admin-repo': 'admin' },
        },
      ],
    };

    authConfigPath = writeAuthConfig(authConfig);

    const migrationsDir = path.resolve(__dirname, '../../db/migrations');
    const { db } = initializeDatabase(':memory:', migrationsDir);
    const auditLogRepo = AuditLogger.fromDatabase(db);
    const auditLogger = new AuditLogger(auditLogRepo, {
      info: () => {},
      warn: () => {},
      error: () => {},
    });
    authzEngine = new AuthzEngine(authConfigPath, auditLogger);
  });

  afterAll(() => {
    authzEngine.stopWatching();
    try {
      fs.unlinkSync(authConfigPath);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  // -----------------------------------------------------------------------
  // Full 4x12 matrix (48 assertions)
  // -----------------------------------------------------------------------
  describe('role x action matrix (48 assertions)', () => {
    for (const role of ROLES) {
      for (const action of ALL_ACTIONS) {
        const expected = EXPECTED[role][action];
        const label = expected ? 'grant' : 'deny';

        test(`${role} -> ${action} => ${label}`, () => {
          const userId = `${role}-user`;
          const context: AuthzContext & { requesterId?: string } = {};

          const decision = authzEngine.authorize(userId, action, context, 'claude_app');
          expect(decision.granted).toBe(expected);
        });
      }
    }
  });

  // -----------------------------------------------------------------------
  // Repo-scoped overrides (2 assertions)
  // -----------------------------------------------------------------------
  describe('repo-scoped overrides', () => {
    test('contributor with operator override on special-repo can approve_review on that repo', () => {
      const decision = authzEngine.authorize(
        'repo-override-user',
        'approve_review',
        { targetRepo: 'special-repo' },
        'claude_app',
      );
      expect(decision.granted).toBe(true);
    });

    test('viewer with admin override on admin-repo can kill on that repo', () => {
      const decision = authzEngine.authorize(
        'repo-admin-user',
        'kill',
        { targetRepo: 'admin-repo' },
        'claude_app',
      );
      expect(decision.granted).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Author-of-request special cases (2 assertions)
  // -----------------------------------------------------------------------
  describe('author-of-request special cases', () => {
    test('contributor can cancel own request (requesterId matches userId)', () => {
      const decision = authzEngine.authorize(
        'contributor-user',
        'cancel',
        { requesterId: 'contributor-user' },
        'claude_app',
      );
      expect(decision.granted).toBe(true);
    });

    test('contributor cannot cancel other user\'s request (requesterId differs)', () => {
      const decision = authzEngine.authorize(
        'contributor-user',
        'cancel',
        { requesterId: 'admin-user' },
        'claude_app',
      );
      expect(decision.granted).toBe(false);
    });
  });
});
