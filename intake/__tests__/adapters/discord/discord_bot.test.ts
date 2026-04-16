/**
 * Unit tests for Discord Bot Setup & Slash Command Registration (SPEC-008-3-01).
 *
 * Covers all 10 spec test cases:
 *  1. Client creation with correct intents
 *  2. Missing token throws descriptive error
 *  3. Command payload has exactly 1 top-level command named "ad" with 10 subcommands
 *  4. All 10 subcommand names present
 *  5. Submit options (4 options with correct types/constraints)
 *  6. Status options (request-id with min/max length)
 *  7. Priority choices on submit, list, and priority subcommands
 *  8. Logs boolean option (type 5)
 *  9. Kill has no options
 * 10. Registration API call mocking
 *
 * @module discord_bot.test
 */

import { Client, GatewayIntentBits, REST, Routes } from 'discord.js';
import { DiscordClient } from '../../../adapters/discord/discord_client';
import {
  DISCORD_COMMANDS,
  registerCommands,
} from '../../../adapters/discord/discord_commands';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock discord.js to avoid real network connections
jest.mock('discord.js', () => {
  // Preserve real enum/constant values for assertion accuracy
  const actual = jest.requireActual('discord.js');

  /** Minimal mock Client class. */
  class MockClient {
    options: { intents: number[] };
    user: { tag: string; id: string } | null = null;
    guilds = { cache: { size: 0 } };
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor(opts: { intents: number[] }) {
      this.options = opts;
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      if (!this.listeners[event]) {
        this.listeners[event] = [];
      }
      this.listeners[event].push(handler);
      return this;
    }

    async login(token: string): Promise<string> {
      if (!token) throw new Error('TOKEN_INVALID');
      this.user = { tag: 'TestBot#1234', id: '123456789012345678' };
      return token;
    }

    destroy(): void {
      this.user = null;
    }

    /** Emit an event for testing. */
    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.listeners[event] ?? []) {
        handler(...args);
      }
    }
  }

  /** Mock REST class that records `put` calls. */
  class MockREST {
    token: string | null = null;

    setToken(token: string): this {
      this.token = token;
      return this;
    }

    async put(_route: string, _options?: { body: unknown }): Promise<unknown> {
      return []; // Discord API returns the registered commands
    }
  }

  return {
    ...actual,
    Client: MockClient,
    REST: MockREST,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find a subcommand by name within the top-level `/ad` command. */
function findSubcommand(name: string) {
  const adCommand = DISCORD_COMMANDS[0];
  return adCommand.options!.find(
    (opt: { name: string }) => opt.name === name,
  );
}

/** Get the options array for a subcommand (empty array if none). */
function getSubcommandOptions(name: string): Array<Record<string, unknown>> {
  const sub = findSubcommand(name);
  return (sub as Record<string, unknown>)?.options as Array<Record<string, unknown>> ?? [];
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('Discord Bot Setup (SPEC-008-3-01, Task 1)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -----------------------------------------------------------------------
  // Test 1: Client creation with correct intents
  // -----------------------------------------------------------------------
  test('client is created with Guilds and GuildMessages intents', () => {
    const discordClient = new DiscordClient();
    const client = discordClient.getClient();

    // The mock Client stores the raw options; verify both intents are present
    const intents = (client as unknown as { options: { intents: number[] } }).options.intents;
    expect(intents).toContain(GatewayIntentBits.Guilds);
    expect(intents).toContain(GatewayIntentBits.GuildMessages);
  });

  // -----------------------------------------------------------------------
  // Test 2: Missing token throws descriptive error
  // -----------------------------------------------------------------------
  test('connect() throws when DISCORD_BOT_TOKEN is not set', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const discordClient = new DiscordClient();

    await expect(discordClient.connect()).rejects.toThrow(
      'DISCORD_BOT_TOKEN environment variable is not set',
    );
  });

  test('connect() succeeds when DISCORD_BOT_TOKEN is set', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token-value';

    const discordClient = new DiscordClient();
    await expect(discordClient.connect()).resolves.toBeUndefined();

    const client = discordClient.getClient();
    expect(client.user).toBeTruthy();
    expect(client.user!.tag).toBe('TestBot#1234');
  });

  test('disconnect() destroys the client', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token-value';

    const discordClient = new DiscordClient();
    await discordClient.connect();

    await discordClient.disconnect();
    // After destroy, user is nulled in our mock
    expect(discordClient.getClient().user).toBeNull();
  });
});

describe('Slash Command Payload (SPEC-008-3-01, Task 2)', () => {
  // -----------------------------------------------------------------------
  // Test 3: Payload structure -- 1 top-level command, 10 subcommands
  // -----------------------------------------------------------------------
  test('payload has exactly 1 top-level command named "ad" with 10 subcommands', () => {
    expect(DISCORD_COMMANDS).toHaveLength(1);

    const adCommand = DISCORD_COMMANDS[0];
    expect(adCommand.name).toBe('ad');
    expect(adCommand.description).toBe('Autonomous Dev pipeline commands');
    expect(adCommand.type).toBe(1); // CHAT_INPUT
    expect(adCommand.options).toHaveLength(10);
  });

  // -----------------------------------------------------------------------
  // Test 4: All 10 subcommand names
  // -----------------------------------------------------------------------
  test('all 10 subcommand names are present', () => {
    const expectedNames = [
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

    const actualNames = DISCORD_COMMANDS[0].options!.map(
      (opt: { name: string }) => opt.name,
    );

    expect(actualNames).toEqual(expectedNames);
  });

  test('every subcommand has type 1 (SUB_COMMAND)', () => {
    for (const option of DISCORD_COMMANDS[0].options!) {
      expect((option as Record<string, unknown>).type).toBe(1);
    }
  });

  // -----------------------------------------------------------------------
  // Test 5: Submit options
  // -----------------------------------------------------------------------
  describe('submit subcommand options', () => {
    test('has 4 options', () => {
      const options = getSubcommandOptions('submit');
      expect(options).toHaveLength(4);
    });

    test('description is required, string type, max_length 10000', () => {
      const options = getSubcommandOptions('submit');
      const desc = options.find((o) => o.name === 'description')!;
      expect(desc.required).toBe(true);
      expect(desc.type).toBe(3); // STRING
      expect(desc.max_length).toBe(10000);
    });

    test('priority is optional, string type, 3 choices', () => {
      const options = getSubcommandOptions('submit');
      const prio = options.find((o) => o.name === 'priority')!;
      expect(prio.required).toBe(false);
      expect(prio.type).toBe(3); // STRING
      expect(prio.choices).toHaveLength(3);
    });

    test('repo is optional, string type', () => {
      const options = getSubcommandOptions('submit');
      const repo = options.find((o) => o.name === 'repo')!;
      expect(repo.required).toBe(false);
      expect(repo.type).toBe(3); // STRING
    });

    test('deadline is optional, string type', () => {
      const options = getSubcommandOptions('submit');
      const deadline = options.find((o) => o.name === 'deadline')!;
      expect(deadline.required).toBe(false);
      expect(deadline.type).toBe(3); // STRING
    });
  });

  // -----------------------------------------------------------------------
  // Test 6: Status options (request-id with min/max length)
  // -----------------------------------------------------------------------
  describe('status subcommand options', () => {
    test('has 1 option: request-id (required, string, min 10, max 10)', () => {
      const options = getSubcommandOptions('status');
      expect(options).toHaveLength(1);

      const reqId = options[0];
      expect(reqId.name).toBe('request-id');
      expect(reqId.required).toBe(true);
      expect(reqId.type).toBe(3); // STRING
      expect(reqId.min_length).toBe(10);
      expect(reqId.max_length).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // Test 7: Priority choices on submit, list, and priority subcommands
  // -----------------------------------------------------------------------
  describe('priority choices consistency', () => {
    const expectedChoices = [
      { name: 'High', value: 'high' },
      { name: 'Normal', value: 'normal' },
      { name: 'Low', value: 'low' },
    ];

    test('submit priority option has correct choices', () => {
      const options = getSubcommandOptions('submit');
      const prio = options.find((o) => o.name === 'priority')!;
      expect(prio.choices).toEqual(expectedChoices);
    });

    test('list priority option has correct choices', () => {
      const options = getSubcommandOptions('list');
      const prio = options.find((o) => o.name === 'priority')!;
      expect(prio.choices).toEqual(expectedChoices);
    });

    test('priority subcommand level option has correct choices', () => {
      const options = getSubcommandOptions('priority');
      const level = options.find((o) => o.name === 'level')!;
      expect(level.choices).toEqual(expectedChoices);
    });
  });

  // -----------------------------------------------------------------------
  // Test 8: Logs boolean option
  // -----------------------------------------------------------------------
  test('logs "all" option has type 5 (BOOLEAN)', () => {
    const options = getSubcommandOptions('logs');
    const allOpt = options.find((o) => o.name === 'all')!;
    expect(allOpt.type).toBe(5); // BOOLEAN
    expect(allOpt.required).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 9: Kill has no options
  // -----------------------------------------------------------------------
  test('kill subcommand has no options', () => {
    const kill = findSubcommand('kill');
    // The kill entry should either have no "options" key or an undefined value
    expect((kill as Record<string, unknown>).options).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 10: Feedback message max_length
  // -----------------------------------------------------------------------
  test('feedback message option has max_length 4000', () => {
    const options = getSubcommandOptions('feedback');
    const msg = options.find((o) => o.name === 'message')!;
    expect(msg.required).toBe(true);
    expect(msg.type).toBe(3); // STRING
    expect(msg.max_length).toBe(4000);
  });
});

describe('Command Registration (SPEC-008-3-01, Task 2)', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  // -----------------------------------------------------------------------
  // Test 10: Registration API call -- mock REST client
  // -----------------------------------------------------------------------
  test('registerCommands calls PUT on the correct route with correct body', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    process.env.DISCORD_GUILD_ID = '999888777666555444';

    // Spy on REST.prototype.put
    const putSpy = jest.fn().mockResolvedValue([]);
    const setTokenSpy = jest.fn().mockReturnThis();

    // Override the mock REST to capture calls
    const OriginalREST = REST;
    (REST as unknown as jest.Mock) = jest.fn().mockImplementation(() => ({
      setToken: setTokenSpy,
      put: putSpy,
    }));

    // Create a mock client with user.id set
    const client = new Client({ intents: [] });
    await client.login('test-token');

    await registerCommands(client, '999888777666555444');

    // Verify setToken was called with the bot token
    expect(setTokenSpy).toHaveBeenCalledWith('test-token');

    // Verify PUT was called with the correct route and body
    expect(putSpy).toHaveBeenCalledTimes(1);

    const [route, options] = putSpy.mock.calls[0];
    // The route should target application guild commands
    expect(route).toBe(
      Routes.applicationGuildCommands('123456789012345678', '999888777666555444'),
    );
    expect(options).toEqual({ body: DISCORD_COMMANDS });

    // Restore
    (REST as unknown) = OriginalREST;
  });

  test('registerCommands throws when DISCORD_GUILD_ID is not set and no guildId passed', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    delete process.env.DISCORD_GUILD_ID;

    const client = new Client({ intents: [] });
    await client.login('test-token');

    await expect(registerCommands(client)).rejects.toThrow(
      'DISCORD_GUILD_ID environment variable is not set',
    );
  });

  test('registerCommands throws when client.user is null', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    process.env.DISCORD_GUILD_ID = '999888777666555444';

    // Client without login -- user is null
    const client = new Client({ intents: [] });

    await expect(
      registerCommands(client, '999888777666555444'),
    ).rejects.toThrow('Discord client is not logged in; client.user is null');
  });

  test('registerCommands throws when DISCORD_BOT_TOKEN is not set', async () => {
    delete process.env.DISCORD_BOT_TOKEN;

    const client = new Client({ intents: [] });
    // Force user to exist to get past the user check
    (client as unknown as { user: { id: string } }).user = { id: 'fake' };

    await expect(
      registerCommands(client, '999888777666555444'),
    ).rejects.toThrow('DISCORD_BOT_TOKEN environment variable is not set');
  });

  test('registerCommands logs success with guild ID and command count', async () => {
    process.env.DISCORD_BOT_TOKEN = 'test-token';

    const logCalls: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const logger = {
      info: (message: string, context?: Record<string, unknown>) => {
        logCalls.push({ message, context });
      },
      error: () => {},
    };

    const client = new Client({ intents: [] });
    await client.login('test-token');

    await registerCommands(client, '111222333444555666', logger);

    expect(logCalls).toHaveLength(1);
    expect(logCalls[0].message).toBe('Discord slash commands registered');
    expect(logCalls[0].context).toEqual({
      guildId: '111222333444555666',
      commandCount: 10,
    });
  });
});
