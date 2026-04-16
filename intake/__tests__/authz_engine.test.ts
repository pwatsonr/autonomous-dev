/**
 * Unit tests for the RBAC authorization engine (SPEC-008-1-08).
 *
 * Covers:
 *  - Full permission matrix: 4 roles x 12 actions = 48 combinations
 *  - Repo-scoped permission elevation and restriction
 *  - Author-of-request special case for all 5 author-allowed actions
 *  - Review gate approval for designated and non-designated reviewers
 *  - Unknown user returns deny
 *  - 100% of the permission matrix
 *
 * @module authz_engine.test
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  AuthzEngine,
  ROLE_HIERARCHY,
  type AuthConfigUser,
  type Role,
} from '../../authz/authz_engine';
import { AuditLogger } from '../../authz/audit_logger';
import type {
  AuthzAction,
  AuthzContext,
  AuthzDecision,
  ChannelType,
} from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Test configuration YAML
// ---------------------------------------------------------------------------

const TEST_AUTH_CONFIG = `
version: 1
users:
  - internal_id: admin-user
    identities:
      discord_id: "admin-discord"
      slack_id: "admin-slack"
      claude_user: "admin-claude"
    role: admin

  - internal_id: operator-user
    identities:
      discord_id: "operator-discord"
    role: operator

  - internal_id: contributor-user
    identities:
      discord_id: "contributor-discord"
    role: contributor
    repo_permissions:
      "elevated-repo": operator
      "restricted-repo": viewer

  - internal_id: viewer-user
    identities:
      discord_id: "viewer-discord"
    role: viewer
    repo_permissions:
      "elevated-repo": contributor

review_gates:
  security_review:
    reviewers:
      - contributor-user
      - operator-user

rate_limit_overrides:
  admin:
    submissions_per_hour: 100
    queries_per_minute: 200
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpConfigPath: string;
let tmpDir: string;

function createTempConfig(content: string = TEST_AUTH_CONFIG): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'authz-'));
  tmpConfigPath = path.join(tmpDir, 'intake-auth.yaml');
  fs.writeFileSync(tmpConfigPath, content, 'utf-8');
  return tmpConfigPath;
}

function cleanupTempConfig(): void {
  try {
    if (tmpConfigPath) fs.unlinkSync(tmpConfigPath);
    if (tmpDir) fs.rmdirSync(tmpDir);
  } catch {
    // ignore cleanup errors
  }
}

/** Create a mock AuditLogger that records all decisions. */
function createMockAuditLogger(): AuditLogger & { decisions: Array<{ decision: AuthzDecision; resource: string; channel: string }> } {
  const decisions: Array<{ decision: AuthzDecision; resource: string; channel: string }> = [];
  const mockDb = {
    insertAuditLog: jest.fn(),
  };
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const auditLogger = new AuditLogger(mockDb, mockLogger);
  const originalLog = auditLogger.log.bind(auditLogger);
  auditLogger.log = (decision, resource, channel) => {
    decisions.push({ decision, resource, channel: channel as string });
    originalLog(decision, resource, channel);
  };
  return Object.assign(auditLogger, { decisions });
}

// ---------------------------------------------------------------------------
// All actions list
// ---------------------------------------------------------------------------

const ALL_ACTIONS: AuthzAction[] = [
  'status',
  'list',
  'logs',
  'submit',
  'feedback',
  'cancel',
  'pause',
  'resume',
  'priority',
  'approve_review',
  'kill',
  'config_change',
];

/**
 * Expected minimum role per action. Actions below the user's effective role
 * level are denied (unless author-of-request applies).
 */
const ACTION_REQUIRED_ROLE: Record<AuthzAction, Role> = {
  status: 'viewer',
  list: 'viewer',
  logs: 'viewer',
  submit: 'contributor',
  feedback: 'contributor',
  cancel: 'contributor',
  pause: 'contributor',
  resume: 'contributor',
  priority: 'contributor',
  approve_review: 'operator',
  kill: 'admin',
  config_change: 'admin',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AuthzEngine', () => {
  let engine: AuthzEngine;
  let auditLogger: ReturnType<typeof createMockAuditLogger>;

  beforeEach(() => {
    createTempConfig();
    auditLogger = createMockAuditLogger();
    engine = new AuthzEngine(tmpConfigPath, auditLogger);
  });

  afterEach(() => {
    engine.stopWatching();
    cleanupTempConfig();
  });

  // =========================================================================
  // Full permission matrix: 4 roles x 12 actions = 48 combinations
  // =========================================================================

  describe('permission matrix (48 combinations)', () => {
    const roles: Array<{ userId: string; role: Role }> = [
      { userId: 'admin-user', role: 'admin' },
      { userId: 'operator-user', role: 'operator' },
      { userId: 'contributor-user', role: 'contributor' },
      { userId: 'viewer-user', role: 'viewer' },
    ];

    for (const { userId, role } of roles) {
      for (const action of ALL_ACTIONS) {
        const requiredRole = ACTION_REQUIRED_ROLE[action];
        const userLevel = ROLE_HIERARCHY[role];
        const requiredLevel = ROLE_HIERARCHY[requiredRole];
        const shouldGrant = userLevel >= requiredLevel;

        it(`${role} (${userId}) ${shouldGrant ? 'CAN' : 'CANNOT'} ${action}`, () => {
          // For contributor-level author-allowed actions, we pass the user
          // as the author to avoid the "not own request" denial
          const context: AuthzContext & { requesterId?: string } = {};
          if (
            role === 'contributor' &&
            ['cancel', 'pause', 'resume', 'priority', 'feedback'].includes(action) &&
            shouldGrant
          ) {
            context.requesterId = userId;
          }

          const decision = engine.authorize(
            userId,
            action,
            context,
            'discord',
          );
          expect(decision.granted).toBe(shouldGrant);
        });
      }
    }
  });

  // =========================================================================
  // Repo-scoped permission overrides
  // =========================================================================

  describe('repo-scoped permission elevation', () => {
    it('elevates contributor to operator for elevated-repo', () => {
      const decision = engine.authorize(
        'contributor-user',
        'approve_review',
        { targetRepo: 'elevated-repo', requesterId: 'contributor-user' },
        'discord',
      );
      // contributor-user has operator role for elevated-repo, so approve_review is granted
      expect(decision.granted).toBe(true);
      expect(decision.reason).toContain('operator');
    });

    it('elevates viewer to contributor for elevated-repo', () => {
      const decision = engine.authorize(
        'viewer-user',
        'submit',
        { targetRepo: 'elevated-repo' },
        'discord',
      );
      // viewer-user has contributor role for elevated-repo, so submit is granted
      expect(decision.granted).toBe(true);
    });
  });

  describe('repo-scoped permission restriction', () => {
    it('restricts contributor to viewer for restricted-repo', () => {
      const decision = engine.authorize(
        'contributor-user',
        'submit',
        { targetRepo: 'restricted-repo' },
        'discord',
      );
      // contributor-user has viewer role for restricted-repo, so submit is denied
      expect(decision.granted).toBe(false);
    });

    it('viewer-restricted user cannot perform contributor actions in restricted repo', () => {
      const decision = engine.authorize(
        'contributor-user',
        'cancel',
        { targetRepo: 'restricted-repo', requesterId: 'contributor-user' },
        'discord',
      );
      // Effective role is viewer, which is below contributor. Author-of-request
      // requires contributor+ so this is denied.
      expect(decision.granted).toBe(false);
    });
  });

  // =========================================================================
  // Author-of-request special case
  // =========================================================================

  describe('author-of-request special case', () => {
    const authorActions: AuthzAction[] = ['cancel', 'pause', 'resume', 'priority', 'feedback'];

    for (const action of authorActions) {
      it(`contributor CAN ${action} own request (author-of-request)`, () => {
        const decision = engine.authorize(
          'contributor-user',
          action,
          { requesterId: 'contributor-user' },
          'discord',
        );
        expect(decision.granted).toBe(true);
      });

      it(`contributor CANNOT ${action} another user's request`, () => {
        const decision = engine.authorize(
          'contributor-user',
          action,
          { requesterId: 'admin-user' },
          'discord',
        );
        expect(decision.granted).toBe(false);
        expect(decision.reason).toContain('own requests');
      });
    }

    it('operator CAN cancel any request (even non-author)', () => {
      const decision = engine.authorize(
        'operator-user',
        'cancel',
        { requesterId: 'admin-user' },
        'discord',
      );
      expect(decision.granted).toBe(true);
    });

    it('admin CAN cancel any request (even non-author)', () => {
      const decision = engine.authorize(
        'admin-user',
        'cancel',
        { requesterId: 'operator-user' },
        'discord',
      );
      expect(decision.granted).toBe(true);
    });

    it('viewer CANNOT use author-of-request even for own request', () => {
      // The author-of-request special case requires contributor+
      const decision = engine.authorize(
        'viewer-user',
        'cancel',
        { requesterId: 'viewer-user' },
        'discord',
      );
      expect(decision.granted).toBe(false);
    });
  });

  // =========================================================================
  // Review gate designated reviewer
  // =========================================================================

  describe('review gate approval', () => {
    it('designated reviewer (contributor-user) CAN approve_review for security_review gate', () => {
      const decision = engine.authorize(
        'contributor-user',
        'approve_review',
        { gate: 'security_review' },
        'discord',
      );
      expect(decision.granted).toBe(true);
      expect(decision.reason).toContain('Designated reviewer');
    });

    it('designated reviewer (operator-user) CAN approve_review for security_review gate', () => {
      const decision = engine.authorize(
        'operator-user',
        'approve_review',
        { gate: 'security_review' },
        'discord',
      );
      // operator meets base role (operator) so it's granted via base permission
      expect(decision.granted).toBe(true);
    });

    it('non-designated reviewer (viewer-user) CANNOT approve_review even with gate', () => {
      const decision = engine.authorize(
        'viewer-user',
        'approve_review',
        { gate: 'security_review' },
        'discord',
      );
      expect(decision.granted).toBe(false);
    });

    it('non-designated reviewer (admin-user) CAN approve_review via base role (admin >= operator)', () => {
      const decision = engine.authorize(
        'admin-user',
        'approve_review',
        { gate: 'security_review' },
        'discord',
      );
      expect(decision.granted).toBe(true);
    });

    it('approve_review without gate context uses base role check', () => {
      const decision = engine.authorize(
        'contributor-user',
        'approve_review',
        {},
        'discord',
      );
      // contributor < operator, so denied
      expect(decision.granted).toBe(false);
    });

    it('unknown gate falls through to base role check', () => {
      const decision = engine.authorize(
        'contributor-user',
        'approve_review',
        { gate: 'nonexistent_gate' },
        'discord',
      );
      expect(decision.granted).toBe(false);
    });
  });

  // =========================================================================
  // Unknown user
  // =========================================================================

  describe('unknown user', () => {
    it('returns deny for unknown user', () => {
      const decision = engine.authorize(
        'nonexistent-user',
        'status',
        {},
        'discord',
      );
      expect(decision.granted).toBe(false);
      expect(decision.reason).toContain('User not found');
    });

    it('deny decision includes correct userId and action', () => {
      const decision = engine.authorize(
        'ghost-user',
        'submit',
        {},
        'slack',
      );
      expect(decision.userId).toBe('ghost-user');
      expect(decision.action).toBe('submit');
      expect(decision.granted).toBe(false);
    });
  });

  // =========================================================================
  // User resolution
  // =========================================================================

  describe('resolveUserId()', () => {
    it('resolves discord_id to internal_id', () => {
      expect(engine.resolveUserId('discord_id', 'admin-discord')).toBe('admin-user');
    });

    it('resolves slack_id to internal_id', () => {
      expect(engine.resolveUserId('slack_id', 'admin-slack')).toBe('admin-user');
    });

    it('resolves claude_user to internal_id', () => {
      expect(engine.resolveUserId('claude_user', 'admin-claude')).toBe('admin-user');
    });

    it('returns undefined for unknown platform ID', () => {
      expect(engine.resolveUserId('discord_id', 'nonexistent')).toBeUndefined();
    });
  });

  // =========================================================================
  // findUser()
  // =========================================================================

  describe('findUser()', () => {
    it('returns user for known internal_id', () => {
      const user = engine.findUser('admin-user');
      expect(user).toBeDefined();
      expect(user!.role).toBe('admin');
    });

    it('returns undefined for unknown internal_id', () => {
      expect(engine.findUser('nonexistent')).toBeUndefined();
    });
  });

  // =========================================================================
  // Audit trail
  // =========================================================================

  describe('audit logging', () => {
    it('every authorize call is logged', () => {
      engine.authorize('admin-user', 'status', {}, 'discord');
      expect(auditLogger.decisions.length).toBe(1);
      expect(auditLogger.decisions[0].decision.granted).toBe(true);
    });

    it('denied decision is logged', () => {
      engine.authorize('viewer-user', 'kill', {}, 'discord');
      const last = auditLogger.decisions[auditLogger.decisions.length - 1];
      expect(last.decision.granted).toBe(false);
    });
  });

  // =========================================================================
  // getConfig()
  // =========================================================================

  describe('getConfig()', () => {
    it('returns the current config with users array', () => {
      const config = engine.getConfig();
      expect(config.users).toHaveLength(4);
      expect(config.version).toBe(1);
    });

    it('contains rate_limit_overrides', () => {
      const config = engine.getConfig();
      expect(config.rate_limit_overrides?.admin?.submissions_per_hour).toBe(100);
    });
  });
});
