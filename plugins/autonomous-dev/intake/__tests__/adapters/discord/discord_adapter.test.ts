/**
 * Unit tests for DiscordAdapter (SPEC-008-3-05, Task 14).
 *
 * Covers 8 test cases with mocked Discord.js client:
 *  1. start() connects client and registers commands
 *  2. sendMessage() sends to channel with embed payload
 *  3. promptUser() sends buttons and collects interaction response
 *  4. promptUser() returns TimeoutExpired when collection times out
 *  5. shutdown() disconnects after draining in-flight
 *  6. Interaction listener routes slash commands
 *  7. Interaction listener routes component interactions
 *  8. Interaction listener routes modal submissions
 *
 * @module discord_adapter.test
 */

import {
  DiscordAdapter,
  type DiscordClient,
  type DiscordJSClient,
  type IntakeRouter,
  type DiscordFormatter,
  type ComponentInteractionHandler,
  type ChannelResolver,
  type TextChannelLike,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
  type SentMessage,
} from '../../../adapters/discord/discord_adapter';
import type { DiscordIdentityResolver } from '../../../adapters/discord/discord_identity';
import type {
  MessageTarget,
  FormattedMessage,
  StructuredPrompt,
  IncomingCommand,
  CommandResult,
} from '../../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDiscordJSClient(overrides?: Partial<DiscordJSClient>): DiscordJSClient {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
    }),
    user: { id: '123456789012345678', tag: 'TestBot#1234' },
    channels: {
      fetch: jest.fn(),
    },
    // Expose listeners for testing
    __listeners: listeners,
    ...overrides,
  } as DiscordJSClient & { __listeners: Record<string, Array<(...args: unknown[]) => void>> };
}

function createMockDiscordClient(jsClient?: DiscordJSClient & { __listeners?: Record<string, Array<(...args: unknown[]) => void>> }): DiscordClient & { jsClient: DiscordJSClient & { __listeners?: Record<string, Array<(...args: unknown[]) => void>> } } {
  const client = jsClient ?? createMockDiscordJSClient();
  return {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    getClient: () => client,
    jsClient: client,
  };
}

function createMockRouter(result?: Partial<CommandResult>): IntakeRouter & { lastCommand?: IncomingCommand } {
  const mock: IntakeRouter & { lastCommand?: IncomingCommand } = {
    async route(command: IncomingCommand): Promise<CommandResult> {
      mock.lastCommand = command;
      return { success: true, data: { requestId: 'REQ-000001' }, ...result } as CommandResult;
    },
  };
  return mock;
}

function createMockIdentityResolver(userId: string = 'test-user'): DiscordIdentityResolver {
  return {
    resolve: jest.fn().mockResolvedValue(userId),
    resolveDisplayName: jest.fn().mockResolvedValue('Test User'),
  } as unknown as DiscordIdentityResolver;
}

function createMockFormatter(): DiscordFormatter {
  return {
    formatStatusEmbed: jest.fn().mockReturnValue({ title: 'Status', color: 0x95a5a6 }),
    formatError: jest.fn().mockReturnValue({ title: 'Error', color: 0xe74c3c }),
  };
}

function createMockComponentHandler(): ComponentInteractionHandler {
  return {
    handle: jest.fn().mockResolvedValue(undefined),
    handleModalSubmit: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockChannelResolver(channel?: Partial<TextChannelLike>): ChannelResolver {
  const mockChannel: TextChannelLike = {
    send: jest.fn().mockResolvedValue({ id: 'msg-001', createdTimestamp: Date.now() }),
    ...channel,
  };
  return {
    resolveChannel: jest.fn().mockResolvedValue(mockChannel),
  };
}

function createAdapter(opts?: {
  client?: DiscordClient & { jsClient: DiscordJSClient & { __listeners?: Record<string, Array<(...args: unknown[]) => void>> } };
  router?: IntakeRouter;
  identity?: DiscordIdentityResolver;
  formatter?: DiscordFormatter;
  componentHandler?: ComponentInteractionHandler;
  registerCommands?: () => Promise<void>;
  db?: unknown;
  channelResolver?: ChannelResolver;
}): {
  adapter: DiscordAdapter;
  client: DiscordClient & { jsClient: DiscordJSClient & { __listeners?: Record<string, Array<(...args: unknown[]) => void>> } };
  router: IntakeRouter;
  identity: DiscordIdentityResolver;
  formatter: DiscordFormatter;
  componentHandler: ComponentInteractionHandler;
  channelResolver: ChannelResolver;
} {
  const client = opts?.client ?? createMockDiscordClient();
  const router = opts?.router ?? createMockRouter();
  const identity = opts?.identity ?? createMockIdentityResolver();
  const formatter = opts?.formatter ?? createMockFormatter();
  const componentHandler = opts?.componentHandler ?? createMockComponentHandler();
  const channelResolver = opts?.channelResolver ?? createMockChannelResolver();

  const adapter = new DiscordAdapter(
    client,
    router,
    identity,
    formatter,
    componentHandler,
    opts?.registerCommands ?? (async () => {}),
    opts?.db as never,
  );

  adapter.setChannelResolver(channelResolver);

  return { adapter, client, router, identity, formatter, componentHandler, channelResolver };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscordAdapter (SPEC-008-3-05, Task 14)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DISCORD_GUILD_ID: '999888777666555444' };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -----------------------------------------------------------------------
  // Test 1: start() connects client and registers commands
  // -----------------------------------------------------------------------
  test('start() connects client and registers commands', async () => {
    const registerCommands = jest.fn().mockResolvedValue(undefined);
    const { adapter, client } = createAdapter({ registerCommands });

    const handle = await adapter.start();

    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(registerCommands).toHaveBeenCalledTimes(1);
    expect(registerCommands).toHaveBeenCalledWith(
      client.getClient(),
      '999888777666555444',
    );

    // Verify the handle has a dispose method
    expect(typeof handle.dispose).toBe('function');
  });

  // -----------------------------------------------------------------------
  // Test 2: sendMessage() sends to channel with embed payload
  // -----------------------------------------------------------------------
  test('sendMessage() sends to channel with embed payload', async () => {
    const mockSend = jest.fn().mockResolvedValue({ id: 'msg-001', createdTimestamp: Date.now() });
    const channelResolver = createMockChannelResolver({ send: mockSend });
    const { adapter } = createAdapter({ channelResolver });

    const target: MessageTarget = {
      channelType: 'discord',
      platformChannelId: 'channel-123',
    };

    const payload: FormattedMessage = {
      channelType: 'discord',
      payload: { title: 'Test Embed', color: 0x3498db },
      fallbackText: 'Test fallback',
    };

    const receipt = await adapter.sendMessage(target, payload);

    expect(receipt.success).toBe(true);
    expect(receipt.platformMessageId).toBe('msg-001');
    expect(mockSend).toHaveBeenCalledWith({
      embeds: [{ title: 'Test Embed', color: 0x3498db }],
      content: 'Test fallback',
    });
  });

  // -----------------------------------------------------------------------
  // Test 3: promptUser() sends buttons and collects interaction response
  // -----------------------------------------------------------------------
  test('promptUser() sends buttons and collects interaction response', async () => {
    const mockAwaitComponent = jest.fn().mockResolvedValue({
      user: { id: 'user-discord-123' },
      customId: 'approve',
    });

    const mockSend = jest.fn().mockResolvedValue({
      id: 'msg-prompt-001',
      createdTimestamp: Date.now(),
      awaitMessageComponent: mockAwaitComponent,
    });

    const channelResolver = createMockChannelResolver({ send: mockSend });
    const { adapter } = createAdapter({ channelResolver });

    const target: MessageTarget = {
      channelType: 'discord',
      userId: 'user-discord-123',
      platformChannelId: 'channel-123',
    };

    const prompt: StructuredPrompt = {
      promptType: 'approval_request',
      requestId: 'REQ-000042',
      content: 'Do you approve?',
      options: [
        { label: 'Approve', value: 'approve', style: 'primary' },
        { label: 'Reject', value: 'reject', style: 'danger' },
      ],
      timeoutSeconds: 300,
    };

    const response = await adapter.promptUser(target, prompt);

    // Should be a UserResponse, not TimeoutExpired
    expect('kind' in response).toBe(false);
    expect((response as { responderId: string }).responderId).toBe('user-discord-123');
    expect((response as { content: string }).content).toBe('approve');
    expect((response as { selectedOption: string }).selectedOption).toBe('approve');

    // Verify buttons were sent
    expect(mockSend).toHaveBeenCalledTimes(1);
    const sendArgs = mockSend.mock.calls[0][0];
    expect(sendArgs.components).toHaveLength(1);
    expect(sendArgs.components[0].type).toBe(1); // ACTION_ROW

    // Verify awaitMessageComponent was called with correct timeout
    expect(mockAwaitComponent).toHaveBeenCalledWith({
      filter: expect.any(Function),
      time: 300_000,
    });
  });

  // -----------------------------------------------------------------------
  // Test 4: promptUser() returns TimeoutExpired when collection times out
  // -----------------------------------------------------------------------
  test('promptUser() returns TimeoutExpired when collection times out', async () => {
    const mockAwaitComponent = jest.fn().mockRejectedValue(
      new Error('Collector ended without collecting any interactions'),
    );

    const createdTimestamp = Date.now();
    const mockSend = jest.fn().mockResolvedValue({
      id: 'msg-prompt-002',
      createdTimestamp,
      awaitMessageComponent: mockAwaitComponent,
    });

    const channelResolver = createMockChannelResolver({ send: mockSend });
    const { adapter } = createAdapter({ channelResolver });

    const target: MessageTarget = {
      channelType: 'discord',
      userId: 'user-discord-123',
      platformChannelId: 'channel-123',
    };

    const prompt: StructuredPrompt = {
      promptType: 'clarifying_question',
      requestId: 'REQ-000042',
      content: 'What auth provider?',
      timeoutSeconds: 60,
    };

    const response = await adapter.promptUser(target, prompt);

    // Should be a TimeoutExpired
    expect('kind' in response && (response as { kind: string }).kind === 'timeout').toBe(true);
    const timeout = response as { kind: string; requestId: string; promptedAt: Date; expiredAt: Date };
    expect(timeout.requestId).toBe('REQ-000042');
    expect(timeout.promptedAt).toEqual(new Date(createdTimestamp));
    expect(timeout.expiredAt).toBeInstanceOf(Date);
  });

  // -----------------------------------------------------------------------
  // Test 5: shutdown() disconnects after draining in-flight
  // -----------------------------------------------------------------------
  test('shutdown() disconnects after draining in-flight', async () => {
    const { adapter, client } = createAdapter();

    await adapter.shutdown();

    expect(adapter.isShuttingDown).toBe(true);
    expect(client.disconnect).toHaveBeenCalledTimes(1);
  });

  // -----------------------------------------------------------------------
  // Test 6: Interaction listener routes slash commands
  // -----------------------------------------------------------------------
  test('interaction listener routes slash commands to handleSlashCommand', async () => {
    const router = createMockRouter({ success: true, data: { status: 'queued' } });
    const identity = createMockIdentityResolver('user-001');
    const formatter = createMockFormatter();
    const jsClient = createMockDiscordJSClient();
    const mockClient = createMockDiscordClient(jsClient);
    const { adapter } = createAdapter({
      client: mockClient,
      router,
      identity,
      formatter,
    });

    // Start the adapter to set up the interaction listener
    await adapter.start();

    // Get the interactionCreate listener
    const listeners = (jsClient as DiscordJSClient & { __listeners: Record<string, Array<(...args: unknown[]) => void>> }).__listeners;
    expect(listeners['interactionCreate']).toBeDefined();
    expect(listeners['interactionCreate'].length).toBeGreaterThan(0);

    // Create a mock slash command interaction
    const interaction = {
      isRepliable: () => true,
      isChatInputCommand: () => true,
      isMessageComponent: () => false,
      isModalSubmit: () => false,
      deferReply: jest.fn().mockResolvedValue(undefined),
      editReply: jest.fn().mockResolvedValue(undefined),
      reply: jest.fn().mockResolvedValue(undefined),
      options: {
        getSubcommand: () => 'status',
        getString: jest.fn((name: string) => {
          if (name === 'request-id') return 'REQ-000001';
          return '';
        }),
        getBoolean: jest.fn().mockReturnValue(null),
      },
      user: { id: 'discord-user-123' },
      channelId: 'channel-456',
      toString: () => '/ad status request-id:REQ-000001',
    };

    // Invoke the listener
    await listeners['interactionCreate'][0](interaction);

    // Verify deferReply was called first
    expect(interaction.deferReply).toHaveBeenCalledTimes(1);

    // Verify the router was invoked
    expect(router.lastCommand).toBeDefined();
    expect(router.lastCommand!.commandName).toBe('status');

    // Verify editReply was called with embed
    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [expect.objectContaining({ title: 'Status' })],
    });
  });

  // -----------------------------------------------------------------------
  // Test 7: Interaction listener routes component interactions
  // -----------------------------------------------------------------------
  test('interaction listener routes component interactions to componentHandler', async () => {
    const componentHandler = createMockComponentHandler();
    const jsClient = createMockDiscordJSClient();
    const mockClient = createMockDiscordClient(jsClient);
    const { adapter } = createAdapter({
      client: mockClient,
      componentHandler,
    });

    await adapter.start();

    const listeners = (jsClient as DiscordJSClient & { __listeners: Record<string, Array<(...args: unknown[]) => void>> }).__listeners;

    const interaction = {
      isRepliable: () => true,
      isChatInputCommand: () => false,
      isMessageComponent: () => true,
      isModalSubmit: () => false,
      customId: 'kill_confirm',
      user: { id: 'discord-user-123' },
      reply: jest.fn(),
      update: jest.fn(),
    };

    await listeners['interactionCreate'][0](interaction);

    expect(componentHandler.handle).toHaveBeenCalledTimes(1);
    expect(componentHandler.handle).toHaveBeenCalledWith(interaction);
  });

  // -----------------------------------------------------------------------
  // Test 8: Interaction listener routes modal submissions
  // -----------------------------------------------------------------------
  test('interaction listener routes modal submissions to componentHandler', async () => {
    const componentHandler = createMockComponentHandler();
    const jsClient = createMockDiscordJSClient();
    const mockClient = createMockDiscordClient(jsClient);
    const { adapter } = createAdapter({
      client: mockClient,
      componentHandler,
    });

    await adapter.start();

    const listeners = (jsClient as DiscordJSClient & { __listeners: Record<string, Array<(...args: unknown[]) => void>> }).__listeners;

    const interaction = {
      isRepliable: () => true,
      isChatInputCommand: () => false,
      isMessageComponent: () => false,
      isModalSubmit: () => true,
      fields: {
        getTextInputValue: jest.fn().mockReturnValue('test value'),
      },
      user: { id: 'discord-user-123' },
      channelId: 'channel-456',
      deferReply: jest.fn(),
      editReply: jest.fn(),
    };

    await listeners['interactionCreate'][0](interaction);

    expect(componentHandler.handleModalSubmit).toHaveBeenCalledTimes(1);
    expect(componentHandler.handleModalSubmit).toHaveBeenCalledWith(interaction);
  });
});
