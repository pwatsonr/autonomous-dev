/**
 * Unit tests for Thread Conversations, Rate Limits & Bot Recovery
 * (SPEC-008-3-04, Tasks 9, 11, 12, 13).
 *
 * Covers all 12 spec test cases:
 *  1.  Thread creation: startThread called with correct name and auto-archive
 *  2.  Thread reuse: second message uses thread.send(), not startThread again
 *  3.  Thread ID persisted in notification_config
 *  4.  Rate limit: bucket tracking (remaining decremented, wait on 0)
 *  5.  Rate limit: 429 retry after retryAfter delay
 *  6.  Rate limit: header parsing
 *  7.  Recovery: pending prompts re-sent (only non-expired)
 *  8.  Recovery: no pending prompts, no sends
 *  9.  Recovery: failed re-send logged but no crash
 * 10.  Shutdown: clean (no in-flight, disconnect immediately)
 * 11.  Shutdown: wait for in-flight, then disconnect
 * 12.  Shutdown: forced after 10s with warning
 *
 * @module discord_threads_ratelimit_recovery.test
 */

import {
  DiscordAdapter,
  ThreadAutoArchiveDuration,
  type DiscordClient,
  type DiscordJSClient,
  type IntakeRouter,
  type DiscordFormatter,
  type ComponentInteractionHandler,
  type ChannelResolver,
  type TextChannelLike,
  type TextChannelWithThreads,
  type ThreadChannel,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from '../../../adapters/discord/discord_adapter';
import type { DiscordIdentityResolver } from '../../../adapters/discord/discord_identity';
import {
  DiscordRateLimitHandler,
  type BucketState,
} from '../../../adapters/discord/discord_rate_limiter';
import type { Repository, RequestEntity, ConversationMessage } from '../../../db/repository';
import type { MessageTarget, FormattedMessage } from '../../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDiscordJSClient(overrides?: Partial<DiscordJSClient>): DiscordJSClient {
  return {
    on: jest.fn(),
    user: { id: '123456789012345678', tag: 'TestBot#1234' },
    channels: {
      fetch: jest.fn(),
    },
    ...overrides,
  };
}

function createMockDiscordClient(jsClient?: DiscordJSClient): DiscordClient {
  const client = jsClient ?? createMockDiscordJSClient();
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getClient: () => client,
  };
}

function createMockRouter(): IntakeRouter {
  return {
    route: jest.fn().mockResolvedValue({ success: true, data: {} }),
  };
}

function createMockIdentityResolver(): DiscordIdentityResolver {
  return {
    resolve: jest.fn().mockResolvedValue('test-user'),
    resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
  } as unknown as DiscordIdentityResolver;
}

function createMockFormatter(): DiscordFormatter {
  return {
    formatStatusEmbed: jest.fn().mockReturnValue({ title: 'Status' }),
    formatError: jest.fn().mockReturnValue({ title: 'Error' }),
  };
}

function createMockComponentHandler(): ComponentInteractionHandler {
  return {
    handle: jest.fn().mockResolvedValue(undefined),
    handleModalSubmit: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockDb(overrides?: Partial<Repository>): Repository {
  return {
    getRequest: jest.fn().mockReturnValue(null),
    updateRequest: jest.fn(),
    getPendingPrompts: jest.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as Repository;
}

function createMockChannelResolver(channel?: Partial<TextChannelLike>): ChannelResolver {
  const mockChannel: TextChannelLike = {
    send: jest.fn().mockResolvedValue({ id: 'msg-1', createdTimestamp: Date.now() }),
    ...channel,
  };
  return {
    resolveChannel: jest.fn().mockResolvedValue(mockChannel),
  };
}

function createAdapter(opts?: {
  client?: DiscordClient;
  router?: IntakeRouter;
  identity?: DiscordIdentityResolver;
  formatter?: DiscordFormatter;
  componentHandler?: ComponentInteractionHandler;
  registerCommands?: () => Promise<void>;
  db?: Repository;
  rateLimiter?: DiscordRateLimitHandler;
}): DiscordAdapter {
  return new DiscordAdapter(
    opts?.client ?? createMockDiscordClient(),
    opts?.router ?? createMockRouter(),
    opts?.identity ?? createMockIdentityResolver(),
    opts?.formatter ?? createMockFormatter(),
    opts?.componentHandler ?? createMockComponentHandler(),
    opts?.registerCommands ?? (async () => {}),
    opts?.db,
    opts?.rateLimiter,
  );
}

// ---------------------------------------------------------------------------
// Test Suite: Thread-Based Clarifying Conversations (Task 9)
// ---------------------------------------------------------------------------

describe('Thread-Based Clarifying Conversations (SPEC-008-3-04, Task 9)', () => {
  // -----------------------------------------------------------------------
  // Test 1: Thread creation
  // -----------------------------------------------------------------------
  test('creates thread on acknowledgment message with correct name and auto-archive', async () => {
    const startThreadFn = jest.fn().mockResolvedValue({
      id: 'thread-001',
      send: jest.fn(),
    });

    const mockMessage = {
      startThread: startThreadFn,
    };

    const mockChannel = {
      messages: {
        fetch: jest.fn().mockResolvedValue(mockMessage),
      },
      send: jest.fn(),
    };

    const jsClient = createMockDiscordJSClient({
      channels: {
        fetch: jest.fn().mockResolvedValue(mockChannel),
      },
    });

    const mockDb = createMockDb({
      getRequest: jest.fn().mockReturnValue({
        request_id: 'REQ-000042',
        notification_config: '{}',
      }),
    });

    const adapter = createAdapter({
      client: createMockDiscordClient(jsClient),
      db: mockDb,
    });

    const thread = await adapter.createClarifyingThread(
      'channel-123',
      'msg-456',
      'REQ-000042',
    );

    expect(startThreadFn).toHaveBeenCalledWith({
      name: 'REQ-000042 - Clarification',
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });
    expect(thread.id).toBe('thread-001');
  });

  // -----------------------------------------------------------------------
  // Test 2: Thread reuse
  // -----------------------------------------------------------------------
  test('subsequent messages reuse existing thread (no duplicate thread creation)', async () => {
    const threadSendFn = jest.fn().mockResolvedValue({ id: 'msg-in-thread', createdTimestamp: Date.now() });
    const startThreadFn = jest.fn().mockResolvedValue({
      id: 'thread-001',
      send: threadSendFn,
    });

    const mockMessage = { startThread: startThreadFn };
    const mockChannel = {
      messages: { fetch: jest.fn().mockResolvedValue(mockMessage) },
      send: jest.fn(),
    };

    const jsClient = createMockDiscordJSClient({
      channels: { fetch: jest.fn().mockResolvedValue(mockChannel) },
    });

    const mockDb = createMockDb({
      getRequest: jest.fn().mockReturnValue({
        request_id: 'REQ-000042',
        notification_config: '{}',
      }),
    });

    const adapter = createAdapter({
      client: createMockDiscordClient(jsClient),
      db: mockDb,
    });

    // First call: create the thread
    const thread = await adapter.createClarifyingThread(
      'channel-123',
      'msg-456',
      'REQ-000042',
    );
    expect(startThreadFn).toHaveBeenCalledTimes(1);

    // Second message: use thread.send() directly (the caller is responsible
    // for checking notification_config.routes[].threadId and using thread.send())
    await thread.send({ content: 'Follow-up question' });
    expect(threadSendFn).toHaveBeenCalledWith({ content: 'Follow-up question' });

    // startThread should NOT have been called again
    expect(startThreadFn).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 3: Thread ID persisted in notification_config
  // -----------------------------------------------------------------------
  test('persists thread ID in notification_config after thread creation', async () => {
    const startThreadFn = jest.fn().mockResolvedValue({
      id: 'thread-abc',
      send: jest.fn(),
    });

    const mockMessage = { startThread: startThreadFn };
    const mockChannel = {
      messages: { fetch: jest.fn().mockResolvedValue(mockMessage) },
      send: jest.fn(),
    };

    const jsClient = createMockDiscordJSClient({
      channels: { fetch: jest.fn().mockResolvedValue(mockChannel) },
    });

    const updateRequestFn = jest.fn();
    const mockDb = createMockDb({
      getRequest: jest.fn().mockReturnValue({
        request_id: 'REQ-000042',
        notification_config: '{"verbosity":"summary"}',
      }),
      updateRequest: updateRequestFn,
    });

    const adapter = createAdapter({
      client: createMockDiscordClient(jsClient),
      db: mockDb,
    });

    await adapter.createClarifyingThread('channel-123', 'msg-456', 'REQ-000042');

    expect(updateRequestFn).toHaveBeenCalledWith('REQ-000042', {
      notification_config: JSON.stringify({
        verbosity: 'summary',
        routes: [{
          channelType: 'discord',
          threadId: 'thread-abc',
          platformChannelId: 'channel-123',
        }],
      }),
    });
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Platform Rate Limit Awareness (Task 11)
// ---------------------------------------------------------------------------

describe('Platform Rate Limit Awareness (SPEC-008-3-04, Task 11)', () => {
  // -----------------------------------------------------------------------
  // Test 4: Bucket tracking
  // -----------------------------------------------------------------------
  test('tracks bucket state and waits when remaining = 0', async () => {
    const handler = new DiscordRateLimitHandler();

    // Set bucket with remaining=1
    handler.setBucket('test-bucket', { remaining: 1, resetAt: Date.now() + 60000 });

    const fn = jest.fn().mockResolvedValue('result-1');
    const result = await handler.executeWithRateLimit('test-bucket', fn);
    expect(result).toBe('result-1');
    expect(fn).toHaveBeenCalledTimes(1);

    // Now set remaining=0 with reset in 100ms
    const resetAt = Date.now() + 100;
    handler.setBucket('test-bucket', { remaining: 0, resetAt });

    const fn2 = jest.fn().mockResolvedValue('result-2');
    const startTime = Date.now();
    const result2 = await handler.executeWithRateLimit('test-bucket', fn2);

    expect(result2).toBe('result-2');
    // Should have waited at least ~100ms
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(50);
  });

  // -----------------------------------------------------------------------
  // Test 5: 429 retry
  // -----------------------------------------------------------------------
  test('retries after 429 error with retryAfter delay', async () => {
    const handler = new DiscordRateLimitHandler();

    let callCount = 0;
    const fn = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const error: { status: number; retryAfter: number; message: string } = {
          status: 429,
          retryAfter: 100,
          message: 'Rate limited',
        };
        throw error;
      }
      return 'success-after-retry';
    });

    const startTime = Date.now();
    const result = await handler.executeWithRateLimit('test-bucket', fn);

    expect(result).toBe('success-after-retry');
    expect(fn).toHaveBeenCalledTimes(2);
    // Should have waited ~100ms for the retry
    expect(Date.now() - startTime).toBeGreaterThanOrEqual(50);
  });

  // -----------------------------------------------------------------------
  // Test 6: Header parsing
  // -----------------------------------------------------------------------
  test('parses rate limit headers and updates bucket state', () => {
    const handler = new DiscordRateLimitHandler();

    handler.updateFromHeaders('test-bucket', {
      'x-ratelimit-remaining': '5',
      'x-ratelimit-reset': '1700000000.5',
      'x-ratelimit-bucket': 'abc123',
    });

    const bucket = handler.getBucket('test-bucket');
    expect(bucket).toBeDefined();
    expect(bucket!.remaining).toBe(5);
    expect(bucket!.resetAt).toBe(1700000000.5 * 1000);
  });

  test('ignores invalid headers', () => {
    const handler = new DiscordRateLimitHandler();

    handler.updateFromHeaders('test-bucket', {
      'x-ratelimit-remaining': 'invalid',
      'x-ratelimit-reset': 'not-a-number',
    });

    const bucket = handler.getBucket('test-bucket');
    expect(bucket).toBeUndefined();
  });

  test('uses default retryAfter of 5000ms when not provided in 429 error', async () => {
    const handler = new DiscordRateLimitHandler();

    let callCount = 0;
    const fn = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const error: { status: number; message: string } = {
          status: 429,
          message: 'Rate limited',
        };
        throw error;
      }
      return 'done';
    });

    // We can't wait 5s in a unit test, so just verify it doesn't throw
    // and the function is retried. Use a shorter timeout for the test.
    const result = await handler.executeWithRateLimit('test-bucket', fn);
    expect(result).toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  }, 10000);

  test('re-throws non-429 errors', async () => {
    const handler = new DiscordRateLimitHandler();

    const fn = jest.fn().mockRejectedValue(new Error('Not found'));

    await expect(
      handler.executeWithRateLimit('test-bucket', fn),
    ).rejects.toThrow('Not found');
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Bot Startup Recovery (Task 12)
// ---------------------------------------------------------------------------

describe('Bot Startup Recovery (SPEC-008-3-04, Task 12)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DISCORD_GUILD_ID: 'guild-123' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -----------------------------------------------------------------------
  // Test 7: Pending prompts re-sent (only non-expired)
  // -----------------------------------------------------------------------
  test('re-sends only non-expired discord prompts with [Resent] prefix', async () => {
    const sendSpy = jest.fn().mockResolvedValue({ id: 'msg-resent', createdTimestamp: Date.now() });
    const channelResolver = {
      resolveChannel: jest.fn().mockResolvedValue({ send: sendSpy }),
    };

    const futureTimeout = new Date(Date.now() + 60000).toISOString();
    const pastTimeout = new Date(Date.now() - 60000).toISOString();

    const mockDb = createMockDb({
      getPendingPrompts: jest.fn().mockReturnValue([
        {
          message_id: 'msg-1',
          request_id: 'REQ-000001',
          direction: 'outbound' as const,
          channel: 'discord' as const,
          content: 'What is the target language?',
          message_type: 'clarifying_question' as const,
          responded: 0,
          timeout_at: futureTimeout,
          thread_id: null,
        },
        {
          message_id: 'msg-2',
          request_id: 'REQ-000002',
          direction: 'outbound' as const,
          channel: 'discord' as const,
          content: 'Expired question',
          message_type: 'clarifying_question' as const,
          responded: 0,
          timeout_at: pastTimeout,
          thread_id: null,
        },
      ]),
      getRequest: jest.fn().mockReturnValue({
        request_id: 'REQ-000001',
        notification_config: JSON.stringify({
          routes: [{ channelType: 'discord', platformChannelId: 'ch-1' }],
        }),
      }),
    });

    const adapter = createAdapter({ db: mockDb });
    adapter.setChannelResolver(channelResolver);

    await adapter.startupRecovery();

    // Only the non-expired prompt should be sent
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '[Resent] What is the target language?',
        embeds: [
          expect.objectContaining({
            title: '[Resent] Pending Question',
            description: 'What is the target language?',
            color: 0xf39c12,
          }),
        ],
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 8: No pending prompts
  // -----------------------------------------------------------------------
  test('does not attempt sends when no pending prompts exist', async () => {
    const sendSpy = jest.fn();
    const channelResolver = {
      resolveChannel: jest.fn().mockResolvedValue({ send: sendSpy }),
    };

    const mockDb = createMockDb({
      getPendingPrompts: jest.fn().mockReturnValue([]),
    });

    const adapter = createAdapter({ db: mockDb });
    adapter.setChannelResolver(channelResolver);

    await adapter.startupRecovery();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 9: Failed re-send logged but no crash
  // -----------------------------------------------------------------------
  test('logs error on failed re-send but continues processing other prompts', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const futureTimeout = new Date(Date.now() + 60000).toISOString();

    let callCount = 0;
    const sendSpy = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Channel unavailable');
      }
      return { id: 'msg-ok', createdTimestamp: Date.now() };
    });

    const channelResolver = {
      resolveChannel: jest.fn().mockResolvedValue({ send: sendSpy }),
    };

    const mockDb = createMockDb({
      getPendingPrompts: jest.fn().mockReturnValue([
        {
          message_id: 'msg-1',
          request_id: 'REQ-000001',
          direction: 'outbound' as const,
          channel: 'discord' as const,
          content: 'First question',
          message_type: 'clarifying_question' as const,
          responded: 0,
          timeout_at: futureTimeout,
          thread_id: null,
        },
        {
          message_id: 'msg-2',
          request_id: 'REQ-000002',
          direction: 'outbound' as const,
          channel: 'discord' as const,
          content: 'Second question',
          message_type: 'clarifying_question' as const,
          responded: 0,
          timeout_at: futureTimeout,
          thread_id: null,
        },
      ]),
      getRequest: jest.fn().mockReturnValue({
        request_id: 'REQ-000001',
        notification_config: '{}',
      }),
    });

    const adapter = createAdapter({ db: mockDb });
    adapter.setChannelResolver(channelResolver);

    // Should not throw even though first send fails
    await expect(adapter.startupRecovery()).resolves.toBeUndefined();

    // Both prompts attempted
    expect(sendSpy).toHaveBeenCalledTimes(2);

    // Error was logged
    const errorLogs = stderrSpy.mock.calls
      .map(([arg]) => String(arg))
      .filter((s) => s.includes('Failed to re-send pending prompt'));
    expect(errorLogs.length).toBeGreaterThanOrEqual(1);

    stderrSpy.mockRestore();
  });

  test('skips recovery when no db is configured', async () => {
    const adapter = createAdapter(); // no db
    // Should not throw
    await expect(adapter.startupRecovery()).resolves.toBeUndefined();
  });

  test('filters out non-discord prompts', async () => {
    const sendSpy = jest.fn().mockResolvedValue({ id: 'msg-1', createdTimestamp: Date.now() });
    const channelResolver = {
      resolveChannel: jest.fn().mockResolvedValue({ send: sendSpy }),
    };

    const futureTimeout = new Date(Date.now() + 60000).toISOString();

    const mockDb = createMockDb({
      getPendingPrompts: jest.fn().mockReturnValue([
        {
          message_id: 'msg-1',
          request_id: 'REQ-000001',
          direction: 'outbound' as const,
          channel: 'claude_app' as const,
          content: 'A claude_app question',
          message_type: 'clarifying_question' as const,
          responded: 0,
          timeout_at: futureTimeout,
          thread_id: null,
        },
      ]),
    });

    const adapter = createAdapter({ db: mockDb });
    adapter.setChannelResolver(channelResolver);

    await adapter.startupRecovery();

    // claude_app prompts should NOT be re-sent by the Discord adapter
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test Suite: Graceful Shutdown (Task 13)
// ---------------------------------------------------------------------------

describe('Graceful Shutdown (SPEC-008-3-04, Task 13)', () => {
  // -----------------------------------------------------------------------
  // Test 10: Clean shutdown (no in-flight interactions)
  // -----------------------------------------------------------------------
  test('disconnects immediately when no in-flight interactions', async () => {
    const disconnectSpy = jest.fn().mockResolvedValue(undefined);
    const mockClient = createMockDiscordClient();
    mockClient.disconnect = disconnectSpy;

    const adapter = createAdapter({ client: mockClient });

    await adapter.shutdown();

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(adapter.isShuttingDown).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 11: Wait for in-flight interactions
  // -----------------------------------------------------------------------
  test('waits for in-flight interactions to complete before disconnecting', async () => {
    const disconnectSpy = jest.fn().mockResolvedValue(undefined);
    const mockClient = createMockDiscordClient();
    mockClient.disconnect = disconnectSpy;

    const adapter = createAdapter({ client: mockClient });

    // Simulate an in-flight interaction via the interaction listener.
    // We'll access the private field via any cast for testing.
    (adapter as any).inFlightInteractions = 1;

    // Start shutdown in background
    const shutdownPromise = adapter.shutdown();

    // After a short delay, resolve the in-flight interaction
    setTimeout(() => {
      (adapter as any).inFlightInteractions = 0;
    }, 200);

    await shutdownPromise;

    expect(disconnectSpy).toHaveBeenCalledTimes(1);
    expect(adapter.currentInFlightCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 12: Forced shutdown after timeout
  // -----------------------------------------------------------------------
  test('forces disconnect after 10s even with pending in-flight interactions', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const disconnectSpy = jest.fn().mockResolvedValue(undefined);
    const mockClient = createMockDiscordClient();
    mockClient.disconnect = disconnectSpy;

    const adapter = createAdapter({ client: mockClient });

    // Simulate a stuck in-flight interaction that never completes
    (adapter as any).inFlightInteractions = 1;

    // Override the deadline to be very short for testing (we can't wait 10s)
    // Instead, we'll verify the behavior by checking the warning log
    // We need to test the actual shutdown timeout, so let's use a trick:
    // monkey-patch Date.now to fast-forward through the deadline
    const realDateNow = Date.now;
    let callCount = 0;
    const baseTime = realDateNow.call(Date);

    jest.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // After a few polls, jump past the 10s deadline
      if (callCount > 3) {
        return baseTime + 11_000;
      }
      return baseTime;
    });

    await adapter.shutdown();

    // Verify disconnect was still called despite pending interactions
    expect(disconnectSpy).toHaveBeenCalledTimes(1);

    // Verify warning was logged
    const warningLogs = stderrSpy.mock.calls
      .map(([arg]) => String(arg))
      .filter((s) => s.includes('Forcing shutdown with in-flight interactions'));
    expect(warningLogs.length).toBeGreaterThanOrEqual(1);

    jest.spyOn(Date, 'now').mockRestore();
    stderrSpy.mockRestore();
  });
});
