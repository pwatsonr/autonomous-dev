/**
 * Unit tests for SlackInteractionHandler (SPEC-008-4-03, Task 8).
 *
 * Covers spec test cases 12-14:
 * 12. Interaction handler: block_actions routing (kill_confirm -> kill handler)
 * 13. Interaction handler: unauthorized (non-admin clicks kill_confirm -> ephemeral "Permission denied")
 * 14. Interaction handler: view_submission (submit_modal -> fields extracted and routed to submit)
 *
 * @module slack_interaction_handler.test
 */

import {
  SlackInteractionHandler,
  type IntakeRouter,
  type SlackWebClient,
  type ExpressRequest,
  type ExpressResponse,
} from '../../../adapters/slack/slack_interaction_handler';
import type { SlackIdentityResolver } from '../../../adapters/slack/slack_identity';
import type { AuthzEngine } from '../../../authz/authz_engine';
import type { IncomingCommand, CommandResult } from '../../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockRouter(
  result: Partial<CommandResult> = { success: true, data: { requestId: 'REQ-000001' } },
): IntakeRouter & { lastCommand?: IncomingCommand } {
  const mock: IntakeRouter & { lastCommand?: IncomingCommand } = {
    async route(command: IncomingCommand): Promise<CommandResult> {
      mock.lastCommand = command;
      return { success: true, data: { requestId: 'REQ-000001' }, ...result } as CommandResult;
    },
  };
  return mock;
}

function createMockIdentityResolver(userId: string = 'user-admin'): SlackIdentityResolver {
  return {
    resolve: jest.fn().mockResolvedValue(userId),
    resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
  } as unknown as SlackIdentityResolver;
}

function createMockAuthz(granted: boolean = true): AuthzEngine {
  return {
    authorize: jest.fn().mockReturnValue({
      granted,
      userId: 'user-admin',
      action: 'kill',
      reason: granted ? 'Admin role' : 'Insufficient permissions',
      timestamp: new Date(),
    }),
  } as unknown as AuthzEngine;
}

function createMockWebClient(): SlackWebClient & {
  ephemeralCalls: Array<{ channel: string; user: string; text: string }>;
  viewsOpenCalls: Array<{ trigger_id: string; view: Record<string, unknown> }>;
} {
  const mock = {
    ephemeralCalls: [] as Array<{ channel: string; user: string; text: string }>,
    viewsOpenCalls: [] as Array<{ trigger_id: string; view: Record<string, unknown> }>,
    chat: {
      async postEphemeral(params: { channel: string; user: string; text: string }) {
        mock.ephemeralCalls.push(params);
        return { ok: true };
      },
    },
    views: {
      async open(params: { trigger_id: string; view: Record<string, unknown> }) {
        mock.viewsOpenCalls.push(params);
        return { ok: true };
      },
    },
  };
  return mock;
}

function createMockExpressResponse(): ExpressResponse & { statusCode?: number; sentBody?: string } {
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

function createBlockActionsRequest(payload: Record<string, unknown>): ExpressRequest {
  return {
    body: {
      payload: JSON.stringify(payload),
    },
  };
}

function createURLSearchParamsRequest(payload: Record<string, unknown>): ExpressRequest {
  const params = new URLSearchParams();
  params.set('payload', JSON.stringify(payload));
  return { body: params };
}

// Suppress stderr logging during tests
const originalStderr = process.stderr.write;
beforeAll(() => {
  process.stderr.write = jest.fn() as unknown as typeof process.stderr.write;
});
afterAll(() => {
  process.stderr.write = originalStderr;
});

// Mock global fetch
const mockFetch = jest.fn().mockResolvedValue({ ok: true });
global.fetch = mockFetch as unknown as typeof fetch;

beforeEach(() => {
  mockFetch.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackInteractionHandler (SPEC-008-4-03, Task 8)', () => {
  // -----------------------------------------------------------------------
  // Test 12: block_actions routing (kill_confirm)
  // -----------------------------------------------------------------------
  describe('block_actions: kill_confirm', () => {
    test('authorized admin clicks kill_confirm -> router called with kill CONFIRM', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver('user-admin');
      const authz = createMockAuthz(true);
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'block_actions',
        actions: [{ action_id: 'kill_confirm' }],
        user: { id: 'slack-user-123' },
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.com/actions/response',
      });

      await handler.handle(req, res);

      // Should acknowledge immediately
      expect(res.statusCode).toBe(200);

      // Identity resolver should be called
      expect(identity.resolve).toHaveBeenCalledWith('slack-user-123');

      // Authz should be checked
      expect(authz.authorize).toHaveBeenCalledWith('user-admin', 'kill', {}, 'slack');

      // Router should receive kill CONFIRM command
      expect(router.lastCommand).toBeDefined();
      expect(router.lastCommand!.commandName).toBe('kill');
      expect(router.lastCommand!.args).toEqual(['CONFIRM']);
      expect(router.lastCommand!.rawText).toBe('kill CONFIRM');
      expect(router.lastCommand!.source.channelType).toBe('slack');

      // Response URL should be posted to
      expect(mockFetch).toHaveBeenCalledWith(
        'https://hooks.slack.com/actions/response',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    // Test 13: unauthorized kill_confirm -> ephemeral "Permission denied"
    test('non-admin clicks kill_confirm -> ephemeral "Permission denied" via chat.postEphemeral', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver('user-viewer');
      const authz = createMockAuthz(false); // denied
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'block_actions',
        actions: [{ action_id: 'kill_confirm' }],
        user: { id: 'slack-user-456' },
        channel: { id: 'C456' },
        response_url: 'https://hooks.slack.com/actions/response',
      });

      await handler.handle(req, res);

      expect(res.statusCode).toBe(200);

      // Ephemeral "Permission denied." should be sent
      expect(web.ephemeralCalls).toHaveLength(1);
      expect(web.ephemeralCalls[0].channel).toBe('C456');
      expect(web.ephemeralCalls[0].user).toBe('slack-user-456');
      expect(web.ephemeralCalls[0].text).toBe('Permission denied.');

      // Router should NOT be called
      expect(router.lastCommand).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // block_actions: kill_cancel
  // -----------------------------------------------------------------------
  describe('block_actions: kill_cancel', () => {
    test('kill_cancel posts "Kill cancelled." to response URL', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver();
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'block_actions',
        actions: [{ action_id: 'kill_cancel' }],
        user: { id: 'slack-user-123' },
        response_url: 'https://hooks.slack.com/actions/response',
      });

      await handler.handle(req, res);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.text).toBe('Kill cancelled.');
    });
  });

  // -----------------------------------------------------------------------
  // block_actions: cancel_confirm_{requestId}
  // -----------------------------------------------------------------------
  describe('block_actions: cancel_confirm', () => {
    test('cancel_confirm_REQ-000042 routes cancel command with request ID', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver('user-contributor');
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'block_actions',
        actions: [{ action_id: 'cancel_confirm_REQ-000042' }],
        user: { id: 'slack-user-123' },
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.com/actions/response',
      });

      await handler.handle(req, res);

      expect(router.lastCommand).toBeDefined();
      expect(router.lastCommand!.commandName).toBe('cancel');
      expect(router.lastCommand!.args).toEqual(['REQ-000042', 'CONFIRM']);
      expect(router.lastCommand!.rawText).toBe('cancel REQ-000042 CONFIRM');
    });
  });

  // -----------------------------------------------------------------------
  // block_actions: cancel_cancel_{requestId}
  // -----------------------------------------------------------------------
  describe('block_actions: cancel_cancel', () => {
    test('cancel_cancel posts "Cancel aborted." to response URL', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver();
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'block_actions',
        actions: [{ action_id: 'cancel_cancel_REQ-000042' }],
        user: { id: 'slack-user-123' },
        response_url: 'https://hooks.slack.com/actions/response',
      });

      await handler.handle(req, res);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.text).toBe('Cancel aborted.');
    });
  });

  // -----------------------------------------------------------------------
  // Test 14: view_submission routing (submit_modal)
  // -----------------------------------------------------------------------
  describe('view_submission: submit_modal', () => {
    test('submit_modal extracts fields and routes as submit command', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver('user-contributor');
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'view_submission',
        user: { id: 'slack-user-789' },
        view: {
          callback_id: 'submit_modal',
          state: {
            values: {
              description_block: {
                description: { value: 'Build a new authentication service' },
              },
              repo_block: {
                repo: { value: 'org/auth-service' },
              },
              criteria_block: {
                acceptance_criteria: { value: 'Must pass all security tests' },
              },
            },
          },
        },
      });

      await handler.handle(req, res);

      expect(res.statusCode).toBe(200);
      expect(identity.resolve).toHaveBeenCalledWith('slack-user-789');

      expect(router.lastCommand).toBeDefined();
      expect(router.lastCommand!.commandName).toBe('submit');
      expect(router.lastCommand!.args).toEqual(['Build a new authentication service']);
      expect(router.lastCommand!.flags).toEqual({
        repo: 'org/auth-service',
        acceptance_criteria: 'Must pass all security tests',
      });
      expect(router.lastCommand!.rawText).toBe('Build a new authentication service');
      expect(router.lastCommand!.source.channelType).toBe('slack');
      expect(router.lastCommand!.source.userId).toBe('user-contributor');
    });

    test('submit_modal with only description (optional fields empty)', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver('user-contributor');
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'view_submission',
        user: { id: 'slack-user-789' },
        view: {
          callback_id: 'submit_modal',
          state: {
            values: {
              description_block: {
                description: { value: 'Simple feature request' },
              },
              repo_block: {
                repo: { value: null },
              },
              criteria_block: {
                acceptance_criteria: { value: null },
              },
            },
          },
        },
      });

      await handler.handle(req, res);

      expect(router.lastCommand).toBeDefined();
      expect(router.lastCommand!.commandName).toBe('submit');
      expect(router.lastCommand!.args).toEqual(['Simple feature request']);
      // Optional fields should not be in flags
      expect(router.lastCommand!.flags).toEqual({});
    });
  });

  // -----------------------------------------------------------------------
  // Shortcut handling
  // -----------------------------------------------------------------------
  describe('shortcut: submit_request', () => {
    test('submit_request shortcut opens submit modal via views.open', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver();
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'shortcut',
        trigger_id: 'trigger-xyz-789',
        user: { id: 'slack-user-123' },
        callback_id: 'submit_request',
      });

      await handler.handle(req, res);

      expect(res.statusCode).toBe(200);
      expect(web.viewsOpenCalls).toHaveLength(1);
      expect(web.viewsOpenCalls[0].trigger_id).toBe('trigger-xyz-789');
    });
  });

  // -----------------------------------------------------------------------
  // Payload extraction
  // -----------------------------------------------------------------------
  describe('payload extraction', () => {
    test('handles URLSearchParams body format', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver();
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createURLSearchParamsRequest({
        type: 'block_actions',
        actions: [{ action_id: 'kill_cancel' }],
        user: { id: 'slack-user-123' },
        response_url: 'https://hooks.slack.com/actions/response',
      });

      await handler.handle(req, res);

      expect(res.statusCode).toBe(200);
      expect(mockFetch).toHaveBeenCalled();
    });

    test('handles missing payload gracefully', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver();
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req: ExpressRequest = { body: {} as URLSearchParams };

      await handler.handle(req, res);

      // Should acknowledge but do nothing
      expect(res.statusCode).toBe(200);
      expect(router.lastCommand).toBeUndefined();
    });

    test('handles invalid JSON payload gracefully', async () => {
      const router = createMockRouter();
      const identity = createMockIdentityResolver();
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req: ExpressRequest = {
        body: { payload: 'not valid json {{{' },
      };

      await handler.handle(req, res);

      expect(res.statusCode).toBe(200);
      expect(router.lastCommand).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------
  describe('error handling', () => {
    test('unresolvable user identity posts error to response URL', async () => {
      const router = createMockRouter();
      const identity = {
        resolve: jest.fn().mockRejectedValue(new Error('User not provisioned')),
        resolveDisplayName: jest.fn(),
      } as unknown as SlackIdentityResolver;
      const authz = createMockAuthz();
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'block_actions',
        actions: [{ action_id: 'kill_confirm' }],
        user: { id: 'unknown-slack-user' },
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.com/actions/response',
      });

      await handler.handle(req, res);

      expect(res.statusCode).toBe(200);
      // Should post error to response URL
      expect(mockFetch).toHaveBeenCalled();
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.text).toBe('User not authorized.');
    });

    test('router failure posts error to response URL', async () => {
      const router = createMockRouter({ success: false, error: 'Kill failed' });
      const identity = createMockIdentityResolver();
      const authz = createMockAuthz(true);
      const web = createMockWebClient();

      const handler = new SlackInteractionHandler(router, identity, authz, web);
      const res = createMockExpressResponse();

      const req = createBlockActionsRequest({
        type: 'block_actions',
        actions: [{ action_id: 'kill_confirm' }],
        user: { id: 'slack-user-123' },
        channel: { id: 'C123' },
        response_url: 'https://hooks.slack.com/actions/response',
      });

      await handler.handle(req, res);

      expect(mockFetch).toHaveBeenCalled();
      const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(fetchBody.text).toContain('Error:');
    });
  });
});
