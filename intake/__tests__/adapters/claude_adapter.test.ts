/**
 * Unit tests for ClaudeAdapter (SPEC-008-2-01).
 *
 * Covers:
 * 1. start() registers all 10 commands
 * 2. Command definition correctness (arg count, flag names, required flags)
 * 3. shutdown() waits for in-flight commands
 * 4. Rejection during shutdown
 * 5. InFlightCount tracking
 * 6. AdapterHandle dispose delegates to shutdown()
 *
 * @module claude_adapter.test
 */

import {
  ClaudeAdapter,
  COMMANDS,
  type IntakeRouter,
  type CLIFormatter,
  type PluginCommandRegistry,
  type CommandDefinition,
} from '../../adapters/claude_adapter';
import type { ClaudeIdentityResolver } from '../../adapters/claude_identity';
import type {
  CommandResult,
  FormattedMessage,
  ErrorResponse,
} from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Helpers: Mock factories
// ---------------------------------------------------------------------------

/** Create a mock IntakeRouter. */
function createMockRouter(
  routeImpl?: (command: unknown) => Promise<CommandResult>,
): IntakeRouter {
  return {
    route: routeImpl ?? (async () => ({ success: true, data: { ok: true } })),
  };
}

/** Create a mock ClaudeIdentityResolver. */
function createMockIdentityResolver(
  userId = 'test-user',
): ClaudeIdentityResolver {
  return {
    resolve: async () => userId,
  };
}

/** Create a mock CLIFormatter. */
function createMockFormatter(): CLIFormatter & {
  formatErrorCalls: ErrorResponse[];
} {
  const formatErrorCalls: ErrorResponse[] = [];
  const mkMsg = (text: string): FormattedMessage => ({
    channelType: 'claude_app',
    payload: text,
    fallbackText: text,
  });

  return {
    formatErrorCalls,
    formatError: (err: ErrorResponse) => {
      formatErrorCalls.push(err);
      return mkMsg(`ERROR: ${err.error}`);
    },
    formatSubmitSuccess: (data: unknown) => mkMsg(`Submit OK: ${JSON.stringify(data)}`),
    formatStatusCard: (data: unknown) => mkMsg(`Status: ${JSON.stringify(data)}`),
    formatList: (data: unknown) => mkMsg(`List: ${JSON.stringify(data)}`),
    formatGenericSuccess: (result: CommandResult) =>
      mkMsg(`OK: ${JSON.stringify(result.data)}`),
  };
}

/**
 * Create a mock PluginCommandRegistry that tracks registrations.
 *
 * Returns the registry and a map of registered command callbacks keyed
 * by command name, so tests can invoke them directly.
 */
function createMockRegistry(): {
  registry: PluginCommandRegistry;
  registeredCommands: Map<string, (rawArgs: string) => Promise<string>>;
  registeredDefinitions: CommandDefinition[];
  disposeCalls: string[];
} {
  const registeredCommands = new Map<
    string,
    (rawArgs: string) => Promise<string>
  >();
  const registeredDefinitions: CommandDefinition[] = [];
  const disposeCalls: string[] = [];

  const registry: PluginCommandRegistry = {
    registerCommand(
      definition: CommandDefinition,
      callback: (rawArgs: string) => Promise<string>,
    ) {
      registeredCommands.set(definition.name, callback);
      registeredDefinitions.push(definition);
      return {
        dispose() {
          disposeCalls.push(definition.name);
          registeredCommands.delete(definition.name);
        },
      };
    },
  };

  return { registry, registeredCommands, registeredDefinitions, disposeCalls };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('ClaudeAdapter (SPEC-008-2-01)', () => {
  // -----------------------------------------------------------------------
  // Test 1: start() registers commands
  // -----------------------------------------------------------------------
  describe('start() registers commands', () => {
    test('registerCommand is called exactly 10 times with the correct names', async () => {
      const { registry, registeredCommands } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      await adapter.start();

      expect(registeredCommands.size).toBe(10);

      const expectedNames = [
        'autonomous-dev:submit',
        'autonomous-dev:status',
        'autonomous-dev:list',
        'autonomous-dev:cancel',
        'autonomous-dev:pause',
        'autonomous-dev:resume',
        'autonomous-dev:priority',
        'autonomous-dev:logs',
        'autonomous-dev:feedback',
        'autonomous-dev:kill',
      ];

      for (const name of expectedNames) {
        expect(registeredCommands.has(name)).toBe(true);
      }
    });

    test('start() is idempotent -- second call returns the same handle', async () => {
      const { registry, registeredDefinitions } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      const handle1 = await adapter.start();
      const handle2 = await adapter.start();

      expect(handle1).toBe(handle2);
      // Commands should only be registered once
      expect(registeredDefinitions.length).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // Test 2: Command definition correctness
  // -----------------------------------------------------------------------
  describe('command definition correctness', () => {
    test('submit has 1 required arg and 4 flags', () => {
      const submit = COMMANDS.find((c) => c.name === 'autonomous-dev:submit')!;
      expect(submit.args).toHaveLength(1);
      expect(submit.args![0].name).toBe('description');
      expect(submit.args![0].required).toBe(true);
      expect(submit.flags).toHaveLength(4);
      const flagNames = submit.flags!.map((f) => f.name);
      expect(flagNames).toEqual(['priority', 'repo', 'deadline', 'force']);
    });

    test('submit priority flag defaults to "normal"', () => {
      const submit = COMMANDS.find((c) => c.name === 'autonomous-dev:submit')!;
      const priorityFlag = submit.flags!.find((f) => f.name === 'priority')!;
      expect(priorityFlag.default).toBe('normal');
      expect(priorityFlag.type).toBe('string');
    });

    test('submit force flag defaults to false', () => {
      const submit = COMMANDS.find((c) => c.name === 'autonomous-dev:submit')!;
      const forceFlag = submit.flags!.find((f) => f.name === 'force')!;
      expect(forceFlag.default).toBe(false);
      expect(forceFlag.type).toBe('boolean');
    });

    test('status has 1 required arg and no flags', () => {
      const status = COMMANDS.find((c) => c.name === 'autonomous-dev:status')!;
      expect(status.args).toHaveLength(1);
      expect(status.args![0].name).toBe('request-id');
      expect(status.args![0].required).toBe(true);
      expect(status.flags).toBeUndefined();
    });

    test('list has 0 args and 2 flags', () => {
      const list = COMMANDS.find((c) => c.name === 'autonomous-dev:list')!;
      expect(list.args).toBeUndefined();
      expect(list.flags).toHaveLength(2);
      const flagNames = list.flags!.map((f) => f.name);
      expect(flagNames).toEqual(['priority', 'status']);
    });

    test('cancel, pause, resume each have 1 required arg', () => {
      for (const name of ['cancel', 'pause', 'resume']) {
        const cmd = COMMANDS.find((c) => c.name === `autonomous-dev:${name}`)!;
        expect(cmd.args).toHaveLength(1);
        expect(cmd.args![0].name).toBe('request-id');
        expect(cmd.args![0].required).toBe(true);
      }
    });

    test('priority has 2 required args', () => {
      const priority = COMMANDS.find(
        (c) => c.name === 'autonomous-dev:priority',
      )!;
      expect(priority.args).toHaveLength(2);
      expect(priority.args![0].name).toBe('request-id');
      expect(priority.args![0].required).toBe(true);
      expect(priority.args![1].name).toBe('level');
      expect(priority.args![1].required).toBe(true);
    });

    test('logs has 1 required arg and 1 flag', () => {
      const logs = COMMANDS.find((c) => c.name === 'autonomous-dev:logs')!;
      expect(logs.args).toHaveLength(1);
      expect(logs.args![0].name).toBe('request-id');
      expect(logs.flags).toHaveLength(1);
      expect(logs.flags![0].name).toBe('all');
      expect(logs.flags![0].default).toBe(false);
    });

    test('feedback has 2 required args', () => {
      const feedback = COMMANDS.find(
        (c) => c.name === 'autonomous-dev:feedback',
      )!;
      expect(feedback.args).toHaveLength(2);
      expect(feedback.args![0].name).toBe('request-id');
      expect(feedback.args![1].name).toBe('message');
      expect(feedback.args![0].required).toBe(true);
      expect(feedback.args![1].required).toBe(true);
    });

    test('kill has 0 args and empty flags array', () => {
      const kill = COMMANDS.find((c) => c.name === 'autonomous-dev:kill')!;
      expect(kill.args).toBeUndefined();
      expect(kill.flags).toEqual([]);
    });

    test('all 10 commands have descriptions', () => {
      expect(COMMANDS).toHaveLength(10);
      for (const cmd of COMMANDS) {
        expect(cmd.description).toBeTruthy();
        expect(cmd.description.length).toBeGreaterThan(0);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Test 3: shutdown() waits for in-flight
  // -----------------------------------------------------------------------
  describe('shutdown() waits for in-flight commands', () => {
    test('shutdown resolves only after in-flight command completes', async () => {
      let resolveCommand: (() => void) | null = null;
      const slowRouter = createMockRouter(
        () =>
          new Promise<CommandResult>((resolve) => {
            resolveCommand = () => resolve({ success: true, data: {} });
          }),
      );

      const { registry, registeredCommands } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        slowRouter,
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      await adapter.start();

      // Start a slow command (don't await it)
      const cmdCallback = registeredCommands.get('autonomous-dev:status')!;
      const commandPromise = cmdCallback('REQ-000001');

      // Give the command time to start (increment inFlightCount)
      await new Promise((r) => setTimeout(r, 50));
      expect(adapter.currentInFlightCount).toBe(1);

      // Start shutdown (should wait for the in-flight command)
      let shutdownResolved = false;
      const shutdownPromise = adapter.shutdown().then(() => {
        shutdownResolved = true;
      });

      // Shutdown should not have resolved yet
      await new Promise((r) => setTimeout(r, 200));
      expect(shutdownResolved).toBe(false);

      // Complete the in-flight command
      resolveCommand!();
      await commandPromise;

      // Now shutdown should resolve
      await shutdownPromise;
      expect(shutdownResolved).toBe(true);
      expect(adapter.currentInFlightCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Test 4: Rejection during shutdown
  // -----------------------------------------------------------------------
  describe('rejection during shutdown', () => {
    test('commands invoked during shutdown return error message', async () => {
      const { registry, registeredCommands } = createMockRegistry();
      const formatter = createMockFormatter();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        formatter,
        registry,
      );

      await adapter.start();

      // Trigger shutdown (no in-flight commands, so it resolves immediately)
      await adapter.shutdown();
      expect(adapter.isShuttingDown).toBe(true);

      // The commands are disposed after shutdown, but let's test the flag
      // by creating a new adapter and manually testing handleCommand behavior.
      // Since commands are disposed, we need a different approach:
      // Create an adapter where we can invoke the callback before disposal.
      const { registry: reg2, registeredCommands: cmds2 } =
        createMockRegistry();
      const fmt2 = createMockFormatter();
      const adapter2 = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        fmt2,
        reg2,
      );

      await adapter2.start();

      // Grab the callback before shutdown
      const statusCb = cmds2.get('autonomous-dev:status')!;

      // Start shutdown but with a slow in-flight to keep it alive
      let resolveBlock: (() => void) | null = null;
      const blockRouter = createMockRouter(
        () =>
          new Promise<CommandResult>((resolve) => {
            resolveBlock = () => resolve({ success: true, data: {} });
          }),
      );

      // Create yet another adapter with the blocking router
      const {
        registry: reg3,
        registeredCommands: cmds3,
      } = createMockRegistry();
      const fmt3 = createMockFormatter();
      const adapter3 = new ClaudeAdapter(
        blockRouter,
        createMockIdentityResolver(),
        fmt3,
        reg3,
      );

      await adapter3.start();

      // Start a blocking command
      const blockingCb = cmds3.get('autonomous-dev:list')!;
      const blockingPromise = blockingCb('');

      await new Promise((r) => setTimeout(r, 50));

      // Begin shutdown (adapter3 is now shuttingDown but waiting)
      const shutdownPromise = adapter3.shutdown();

      // Try to invoke another command while shutting down
      const submitCb = cmds3.get('autonomous-dev:submit')!;
      const result = await submitCb('"test feature" --priority high');

      expect(result).toContain('System is shutting down.');
      expect(fmt3.formatErrorCalls.length).toBeGreaterThan(0);
      expect(fmt3.formatErrorCalls[0].errorCode).toBe('INVALID_STATE');

      // Cleanup: resolve the blocking command so shutdown can finish
      resolveBlock!();
      await blockingPromise;
      await shutdownPromise;
    });
  });

  // -----------------------------------------------------------------------
  // Test 5: InFlightCount tracking
  // -----------------------------------------------------------------------
  describe('inFlightCount tracking', () => {
    test('tracks concurrent commands and reaches 0 after completion', async () => {
      const resolvers: Array<(value: CommandResult) => void> = [];
      const slowRouter = createMockRouter(
        () =>
          new Promise<CommandResult>((resolve) => {
            resolvers.push(resolve);
          }),
      );

      const { registry, registeredCommands } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        slowRouter,
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      await adapter.start();

      // Start 3 concurrent commands
      const cb1 = registeredCommands.get('autonomous-dev:status')!;
      const cb2 = registeredCommands.get('autonomous-dev:list')!;
      const cb3 = registeredCommands.get('autonomous-dev:logs')!;

      const p1 = cb1('REQ-000001');
      const p2 = cb2('');
      const p3 = cb3('REQ-000002 --all');

      // Wait for them to register as in-flight
      await new Promise((r) => setTimeout(r, 50));
      expect(adapter.currentInFlightCount).toBe(3);

      // Resolve all 3
      for (const resolve of resolvers) {
        resolve({ success: true, data: {} });
      }

      await Promise.all([p1, p2, p3]);
      expect(adapter.currentInFlightCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Test 6: AdapterHandle dispose
  // -----------------------------------------------------------------------
  describe('AdapterHandle dispose', () => {
    test('dispose() delegates to shutdown()', async () => {
      const { registry, disposeCalls } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      const handle = await adapter.start();
      expect(adapter.isShuttingDown).toBe(false);

      await handle.dispose();

      expect(adapter.isShuttingDown).toBe(true);
      // All commands should have been disposed
      expect(disposeCalls.length).toBe(10);
    });
  });

  // -----------------------------------------------------------------------
  // Additional: channelType
  // -----------------------------------------------------------------------
  describe('channelType', () => {
    test('returns "claude_app"', () => {
      const { registry } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      expect(adapter.channelType).toBe('claude_app');
    });
  });

  // -----------------------------------------------------------------------
  // Test 7: sendMessage() writes to stdout
  // -----------------------------------------------------------------------
  describe('sendMessage()', () => {
    test('writes payload when stdout is a TTY', async () => {
      const { registry } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      // Mock stdout.write and isTTY
      const originalWrite = process.stdout.write;
      const originalIsTTY = process.stdout.isTTY;
      const written: string[] = [];
      process.stdout.write = ((chunk: string) => {
        written.push(chunk);
        return true;
      }) as typeof process.stdout.write;
      process.stdout.isTTY = true;

      try {
        const target = { channelType: 'claude_app' as const };
        const payload: FormattedMessage = {
          channelType: 'claude_app',
          payload: 'ANSI formatted output',
          fallbackText: 'Plain text output',
        };

        const receipt = await adapter.sendMessage(target, payload);

        expect(receipt.success).toBe(true);
        expect(written).toContain('ANSI formatted output\n');
      } finally {
        process.stdout.write = originalWrite;
        process.stdout.isTTY = originalIsTTY;
      }
    });

    test('writes fallbackText when stdout is not a TTY', async () => {
      const { registry } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      const originalWrite = process.stdout.write;
      const originalIsTTY = process.stdout.isTTY;
      const written: string[] = [];
      process.stdout.write = ((chunk: string) => {
        written.push(chunk);
        return true;
      }) as typeof process.stdout.write;
      (process.stdout as { isTTY?: boolean }).isTTY = undefined;

      try {
        const target = { channelType: 'claude_app' as const };
        const payload: FormattedMessage = {
          channelType: 'claude_app',
          payload: 'ANSI formatted output',
          fallbackText: 'Plain text output',
        };

        const receipt = await adapter.sendMessage(target, payload);

        expect(receipt.success).toBe(true);
        expect(written).toContain('Plain text output\n');
      } finally {
        process.stdout.write = originalWrite;
        process.stdout.isTTY = originalIsTTY;
      }
    });
  });

  // -----------------------------------------------------------------------
  // Test 8: promptUser()
  // -----------------------------------------------------------------------
  describe('promptUser()', () => {
    test('returns timeout when prompt expires (stub implementation)', async () => {
      const { registry } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      const target = { channelType: 'claude_app' as const };
      const prompt = {
        promptType: 'clarifying_question' as const,
        requestId: 'REQ-000001',
        content: 'Please confirm the target repo.',
        timeoutSeconds: 30,
      };

      const result = await adapter.promptUser(target, prompt);

      // The current stub always returns timeout
      expect('kind' in result).toBe(true);
      expect((result as { kind: string }).kind).toBe('timeout');
      expect((result as { requestId: string }).requestId).toBe('REQ-000001');
    });

    test('timeout result includes promptedAt and expiredAt timestamps', async () => {
      const { registry } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        createMockRouter(),
        createMockIdentityResolver(),
        createMockFormatter(),
        registry,
      );

      const target = { channelType: 'claude_app' as const };
      const prompt = {
        promptType: 'approval_request' as const,
        requestId: 'REQ-000042',
        content: 'Approve this request?',
        timeoutSeconds: 60,
      };

      const result = await adapter.promptUser(target, prompt);

      expect('kind' in result).toBe(true);
      const timeout = result as { kind: string; promptedAt: Date; expiredAt: Date };
      expect(timeout.promptedAt).toBeInstanceOf(Date);
      expect(timeout.expiredAt).toBeInstanceOf(Date);
    });
  });

  // -----------------------------------------------------------------------
  // Additional: command pipeline integration
  // -----------------------------------------------------------------------
  describe('command pipeline', () => {
    test('routes command through router and returns formatted result', async () => {
      const routedCommands: unknown[] = [];
      const router = createMockRouter(async (command) => {
        routedCommands.push(command);
        return { success: true, data: { requestId: 'REQ-000001' } };
      });

      const { registry, registeredCommands } = createMockRegistry();
      const adapter = new ClaudeAdapter(
        router,
        createMockIdentityResolver('admin-user'),
        createMockFormatter(),
        registry,
      );

      await adapter.start();

      const submitCb = registeredCommands.get('autonomous-dev:submit')!;
      const output = await submitCb('"Build user auth" --priority high');

      expect(routedCommands.length).toBe(1);
      expect(output).toContain('REQ-000001');
    });

    test('formats router errors through formatter', async () => {
      const router = createMockRouter(async () => ({
        success: false,
        error: 'Permission denied: need admin',
        errorCode: 'AUTHZ_DENIED',
      }));

      const { registry, registeredCommands } = createMockRegistry();
      const formatter = createMockFormatter();
      const adapter = new ClaudeAdapter(
        router,
        createMockIdentityResolver(),
        formatter,
        registry,
      );

      await adapter.start();

      const killCb = registeredCommands.get('autonomous-dev:kill')!;
      const output = await killCb('');

      expect(output).toContain('Permission denied: need admin');
      expect(formatter.formatErrorCalls[0].errorCode).toBe('AUTHZ_DENIED');
    });

    test('validation error is caught before reaching router', async () => {
      const routedCommands: unknown[] = [];
      const router = createMockRouter(async (command) => {
        routedCommands.push(command);
        return { success: true, data: {} };
      });

      const { registry, registeredCommands } = createMockRegistry();
      const formatter = createMockFormatter();
      const adapter = new ClaudeAdapter(
        router,
        createMockIdentityResolver(),
        formatter,
        registry,
      );

      await adapter.start();

      // Status with invalid request ID should fail validation
      const statusCb = registeredCommands.get('autonomous-dev:status')!;
      const output = await statusCb('BAD-ID');

      // Should not have reached the router
      expect(routedCommands.length).toBe(0);
      expect(output).toContain('Invalid request ID format');
      expect(formatter.formatErrorCalls[0].errorCode).toBe('VALIDATION_ERROR');
    });

    test('handles unexpected router errors gracefully', async () => {
      const router = createMockRouter(async () => {
        throw new Error('Unexpected database failure');
      });

      const { registry, registeredCommands } = createMockRegistry();
      const formatter = createMockFormatter();
      const adapter = new ClaudeAdapter(
        router,
        createMockIdentityResolver(),
        formatter,
        registry,
      );

      await adapter.start();

      const listCb = registeredCommands.get('autonomous-dev:list')!;
      const output = await listCb('');

      expect(output).toContain('An internal error occurred.');
      expect(formatter.formatErrorCalls[0].errorCode).toBe('INTERNAL_ERROR');
    });
  });
});
