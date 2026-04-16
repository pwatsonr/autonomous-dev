/**
 * Unit tests for Thread Conversations, Socket Mode & Platform Rate Limits
 * (SPEC-008-4-04, Tasks 10, 12, 13).
 *
 * Covers all 13 spec test cases:
 *  1.  Thread creation: chat.postMessage called with correct thread_ts and channel.
 *  2.  Thread join: conversations.join called after posting to thread.
 *  3.  Thread reuse: second message uses existing thread_ts, no new thread.
 *  4.  Thread ID persistence: DB has thread_id in conversation_messages and notification_config.
 *  5.  Socket Mode: valid token (xapp-*) succeeds.
 *  6.  Socket Mode: invalid token format (xoxb-*) throws.
 *  7.  Socket Mode: missing token throws.
 *  8.  Socket Mode: slash command routing to command handler.
 *  9.  Socket Mode: interaction routing to interaction handler.
 * 10.  Rate limit: ratelimited error with retry-after header.
 * 11.  Rate limit: missing retry-after defaults to 30s.
 * 12.  Rate limit: non-rate-limit error propagated.
 * 13.  Rate limit: logging at warn level.
 *
 * @module slack_threads_socketmode_ratelimit.test
 */

import {
  SlackAdapter,
  type SlackWebApiClient,
  type SlackClient,
  type SlackConfig,
  type SlackFormatter,
  type SocketModeClient,
} from '../../../adapters/slack/slack_adapter';
import {
  SlackSocketModeAdapter,
  type SocketModeClientInterface,
  type SlackCommandHandler as SocketCommandHandler,
  type SlackInteractionHandler as SocketInteractionHandler,
} from '../../../adapters/slack/slack_socket_mode';
import { SlackRateLimiter } from '../../../adapters/slack/slack_rate_limiter';
import type { Repository, RequestEntity, ConversationMessage } from '../../../db/repository';
import type { SlackIdentityResolver } from '../../../adapters/slack/slack_identity';
import type {
  SlackCommandHandler,
} from '../../../adapters/slack/slack_command_handler';
import type { IncomingCommand, CommandResult } from '../../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockWebApiClient(overrides?: Partial<SlackWebApiClient>): SlackWebApiClient {
  return {
    chat: {
      postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1234567890.123456' }),
      postEphemeral: jest.fn().mockResolvedValue({ ok: true, ts: '1234567890.654321' }),
    },
    conversations: {
      join: jest.fn().mockResolvedValue({ ok: true }),
    },
    ...overrides,
  };
}

function createMockSlackClient(webClient?: SlackWebApiClient): SlackClient {
  const client = webClient ?? createMockWebApiClient();
  return {
    getClient: () => client,
  };
}

function createMockRouter(): { route: jest.Mock } {
  return {
    route: jest.fn().mockResolvedValue({ success: true, data: {} }),
  };
}

function createMockIdentityResolver(): SlackIdentityResolver {
  return {
    resolve: jest.fn().mockResolvedValue('test-user'),
    resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
  } as unknown as SlackIdentityResolver;
}

function createMockFormatter(): SlackFormatter {
  return {
    formatStatusBlocks: jest.fn().mockReturnValue([]),
  };
}

function createMockCommandHandler(): SlackCommandHandler & { handle: jest.Mock } {
  return {
    handle: jest.fn(),
  } as unknown as SlackCommandHandler & { handle: jest.Mock };
}

function createMockConfig(overrides?: Partial<SlackConfig>): SlackConfig {
  return {
    socket_mode: false,
    port: 3000,
    default_timeout_seconds: 3600,
    ...overrides,
  };
}

function createMockDb(overrides?: Partial<Repository>): Repository {
  return {
    insertConversationMessage: jest.fn().mockReturnValue('msg-id-1'),
    getRequest: jest.fn().mockReturnValue({
      request_id: 'REQ-000001',
      notification_config: JSON.stringify({ routes: [] }),
    } as Partial<RequestEntity>),
    updateRequest: jest.fn(),
    getPendingPrompts: jest.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as Repository;
}

function createAdapter(opts?: {
  webClient?: SlackWebApiClient;
  slackClient?: SlackClient;
  router?: { route: jest.Mock };
  identity?: SlackIdentityResolver;
  formatter?: SlackFormatter;
  config?: SlackConfig;
  commandHandler?: SlackCommandHandler;
  db?: Repository;
}): {
  adapter: SlackAdapter;
  webClient: SlackWebApiClient;
  db: Repository;
  router: { route: jest.Mock };
} {
  const webClient = opts?.webClient ?? createMockWebApiClient();
  const slackClient = opts?.slackClient ?? createMockSlackClient(webClient);
  const router = opts?.router ?? createMockRouter();
  const identity = opts?.identity ?? createMockIdentityResolver();
  const formatter = opts?.formatter ?? createMockFormatter();
  const config = opts?.config ?? createMockConfig();
  const commandHandler = opts?.commandHandler ?? createMockCommandHandler();
  const db = opts?.db ?? createMockDb();

  const adapter = new SlackAdapter(
    slackClient,
    router,
    identity,
    formatter,
    config,
    commandHandler,
    db,
  );

  return { adapter, webClient, db, router };
}

// ---------------------------------------------------------------------------
// Socket Mode: mock client factory
// ---------------------------------------------------------------------------

function createMockSocketModeClient(): SocketModeClientInterface & {
  start: jest.Mock;
  disconnect: jest.Mock;
  on: jest.Mock;
  listeners: Map<string, Array<(...args: unknown[]) => void>>;
  emit: (event: string, ...args: unknown[]) => Promise<void>;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const client = {
    start: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) {
        listeners.set(event, []);
      }
      listeners.get(event)!.push(listener);
    }),
    listeners,
    emit: async (event: string, ...args: unknown[]) => {
      const handlers = listeners.get(event) || [];
      for (const handler of handlers) {
        await handler(...args);
      }
    },
  };

  return client;
}

// ===========================================================================
// Test Suite: Thread-Based Clarifying Conversations (Task 10)
// ===========================================================================

describe('Thread-Based Clarifying Conversations (Task 10)', () => {
  // TC 1: Thread creation
  test('TC-1: creates thread via chat.postMessage with correct thread_ts and channel', async () => {
    const { adapter, webClient } = createAdapter();

    const threadTs = await adapter.createClarifyingThread(
      'C12345',
      '1234567890.000001',
      'REQ-000001',
      'What framework do you prefer?',
    );

    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C12345',
      text: 'What framework do you prefer?',
      thread_ts: '1234567890.000001',
    });
    expect(threadTs).toBe('1234567890.123456');
  });

  // TC 2: Thread join
  test('TC-2: calls conversations.join after posting to thread', async () => {
    const { adapter, webClient } = createAdapter();

    await adapter.createClarifyingThread(
      'C12345',
      '1234567890.000001',
      'REQ-000001',
      'Which database?',
    );

    expect(webClient.conversations.join).toHaveBeenCalledWith({
      channel: 'C12345',
    });

    // Ensure join is called after postMessage
    const postMessageOrder = (webClient.chat.postMessage as jest.Mock).mock.invocationCallOrder[0];
    const joinOrder = (webClient.conversations.join as jest.Mock).mock.invocationCallOrder[0];
    expect(joinOrder).toBeGreaterThan(postMessageOrder);
  });

  // TC 3: Thread reuse
  test('TC-3: subsequent messages for the same request reuse existing thread_ts', async () => {
    const { adapter, webClient } = createAdapter();

    // Create thread
    const threadTs = await adapter.createClarifyingThread(
      'C12345',
      '1234567890.000001',
      'REQ-000001',
      'First question?',
    );

    // Send follow-up via sendThreadedReply (reuses thread_ts)
    await adapter.sendThreadedReply('C12345', threadTs, 'Follow-up message');

    // The follow-up should use the same thread_ts
    const secondCall = (webClient.chat.postMessage as jest.Mock).mock.calls[1];
    expect(secondCall[0].thread_ts).toBe(threadTs);

    // conversations.join should NOT be called again
    expect(webClient.conversations.join).toHaveBeenCalledTimes(1);
  });

  // TC 4: Thread ID persistence
  test('TC-4: thread_id persisted in conversation_messages and notification_config', async () => {
    const db = createMockDb();
    const { adapter } = createAdapter({ db });

    const threadTs = await adapter.createClarifyingThread(
      'C12345',
      '1234567890.000001',
      'REQ-000001',
      'Clarifying question',
    );

    // Verify conversation_messages insert
    expect(db.insertConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: 'REQ-000001',
        direction: 'outbound',
        channel: 'slack',
        content: 'Clarifying question',
        message_type: 'clarifying_question',
        responded: 0,
        thread_id: threadTs,
      }),
    );

    // Verify notification_config update
    expect(db.getRequest).toHaveBeenCalledWith('REQ-000001');
    expect(db.updateRequest).toHaveBeenCalledWith('REQ-000001', {
      notification_config: expect.stringContaining(threadTs),
    });

    // Parse the notification_config to verify structure
    const updateCall = (db.updateRequest as jest.Mock).mock.calls[0];
    const updatedConfig = JSON.parse(updateCall[1].notification_config);
    expect(updatedConfig.routes).toContainEqual({
      channelType: 'slack',
      platformChannelId: 'C12345',
      threadId: threadTs,
    });
  });
});

// ===========================================================================
// Test Suite: Socket Mode Fallback (Task 12)
// ===========================================================================

describe('Socket Mode Fallback (Task 12)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // TC 5: Valid token
  test('TC-5: construction succeeds with valid xapp-* token', () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test-123-valid';

    const mockClient = createMockSocketModeClient();
    const mockCommandHandler: SocketCommandHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };
    const mockInteractionHandler: SocketInteractionHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };

    expect(() => {
      new SlackSocketModeAdapter(
        mockCommandHandler,
        mockInteractionHandler,
        () => mockClient,
      );
    }).not.toThrow();
  });

  // TC 6: Invalid token format
  test('TC-6: constructor throws for non-xapp token (xoxb-*)', () => {
    process.env.SLACK_APP_TOKEN = 'xoxb-bot-token-123';

    const mockCommandHandler: SocketCommandHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };
    const mockInteractionHandler: SocketInteractionHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };

    expect(() => {
      new SlackSocketModeAdapter(
        mockCommandHandler,
        mockInteractionHandler,
        () => createMockSocketModeClient(),
      );
    }).toThrow('SLACK_APP_TOKEN must be an app-level token (xapp-*)');
  });

  // TC 7: Missing token
  test('TC-7: constructor throws when SLACK_APP_TOKEN is not set', () => {
    delete process.env.SLACK_APP_TOKEN;

    const mockCommandHandler: SocketCommandHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };
    const mockInteractionHandler: SocketInteractionHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };

    expect(() => {
      new SlackSocketModeAdapter(
        mockCommandHandler,
        mockInteractionHandler,
        () => createMockSocketModeClient(),
      );
    }).toThrow('SLACK_APP_TOKEN environment variable is not set');
  });

  // TC 8: Slash command routing
  test('TC-8: slash_commands event routed to command handler', async () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test-123-valid';

    const mockClient = createMockSocketModeClient();
    const mockCommandHandler: SocketCommandHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };
    const mockInteractionHandler: SocketInteractionHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };

    const adapter = new SlackSocketModeAdapter(
      mockCommandHandler,
      mockInteractionHandler,
      () => mockClient,
    );

    await adapter.start();

    // Simulate a slash_commands event
    const slashCommandBody = {
      command: '/ad-submit',
      text: 'Build auth module',
      user_id: 'U12345',
      channel_id: 'C12345',
    };
    const ackFn = jest.fn().mockResolvedValue(undefined);

    await mockClient.emit('slash_commands', {
      body: slashCommandBody,
      ack: ackFn,
    });

    expect(ackFn).toHaveBeenCalled();
    expect(mockCommandHandler.handleSocketMode).toHaveBeenCalledWith(slashCommandBody);
  });

  // TC 9: Interaction routing
  test('TC-9: interactive event routed to interaction handler', async () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test-123-valid';

    const mockClient = createMockSocketModeClient();
    const mockCommandHandler: SocketCommandHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };
    const mockInteractionHandler: SocketInteractionHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };

    const adapter = new SlackSocketModeAdapter(
      mockCommandHandler,
      mockInteractionHandler,
      () => mockClient,
    );

    await adapter.start();

    // Simulate an interactive event
    const interactionBody = {
      type: 'block_actions',
      actions: [{ action_id: 'prompt_REQ-000001_approve', value: 'approve' }],
      user: { id: 'U12345' },
    };
    const ackFn = jest.fn().mockResolvedValue(undefined);

    await mockClient.emit('interactive', {
      body: interactionBody,
      ack: ackFn,
    });

    expect(ackFn).toHaveBeenCalled();
    expect(mockInteractionHandler.handleSocketMode).toHaveBeenCalledWith(interactionBody);
  });

  // TC bonus: disconnect event is logged
  test('disconnect event is handled without crash', async () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test-123-valid';

    const mockClient = createMockSocketModeClient();
    const mockCommandHandler: SocketCommandHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };
    const mockInteractionHandler: SocketInteractionHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };

    const adapter = new SlackSocketModeAdapter(
      mockCommandHandler,
      mockInteractionHandler,
      () => mockClient,
    );

    await adapter.start();

    // Simulate disconnect -- should not throw
    await expect(mockClient.emit('disconnect')).resolves.not.toThrow();
  });

  // TC bonus: stop() calls disconnect
  test('stop() disconnects the Socket Mode client', async () => {
    process.env.SLACK_APP_TOKEN = 'xapp-test-123-valid';

    const mockClient = createMockSocketModeClient();
    const mockCommandHandler: SocketCommandHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };
    const mockInteractionHandler: SocketInteractionHandler = {
      handleSocketMode: jest.fn().mockResolvedValue(undefined),
    };

    const adapter = new SlackSocketModeAdapter(
      mockCommandHandler,
      mockInteractionHandler,
      () => mockClient,
    );

    await adapter.start();
    await adapter.stop();

    expect(mockClient.disconnect).toHaveBeenCalled();
  });
});

// ===========================================================================
// Test Suite: Platform Rate Limit Handling (Task 13)
// ===========================================================================

describe('Platform Rate Limit Handling (Task 13)', () => {
  /**
   * Subclass that overrides sleep to avoid real delays in tests.
   */
  class TestableRateLimiter extends SlackRateLimiter {
    public sleepCalls: number[] = [];

    protected async sleep(ms: number): Promise<void> {
      this.sleepCalls.push(ms);
      // Do not actually sleep in tests
    }
  }

  /** Build a Slack rate-limit error with the specified retry-after value. */
  function makeRateLimitError(retryAfter?: string): Record<string, unknown> {
    const headers: Record<string, string> = {};
    if (retryAfter !== undefined) {
      headers['retry-after'] = retryAfter;
    }
    return {
      code: 'slack_webapi_platform_error',
      data: {
        error: 'ratelimited',
        headers,
      },
    };
  }

  // TC 10: Rate limit with retry-after
  test('TC-10: retries after Retry-After duration on ratelimited error', async () => {
    const limiter = new TestableRateLimiter();
    let callCount = 0;

    const fn = jest.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw makeRateLimitError('5');
      }
      return 'success';
    });

    const result = await limiter.executeWithRateLimit(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(limiter.sleepCalls).toEqual([5000]); // 5 seconds in ms
  });

  // TC 11: Missing retry-after defaults to 30s
  test('TC-11: defaults to 30s when Retry-After header is missing', async () => {
    const limiter = new TestableRateLimiter();
    let callCount = 0;

    const fn = jest.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw makeRateLimitError(); // No retry-after header
      }
      return 'success';
    });

    const result = await limiter.executeWithRateLimit(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(limiter.sleepCalls).toEqual([30000]); // 30 seconds in ms
  });

  // TC 12: Non-rate-limit error propagated
  test('TC-12: non-rate-limit error is propagated without retry', async () => {
    const limiter = new TestableRateLimiter();

    const serverError = {
      code: 'slack_webapi_platform_error',
      data: {
        error: 'internal_error',
      },
    };

    const fn = jest.fn(async () => {
      throw serverError;
    });

    await expect(limiter.executeWithRateLimit(fn)).rejects.toBe(serverError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(limiter.sleepCalls).toEqual([]); // No sleep for non-rate-limit errors
  });

  // TC 13: Logging at warn level
  test('TC-13: rate limit event logged at warn level', async () => {
    const limiter = new TestableRateLimiter();
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    let callCount = 0;
    const fn = jest.fn(async () => {
      callCount++;
      if (callCount === 1) {
        throw makeRateLimitError('10');
      }
      return 'done';
    });

    await limiter.executeWithRateLimit(fn);

    // Find the warn log entry
    const warnLogs = stderrSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed.level === 'warn' && parsed.msg === 'Slack rate limit hit';
        } catch {
          return false;
        }
      });

    expect(warnLogs.length).toBeGreaterThan(0);
    const logEntry = JSON.parse(warnLogs[0]);
    expect(logEntry.retryAfter).toBe(10);

    stderrSpy.mockRestore();
  });

  // Additional: isRateLimited returns false for null/undefined
  test('isRateLimited returns false for null/undefined', () => {
    const limiter = new TestableRateLimiter();
    expect(limiter.isRateLimited(null)).toBe(false);
    expect(limiter.isRateLimited(undefined)).toBe(false);
    expect(limiter.isRateLimited('string error')).toBe(false);
  });

  // Additional: extractRetryAfter returns default for non-numeric values
  test('extractRetryAfter returns default 30 for invalid header values', () => {
    const limiter = new TestableRateLimiter();

    expect(limiter.extractRetryAfter({
      data: { headers: { 'retry-after': 'not-a-number' } },
    })).toBe(30);

    expect(limiter.extractRetryAfter({
      data: { headers: { 'retry-after': '0' } },
    })).toBe(30);

    expect(limiter.extractRetryAfter({
      data: { headers: { 'retry-after': '-5' } },
    })).toBe(30);
  });

  // Additional: successful call -- no retry
  test('successful call returns immediately without retry', async () => {
    const limiter = new TestableRateLimiter();

    const fn = jest.fn(async () => 'immediate-success');
    const result = await limiter.executeWithRateLimit(fn);

    expect(result).toBe('immediate-success');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(limiter.sleepCalls).toEqual([]);
  });
});
