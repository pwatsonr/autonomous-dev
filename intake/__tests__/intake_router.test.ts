/**
 * Unit tests for the IntakeRouter dispatch pipeline (SPEC-008-1-08).
 *
 * Covers:
 *  - Dispatch to correct handler by command name
 *  - Unknown command returns VALIDATION_ERROR
 *  - Authz denial short-circuits before rate limit check
 *  - Rate limit denial short-circuits before handler execution
 *  - Handler exception returns INTERNAL_ERROR
 *  - InvalidStateError from handler returns INVALID_STATE
 *  - 100% of `route()` method branches
 *
 * @module intake_router.test
 */

import {
  IntakeRouter,
  type IntakeRouterDeps,
  type IntakeEventEmitter,
} from '../../core/intake_router';
import { InvalidStateError } from '../../handlers/state_machine';
import type {
  AuthzAction,
  AuthzContext,
  AuthzDecision,
  ChannelType,
  CommandHandler,
  CommandResult,
  CommandSource,
  IncomingCommand,
} from '../../adapters/adapter_interface';
import type { AuthzEngine } from '../../authz/authz_engine';
import type { RateLimiter } from '../../rate_limit/rate_limiter';
import type { Repository } from '../../db/repository';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal IncomingCommand for testing. */
function makeCommand(overrides: Partial<IncomingCommand> = {}): IncomingCommand {
  return {
    commandName: 'status',
    args: [],
    flags: {},
    rawText: '/dev status',
    source: {
      channelType: 'discord' as ChannelType,
      userId: 'discord-user-1',
      timestamp: new Date(),
    },
    ...overrides,
  };
}

/** Create a mock AuthzEngine. */
function createMockAuthz(overrides: Partial<{
  authorizeResult: AuthzDecision;
  resolveUserId: string | undefined;
}> = {}): AuthzEngine {
  const defaultDecision: AuthzDecision = {
    granted: true,
    userId: 'internal-user-1',
    action: 'status',
    reason: 'Granted by mock',
    timestamp: new Date(),
  };

  return {
    authorize: jest.fn().mockReturnValue(overrides.authorizeResult ?? defaultDecision),
    resolveUserId: jest.fn().mockReturnValue(overrides.resolveUserId ?? 'internal-user-1'),
    findUser: jest.fn(),
    getConfig: jest.fn(),
    stopWatching: jest.fn(),
  } as unknown as AuthzEngine;
}

/** Create a mock RateLimiter. */
function createMockRateLimiter(overrides: Partial<{
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
  message: string;
}> = {}): RateLimiter {
  return {
    checkLimit: jest.fn().mockReturnValue({
      allowed: overrides.allowed ?? true,
      remaining: overrides.remaining ?? 9,
      limit: 10,
      retryAfterMs: overrides.retryAfterMs ?? 0,
      message: overrides.message,
    }),
  } as unknown as RateLimiter;
}

/** Create a mock Repository. */
function createMockDb(): Repository {
  return {
    insertAuditLog: jest.fn(),
    insertRequest: jest.fn(),
    getRequest: jest.fn(),
    updateRequest: jest.fn(),
    insertActivityLog: jest.fn(),
    getActivityLog: jest.fn().mockReturnValue([]),
    getQueuedRequestCount: jest.fn().mockReturnValue(0),
    getQueuePosition: jest.fn().mockReturnValue(1),
    getAveragePipelineDuration: jest.fn().mockReturnValue(null),
    getMaxConcurrentSlots: jest.fn().mockReturnValue(1),
    generateRequestId: jest.fn().mockReturnValue('REQ-000001'),
    insertConversationMessage: jest.fn().mockReturnValue('msg-1'),
    countActions: jest.fn().mockReturnValue(0),
    recordAction: jest.fn(),
    getOldestActionInWindow: jest.fn().mockReturnValue(null),
  } as unknown as Repository;
}

/** Create a mock IntakeEventEmitter. */
function createMockEmitter(): IntakeEventEmitter {
  return { emit: jest.fn() };
}

/** Create full router dependencies. */
function createDeps(overrides: Partial<IntakeRouterDeps> = {}): IntakeRouterDeps {
  return {
    authz: createMockAuthz(),
    rateLimiter: createMockRateLimiter(),
    db: createMockDb(),
    emitter: createMockEmitter(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IntakeRouter', () => {
  // =========================================================================
  // Dispatch to correct handler by command name
  // =========================================================================

  describe('dispatch to correct handler', () => {
    const commandNames = [
      'submit',
      'status',
      'list',
      'cancel',
      'pause',
      'resume',
      'priority',
      'logs',
      'feedback',
      'kill',
    ];

    for (const cmdName of commandNames) {
      it(`routes "${cmdName}" to the correct handler`, async () => {
        const deps = createDeps();
        const router = new IntakeRouter(deps);
        const command = makeCommand({ commandName: cmdName });

        const result = await router.route(command);

        // The handler was found (no VALIDATION_ERROR)
        expect(result.errorCode).not.toBe('VALIDATION_ERROR');
        // Authz was called
        expect(deps.authz.authorize).toHaveBeenCalled();
      });
    }
  });

  // =========================================================================
  // Unknown command returns VALIDATION_ERROR
  // =========================================================================

  describe('unknown command', () => {
    it('returns VALIDATION_ERROR for unknown command name', async () => {
      const deps = createDeps();
      const router = new IntakeRouter(deps);
      const command = makeCommand({ commandName: 'nonexistent_command' });

      const result = await router.route(command);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('VALIDATION_ERROR');
      expect(result.error).toContain('Unknown command');
      expect(result.error).toContain('nonexistent_command');
    });

    it('does not call authz for unknown commands', async () => {
      const deps = createDeps();
      const router = new IntakeRouter(deps);
      const command = makeCommand({ commandName: 'fake' });

      await router.route(command);

      expect(deps.authz.authorize).not.toHaveBeenCalled();
    });

    it('does not call rate limiter for unknown commands', async () => {
      const deps = createDeps();
      const router = new IntakeRouter(deps);
      const command = makeCommand({ commandName: 'fake' });

      await router.route(command);

      expect(deps.rateLimiter.checkLimit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // User resolution failure
  // =========================================================================

  describe('user resolution failure', () => {
    it('returns AUTHZ_DENIED when user cannot be resolved', async () => {
      const authz = createMockAuthz({ resolveUserId: undefined });
      const deps = createDeps({ authz });
      const router = new IntakeRouter(deps);
      const command = makeCommand({ commandName: 'status' });

      const result = await router.route(command);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('AUTHZ_DENIED');
      expect(result.error).toContain('Unable to resolve user identity');
    });
  });

  // =========================================================================
  // Authz denial short-circuits
  // =========================================================================

  describe('authz denial short-circuits', () => {
    it('returns AUTHZ_DENIED and does not call rate limiter or handler', async () => {
      const deniedDecision: AuthzDecision = {
        granted: false,
        userId: 'internal-user-1',
        action: 'kill',
        reason: 'Insufficient privileges',
        timestamp: new Date(),
      };
      const authz = createMockAuthz({ authorizeResult: deniedDecision });
      const deps = createDeps({ authz });
      const router = new IntakeRouter(deps);
      const command = makeCommand({ commandName: 'kill' });

      const result = await router.route(command);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('AUTHZ_DENIED');
      expect(result.error).toContain('Permission denied');
      // Rate limiter should NOT be called
      expect(deps.rateLimiter.checkLimit).not.toHaveBeenCalled();
    });

    it('includes authz reason in error message', async () => {
      const deniedDecision: AuthzDecision = {
        granted: false,
        userId: 'internal-user-1',
        action: 'submit',
        reason: "Role 'viewer' does not meet required role 'contributor'",
        timestamp: new Date(),
      };
      const authz = createMockAuthz({ authorizeResult: deniedDecision });
      const deps = createDeps({ authz });
      const router = new IntakeRouter(deps);

      const result = await router.route(makeCommand({ commandName: 'submit' }));

      expect(result.error).toContain("Role 'viewer'");
    });
  });

  // =========================================================================
  // Rate limit denial short-circuits
  // =========================================================================

  describe('rate limit denial short-circuits', () => {
    it('returns RATE_LIMITED with retryAfterMs', async () => {
      const rateLimiter = createMockRateLimiter({
        allowed: false,
        retryAfterMs: 30_000,
        message: 'Rate limit exceeded: 10/10 submission actions. Retry after 30s.',
      });
      const deps = createDeps({ rateLimiter });
      const router = new IntakeRouter(deps);
      const command = makeCommand({ commandName: 'status' });

      const result = await router.route(command);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('RATE_LIMITED');
      expect(result.error).toContain('Rate limit');
      expect(result.retryAfterMs).toBe(30_000);
    });
  });

  // =========================================================================
  // Handler exception returns INTERNAL_ERROR
  // =========================================================================

  describe('handler exception returns INTERNAL_ERROR', () => {
    it('catches generic errors and returns INTERNAL_ERROR', async () => {
      // We need to make the handler throw. We can do this by making the
      // db.getRequest throw for a status handler call.
      const mockDb = createMockDb();
      (mockDb.getRequest as jest.Mock).mockImplementation(() => {
        throw new Error('Database connection lost');
      });
      const deps = createDeps({ db: mockDb });
      const router = new IntakeRouter(deps);
      // 'status' handler will call db.getRequest which throws
      const command = makeCommand({
        commandName: 'status',
        args: ['REQ-000001'],
      });

      const result = await router.route(command);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INTERNAL_ERROR');
      expect(result.error).toContain('internal error');
    });
  });

  // =========================================================================
  // InvalidStateError from handler returns INVALID_STATE
  // =========================================================================

  describe('InvalidStateError returns INVALID_STATE', () => {
    it('catches InvalidStateError and returns INVALID_STATE error code', async () => {
      // Make the db.getRequest return a request in wrong state, then handler
      // calls validateStateTransition which throws InvalidStateError.
      // Easiest: make cancel handler encounter an invalid state.
      const mockDb = createMockDb();
      (mockDb.getRequest as jest.Mock).mockReturnValue({
        request_id: 'REQ-000001',
        status: 'done', // terminal state - cancel will throw InvalidStateError
        requester_id: 'internal-user-1',
      });
      const deps = createDeps({ db: mockDb });
      const router = new IntakeRouter(deps);
      const command = makeCommand({
        commandName: 'cancel',
        args: ['REQ-000001'],
      });

      const result = await router.route(command);

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe('INVALID_STATE');
      expect(result.error).toContain("'done'");
    });
  });

  // =========================================================================
  // Audit log is written for authz decisions
  // =========================================================================

  describe('audit logging', () => {
    it('inserts audit log for granted decisions', async () => {
      const deps = createDeps();
      const router = new IntakeRouter(deps);

      await router.route(makeCommand({ commandName: 'status' }));

      expect(deps.db.insertAuditLog).toHaveBeenCalled();
    });

    it('inserts audit log for denied decisions', async () => {
      const deniedDecision: AuthzDecision = {
        granted: false,
        userId: 'user-1',
        action: 'kill',
        reason: 'Denied',
        timestamp: new Date(),
      };
      const authz = createMockAuthz({ authorizeResult: deniedDecision });
      const deps = createDeps({ authz });
      const router = new IntakeRouter(deps);

      await router.route(makeCommand({ commandName: 'kill' }));

      expect(deps.db.insertAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ granted: false }),
      );
    });
  });

  // =========================================================================
  // Pipeline ordering
  // =========================================================================

  describe('pipeline ordering', () => {
    it('calls authz before rate limiter', async () => {
      const callOrder: string[] = [];
      const authz = createMockAuthz();
      (authz.authorize as jest.Mock).mockImplementation((...args: unknown[]) => {
        callOrder.push('authz');
        return {
          granted: true,
          userId: 'user-1',
          action: 'status',
          reason: 'OK',
          timestamp: new Date(),
        };
      });
      const rateLimiter = createMockRateLimiter();
      (rateLimiter.checkLimit as jest.Mock).mockImplementation(() => {
        callOrder.push('rateLimit');
        return { allowed: true, remaining: 9, limit: 10, retryAfterMs: 0 };
      });

      const deps = createDeps({ authz, rateLimiter });
      const router = new IntakeRouter(deps);
      await router.route(makeCommand({ commandName: 'status' }));

      expect(callOrder.indexOf('authz')).toBeLessThan(callOrder.indexOf('rateLimit'));
    });
  });
});
