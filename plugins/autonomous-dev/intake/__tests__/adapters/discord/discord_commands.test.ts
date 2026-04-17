/**
 * Unit tests for Discord Slash Command Registration (SPEC-008-3-05, Task 14).
 *
 * Covers 10 test cases:
 *  1. Command payload has exactly 1 top-level command `/ad` with 10 subcommands
 *  2. All 10 subcommand names match expected list
 *  3. Submit subcommand has correct option types, required flags, and max_length
 *  4. Status request-id has min_length/max_length constraints
 *  5. Priority choices match across submit, list, and priority subcommands
 *  6. Logs boolean option (type 5)
 *  7. Kill has no options
 *  8. Feedback message has max_length 4000
 *  9. Registration calls REST.put with correct route and body
 * 10. Registration is idempotent (second call succeeds without error)
 *
 * @module discord_commands.test
 */

import { Client, REST, Routes } from 'discord.js';
import {
  DISCORD_COMMANDS,
  registerCommands,
} from '../../../adapters/discord/discord_commands';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

jest.mock('discord.js', () => {
  const actual = jest.requireActual('discord.js');

  class MockClient {
    options: { intents: number[] };
    user: { tag: string; id: string } | null = null;
    guilds = { cache: { size: 0 } };
    private listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor(opts: { intents: number[] }) {
      this.options = opts;
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      if (!this.listeners[event]) this.listeners[event] = [];
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
  }

  class MockREST {
    token: string | null = null;

    setToken(token: string): this {
      this.token = token;
      return this;
    }

    async put(_route: string, _options?: { body: unknown }): Promise<unknown> {
      return [];
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

function findSubcommand(name: string) {
  const adCommand = DISCORD_COMMANDS[0];
  return adCommand.options!.find((opt: { name: string }) => opt.name === name);
}

function getSubcommandOptions(name: string): Array<Record<string, unknown>> {
  const sub = findSubcommand(name);
  return ((sub as Record<string, unknown>)?.options as Array<Record<string, unknown>>) ?? [];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Discord Slash Command Payload (SPEC-008-3-05, Task 14)', () => {
  // -----------------------------------------------------------------------
  // Test 1: 1 top-level command with 10 subcommands
  // -----------------------------------------------------------------------
  test('payload has exactly 1 top-level command /ad with 10 subcommands', () => {
    expect(DISCORD_COMMANDS).toHaveLength(1);

    const adCommand = DISCORD_COMMANDS[0];
    expect(adCommand.name).toBe('ad');
    expect(adCommand.description).toBe('Autonomous Dev pipeline commands');
    expect(adCommand.type).toBe(1); // CHAT_INPUT
    expect(adCommand.options).toHaveLength(10);
  });

  // -----------------------------------------------------------------------
  // Test 2: All 10 subcommand names
  // -----------------------------------------------------------------------
  test('each subcommand has correct name and type SUB_COMMAND', () => {
    const expectedNames = [
      'submit', 'status', 'list', 'cancel', 'pause',
      'resume', 'priority', 'logs', 'feedback', 'kill',
    ];

    const actualNames = DISCORD_COMMANDS[0].options!.map(
      (opt: { name: string }) => opt.name,
    );
    expect(actualNames).toEqual(expectedNames);

    // All subcommands have type 1 (SUB_COMMAND)
    for (const option of DISCORD_COMMANDS[0].options!) {
      expect((option as Record<string, unknown>).type).toBe(1);
    }
  });

  // -----------------------------------------------------------------------
  // Test 3: Submit options -- types, required flags, max_length
  // -----------------------------------------------------------------------
  test('submit has correct option types, required flags, and max_length constraints', () => {
    const options = getSubcommandOptions('submit');
    expect(options).toHaveLength(4);

    // description: required, STRING, max_length 10000
    const desc = options.find((o) => o.name === 'description')!;
    expect(desc.required).toBe(true);
    expect(desc.type).toBe(3); // STRING
    expect(desc.max_length).toBe(10000);

    // priority: optional, STRING, 3 choices
    const prio = options.find((o) => o.name === 'priority')!;
    expect(prio.required).toBe(false);
    expect(prio.type).toBe(3);
    expect(prio.choices).toHaveLength(3);

    // repo: optional, STRING
    const repo = options.find((o) => o.name === 'repo')!;
    expect(repo.required).toBe(false);
    expect(repo.type).toBe(3);

    // deadline: optional, STRING
    const deadline = options.find((o) => o.name === 'deadline')!;
    expect(deadline.required).toBe(false);
    expect(deadline.type).toBe(3);
  });

  // -----------------------------------------------------------------------
  // Test 4: Status request-id min_length/max_length
  // -----------------------------------------------------------------------
  test('status request-id has min_length 10 and max_length 10', () => {
    const options = getSubcommandOptions('status');
    expect(options).toHaveLength(1);

    const reqId = options[0];
    expect(reqId.name).toBe('request-id');
    expect(reqId.required).toBe(true);
    expect(reqId.type).toBe(3); // STRING
    expect(reqId.min_length).toBe(10);
    expect(reqId.max_length).toBe(10);
  });

  // -----------------------------------------------------------------------
  // Test 5: Priority choice enums consistent
  // -----------------------------------------------------------------------
  test('priority choices are consistent across submit, list, and priority subcommands', () => {
    const expectedChoices = [
      { name: 'High', value: 'high' },
      { name: 'Normal', value: 'normal' },
      { name: 'Low', value: 'low' },
    ];

    // submit.priority
    const submitPrio = getSubcommandOptions('submit').find((o) => o.name === 'priority')!;
    expect(submitPrio.choices).toEqual(expectedChoices);

    // list.priority
    const listPrio = getSubcommandOptions('list').find((o) => o.name === 'priority')!;
    expect(listPrio.choices).toEqual(expectedChoices);

    // priority.level
    const prioLevel = getSubcommandOptions('priority').find((o) => o.name === 'level')!;
    expect(prioLevel.choices).toEqual(expectedChoices);
  });

  // -----------------------------------------------------------------------
  // Test 6: Logs boolean option type 5
  // -----------------------------------------------------------------------
  test('logs "all" option has type BOOLEAN (5) and is optional', () => {
    const options = getSubcommandOptions('logs');
    const allOpt = options.find((o) => o.name === 'all')!;
    expect(allOpt.type).toBe(5); // BOOLEAN
    expect(allOpt.required).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 7: Kill has no options
  // -----------------------------------------------------------------------
  test('kill subcommand has no options', () => {
    const kill = findSubcommand('kill');
    expect((kill as Record<string, unknown>).options).toBeUndefined();
  });

  // -----------------------------------------------------------------------
  // Test 8: Feedback message max_length 4000
  // -----------------------------------------------------------------------
  test('feedback message option has max_length 4000', () => {
    const options = getSubcommandOptions('feedback');
    const msg = options.find((o) => o.name === 'message')!;
    expect(msg.required).toBe(true);
    expect(msg.type).toBe(3); // STRING
    expect(msg.max_length).toBe(4000);
  });

  // -----------------------------------------------------------------------
  // Test 9: Registration calls REST.put with correct route and body
  // -----------------------------------------------------------------------
  test('registration calls REST.put with correct route and body', async () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalGuild = process.env.DISCORD_GUILD_ID;
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    process.env.DISCORD_GUILD_ID = '999888777666555444';

    try {
      const putSpy = jest.fn().mockResolvedValue([]);
      const setTokenSpy = jest.fn().mockReturnThis();

      const OriginalREST = REST;
      (REST as unknown as jest.Mock) = jest.fn().mockImplementation(() => ({
        setToken: setTokenSpy,
        put: putSpy,
      }));

      const client = new Client({ intents: [] });
      await client.login('test-token');

      await registerCommands(client, '999888777666555444');

      expect(setTokenSpy).toHaveBeenCalledWith('test-token');
      expect(putSpy).toHaveBeenCalledTimes(1);

      const [route, options] = putSpy.mock.calls[0];
      expect(route).toBe(
        Routes.applicationGuildCommands('123456789012345678', '999888777666555444'),
      );
      expect(options).toEqual({ body: DISCORD_COMMANDS });

      (REST as unknown) = OriginalREST;
    } finally {
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_GUILD_ID = originalGuild;
    }
  });

  // -----------------------------------------------------------------------
  // Test 10: Registration is idempotent
  // -----------------------------------------------------------------------
  test('registration is idempotent (second call succeeds without error)', async () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalGuild = process.env.DISCORD_GUILD_ID;
    process.env.DISCORD_BOT_TOKEN = 'test-token';
    process.env.DISCORD_GUILD_ID = '999888777666555444';

    try {
      const putSpy = jest.fn().mockResolvedValue([]);
      const setTokenSpy = jest.fn().mockReturnThis();

      const OriginalREST = REST;
      (REST as unknown as jest.Mock) = jest.fn().mockImplementation(() => ({
        setToken: setTokenSpy,
        put: putSpy,
      }));

      const client = new Client({ intents: [] });
      await client.login('test-token');

      // First registration
      await registerCommands(client, '999888777666555444');
      expect(putSpy).toHaveBeenCalledTimes(1);

      // Second registration (idempotent)
      await registerCommands(client, '999888777666555444');
      expect(putSpy).toHaveBeenCalledTimes(2);

      // Both calls used the same payload
      expect(putSpy.mock.calls[0][1]).toEqual(putSpy.mock.calls[1][1]);

      (REST as unknown) = OriginalREST;
    } finally {
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_GUILD_ID = originalGuild;
    }
  });
});
