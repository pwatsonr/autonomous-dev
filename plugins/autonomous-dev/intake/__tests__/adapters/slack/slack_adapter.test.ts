/**
 * Unit tests for SlackAdapter: start, sendMessage, promptUser, shutdown,
 * and startup recovery (SPEC-008-4-05, Tasks 14-16).
 *
 * Test cases (8 total):
 *  1. start() starts HTTP server (mock server).
 *  2. start() with Socket Mode config starts Socket Mode client.
 *  3. sendMessage() calls chat.postMessage with correct params.
 *  4. sendMessage() calls chat.postEphemeral for DM target.
 *  5. sendMessage() includes thread_ts for threaded messages.
 *  6. promptUser() sends prompt and resolves on interaction response.
 *  7. promptUser() resolves with TimeoutExpired on timeout.
 *  8. shutdown() stops server and clears pending prompts.
 *
 * @module slack_adapter.test
 */

import {
  SlackAdapter,
  type SlackWebApiClient,
  type SlackClient,
  type SlackConfig,
  type SlackFormatter,
  type SlackServer,
  type SlackServerFactory,
  type SocketModeClient,
  type SocketModeClientFactory,
} from '../../../adapters/slack/slack_adapter';
import type { SlackIdentityResolver } from '../../../adapters/slack/slack_identity';
import type { SlackCommandHandler } from '../../../adapters/slack/slack_command_handler';
import type { Repository } from '../../../db/repository';
import type {
  IncomingCommand,
  CommandResult,
  TimeoutExpired,
} from '../../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockWebApiClient(): SlackWebApiClient {
  return {
    chat: {
      postMessage: jest.fn().mockResolvedValue({ ok: true, ts: '1234567890.123456' }),
      postEphemeral: jest.fn().mockResolvedValue({ ok: true, ts: '1234567890.654321' }),
    },
    conversations: {
      join: jest.fn().mockResolvedValue({ ok: true }),
    },
  };
}

function createMockSlackClient(webClient?: SlackWebApiClient): SlackClient {
  const client = webClient ?? createMockWebApiClient();
  return { getClient: () => client };
}

function createMockRouter(): { route: jest.Mock } {
  return { route: jest.fn().mockResolvedValue({ success: true, data: {} }) };
}

function createMockIdentityResolver(): SlackIdentityResolver {
  return {
    resolve: jest.fn().mockResolvedValue('test-user'),
    resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
  } as unknown as SlackIdentityResolver;
}

function createMockFormatter(): SlackFormatter {
  return { formatStatusBlocks: jest.fn().mockReturnValue([]) };
}

function createMockCommandHandler(): SlackCommandHandler {
  return { handle: jest.fn() } as unknown as SlackCommandHandler;
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
    getRequest: jest.fn().mockReturnValue(null),
    updateRequest: jest.fn(),
    getPendingPrompts: jest.fn().mockReturnValue([]),
    ...overrides,
  } as unknown as Repository;
}

function createMockServer(): SlackServer & { start: jest.Mock; stop: jest.Mock } {
  return {
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockSocketModeClient(): SocketModeClient & {
  start: jest.Mock;
  disconnect: jest.Mock;
  on: jest.Mock;
} {
  return {
    start: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
  };
}

// Suppress stderr logging during tests
const originalStderr = process.stderr.write;
beforeAll(() => {
  process.stderr.write = jest.fn() as unknown as typeof process.stderr.write;
});
afterAll(() => {
  process.stderr.write = originalStderr;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackAdapter (SPEC-008-4-05, Tasks 14-16)', () => {
  // -----------------------------------------------------------------------
  // Test 1: start() starts HTTP server
  // -----------------------------------------------------------------------
  test('start() starts HTTP server via server factory', async () => {
    const mockServer = createMockServer();
    const serverFactory: SlackServerFactory = jest.fn().mockReturnValue(mockServer);
    const webClient = createMockWebApiClient();

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig({ socket_mode: false, port: 4000 }),
      createMockCommandHandler(),
      createMockDb(),
      undefined, // socketModeFactory
      serverFactory,
    );

    const handle = await adapter.start();

    expect(serverFactory).toHaveBeenCalledWith(expect.anything());
    expect(mockServer.start).toHaveBeenCalledWith(4000);

    await handle.dispose();
  });

  // -----------------------------------------------------------------------
  // Test 2: start() with Socket Mode starts Socket Mode client
  // -----------------------------------------------------------------------
  test('start() with Socket Mode config starts Socket Mode client', async () => {
    const originalEnv = process.env;
    process.env = { ...originalEnv, SLACK_APP_TOKEN: 'xapp-test-token' };

    try {
      const mockSocketClient = createMockSocketModeClient();
      const socketModeFactory: SocketModeClientFactory = jest.fn().mockReturnValue(mockSocketClient);
      const webClient = createMockWebApiClient();

      const adapter = new SlackAdapter(
        createMockSlackClient(webClient),
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        createMockConfig({ socket_mode: true }),
        createMockCommandHandler(),
        createMockDb(),
        socketModeFactory,
        undefined, // serverFactory
      );

      const handle = await adapter.start();

      expect(socketModeFactory).toHaveBeenCalledWith('xapp-test-token');
      expect(mockSocketClient.start).toHaveBeenCalled();

      await handle.dispose();
    } finally {
      process.env = originalEnv;
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: sendMessage() calls chat.postMessage
  // -----------------------------------------------------------------------
  test('sendMessage() calls chat.postMessage with correct params', async () => {
    const webClient = createMockWebApiClient();

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig(),
      createMockCommandHandler(),
      createMockDb(),
    );

    const receipt = await adapter.sendMessage(
      {
        channelType: 'slack',
        platformChannelId: 'C12345',
      },
      {
        channelType: 'slack',
        payload: [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello' } }],
        fallbackText: 'Hello',
      },
    );

    expect(receipt.success).toBe(true);
    expect(receipt.platformMessageId).toBe('1234567890.123456');
    expect(webClient.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C12345',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Hello' } }],
      text: 'Hello',
      thread_ts: undefined,
    });
  });

  // -----------------------------------------------------------------------
  // Test 4: sendMessage() calls chat.postEphemeral for DM target
  // -----------------------------------------------------------------------
  test('sendMessage() calls chat.postEphemeral for DM target', async () => {
    const webClient = createMockWebApiClient();

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig(),
      createMockCommandHandler(),
      createMockDb(),
    );

    const receipt = await adapter.sendMessage(
      {
        channelType: 'slack',
        platformChannelId: 'C12345',
        userId: 'U12345',
        isDM: true,
      },
      {
        channelType: 'slack',
        payload: [{ type: 'section', text: { type: 'mrkdwn', text: 'Private' } }],
        fallbackText: 'Private',
      },
    );

    expect(receipt.success).toBe(true);
    expect(webClient.chat.postEphemeral).toHaveBeenCalledWith({
      channel: 'C12345',
      user: 'U12345',
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Private' } }],
      text: 'Private',
      thread_ts: undefined,
    });
    expect(webClient.chat.postMessage).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Test 5: sendMessage() includes thread_ts for threaded messages
  // -----------------------------------------------------------------------
  test('sendMessage() includes thread_ts for threaded messages', async () => {
    const webClient = createMockWebApiClient();

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig(),
      createMockCommandHandler(),
      createMockDb(),
    );

    await adapter.sendMessage(
      {
        channelType: 'slack',
        platformChannelId: 'C12345',
        threadId: '1234567890.000001',
      },
      {
        channelType: 'slack',
        payload: [],
        fallbackText: 'Threaded message',
      },
    );

    expect(webClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        thread_ts: '1234567890.000001',
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 6: promptUser() sends prompt and resolves on interaction response
  // -----------------------------------------------------------------------
  test('promptUser() sends prompt and resolves on interaction response', async () => {
    const webClient = createMockWebApiClient();

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig(),
      createMockCommandHandler(),
      createMockDb(),
    );

    const promptPromise = adapter.promptUser(
      {
        channelType: 'slack',
        platformChannelId: 'C12345',
      },
      {
        promptType: 'clarifying_question',
        requestId: 'REQ-000001',
        content: 'Which framework?',
        options: [
          { label: 'React', value: 'react', style: 'primary' },
          { label: 'Vue', value: 'vue' },
        ],
        timeoutSeconds: 60,
      },
    );

    // Verify prompt was posted
    expect(webClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C12345',
        text: 'Which framework?',
      }),
    );

    // Simulate user clicking "React"
    const resolved = adapter.resolvePrompt('REQ-000001', {
      responderId: 'U12345',
      content: 'react',
      selectedOption: 'react',
      timestamp: new Date(),
    });
    expect(resolved).toBe(true);

    const result = await promptPromise;
    expect(result).toEqual(
      expect.objectContaining({
        responderId: 'U12345',
        content: 'react',
        selectedOption: 'react',
      }),
    );
  });

  // -----------------------------------------------------------------------
  // Test 7: promptUser() resolves with TimeoutExpired on timeout
  // -----------------------------------------------------------------------
  test('promptUser() resolves with TimeoutExpired on timeout', async () => {
    jest.useFakeTimers();

    const webClient = createMockWebApiClient();

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig(),
      createMockCommandHandler(),
      createMockDb(),
    );

    const promptPromise = adapter.promptUser(
      {
        channelType: 'slack',
        platformChannelId: 'C12345',
      },
      {
        promptType: 'clarifying_question',
        requestId: 'REQ-000002',
        content: 'Any preference?',
        timeoutSeconds: 5,
      },
    );

    // Advance time past the timeout
    jest.advanceTimersByTime(6000);

    const result = await promptPromise;
    expect((result as TimeoutExpired).kind).toBe('timeout');
    expect((result as TimeoutExpired).requestId).toBe('REQ-000002');
    expect(adapter.pendingPromptCount).toBe(0);

    jest.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Test 8: shutdown() stops server and clears pending prompts
  // -----------------------------------------------------------------------
  test('shutdown() stops server and clears pending prompts', async () => {
    jest.useFakeTimers();

    const mockServer = createMockServer();
    const serverFactory: SlackServerFactory = jest.fn().mockReturnValue(mockServer);
    const webClient = createMockWebApiClient();

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig({ socket_mode: false, port: 3000 }),
      createMockCommandHandler(),
      createMockDb(),
      undefined,
      serverFactory,
    );

    // Start the adapter
    await adapter.start();

    // Create a pending prompt
    const promptPromise = adapter.promptUser(
      {
        channelType: 'slack',
        platformChannelId: 'C12345',
      },
      {
        promptType: 'clarifying_question',
        requestId: 'REQ-000003',
        content: 'Still waiting?',
        timeoutSeconds: 300,
      },
    );

    expect(adapter.pendingPromptCount).toBe(1);

    // Shutdown
    await adapter.shutdown();

    // Server should be stopped
    expect(mockServer.stop).toHaveBeenCalled();

    // Pending prompt should be resolved with TimeoutExpired
    const result = await promptPromise;
    expect((result as TimeoutExpired).kind).toBe('timeout');
    expect((result as TimeoutExpired).requestId).toBe('REQ-000003');

    // Pending prompts should be cleared
    expect(adapter.pendingPromptCount).toBe(0);

    jest.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // Bonus: startup recovery re-sends pending Slack prompts
  // -----------------------------------------------------------------------
  test('startup recovery re-sends pending prompts with [Resent] prefix', async () => {
    const webClient = createMockWebApiClient();
    const futureTimeout = new Date(Date.now() + 60_000).toISOString();

    const db = createMockDb({
      getPendingPrompts: jest.fn().mockReturnValue([
        {
          message_id: 'msg-1',
          request_id: 'REQ-000001',
          direction: 'outbound',
          channel: 'slack',
          content: 'Which framework?',
          message_type: 'clarifying_question',
          responded: 0,
          timeout_at: futureTimeout,
          thread_id: '1234567890.000001',
        },
        // This one should be filtered out (expired)
        {
          message_id: 'msg-2',
          request_id: 'REQ-000002',
          direction: 'outbound',
          channel: 'slack',
          content: 'Expired question',
          message_type: 'clarifying_question',
          responded: 0,
          timeout_at: new Date(Date.now() - 60_000).toISOString(),
          thread_id: '999',
        },
        // This one should be filtered out (discord channel)
        {
          message_id: 'msg-3',
          request_id: 'REQ-000003',
          direction: 'outbound',
          channel: 'discord',
          content: 'Discord question',
          message_type: 'clarifying_question',
          responded: 0,
          timeout_at: futureTimeout,
          thread_id: null,
        },
      ]),
      getRequest: jest.fn().mockReturnValue({
        request_id: 'REQ-000001',
        notification_config: JSON.stringify({
          routes: [{ channelType: 'slack', platformChannelId: 'C12345', threadId: '1234567890.000001' }],
        }),
      }),
    });

    const mockServer = createMockServer();
    const serverFactory: SlackServerFactory = jest.fn().mockReturnValue(mockServer);

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig({ socket_mode: false, port: 3000 }),
      createMockCommandHandler(),
      db,
      undefined,
      serverFactory,
    );

    await adapter.start();

    // Only the first prompt should be re-sent (slack + not expired)
    expect(webClient.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(webClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C12345',
        thread_ts: '1234567890.000001',
        text: '[Resent] Which framework?',
        blocks: expect.arrayContaining([
          expect.objectContaining({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: ':arrows_counterclockwise: *[Resent]*' }],
          }),
          expect.objectContaining({
            type: 'section',
            text: { type: 'mrkdwn', text: 'Which framework?' },
          }),
        ]),
      }),
    );

    await adapter.shutdown();
  });

  // -----------------------------------------------------------------------
  // Bonus: startup recovery does not crash on re-send failure
  // -----------------------------------------------------------------------
  test('startup recovery logs but does not throw on re-send failure', async () => {
    const webClient = createMockWebApiClient();
    (webClient.chat.postMessage as jest.Mock).mockRejectedValue(
      new Error('channel_not_found'),
    );

    const futureTimeout = new Date(Date.now() + 60_000).toISOString();
    const db = createMockDb({
      getPendingPrompts: jest.fn().mockReturnValue([
        {
          message_id: 'msg-1',
          request_id: 'REQ-000001',
          direction: 'outbound',
          channel: 'slack',
          content: 'Question?',
          message_type: 'clarifying_question',
          responded: 0,
          timeout_at: futureTimeout,
          thread_id: '1234567890.000001',
        },
      ]),
      getRequest: jest.fn().mockReturnValue({
        request_id: 'REQ-000001',
        notification_config: JSON.stringify({
          routes: [{ channelType: 'slack', platformChannelId: 'C12345' }],
        }),
      }),
    });

    const mockServer = createMockServer();
    const serverFactory: SlackServerFactory = jest.fn().mockReturnValue(mockServer);

    const adapter = new SlackAdapter(
      createMockSlackClient(webClient),
      createMockRouter(),
      createMockIdentityResolver(),
      createMockFormatter(),
      createMockConfig({ socket_mode: false, port: 3000 }),
      createMockCommandHandler(),
      db,
      undefined,
      serverFactory,
    );

    // Should not throw despite the postMessage failure
    await expect(adapter.start()).resolves.toBeDefined();
    await adapter.shutdown();
  });
});
