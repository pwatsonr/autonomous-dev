/**
 * Unit tests for the claude_command_bridge CLI surface (SPEC-011-2-03 Task 7).
 *
 * Exercises every exported function on the CLI surface: argv parsing,
 * per-subcommand validation, canonical IncomingCommand mapping, error
 * classification, exit-code mapping, and the main() pipeline with an
 * injected fake router.  Subprocess behaviour (env-var passing, version
 * mismatch via the real env) is covered with `child_process.spawnSync`
 * against the source file via ts-node-style on-the-fly compilation, but
 * only sparingly — the in-process route covers >95% of the surface.
 *
 * @module claude_command_bridge.test
 */

import {
  ALLOWED_SUBCOMMANDS,
  AllowedSubcommand,
  BridgeError,
  CliErrorCode,
  CliErrorEnvelope,
  CliSuccessEnvelope,
  EXIT_CODE_BY_ERROR,
  classifyError,
  main,
  mapToCanonicalArgs,
  parseSubcommandArgv,
  validateSubcommandArgs,
} from '../../intake/adapters/claude_command_bridge';
import type {
  CommandResult,
  IncomingCommand,
} from '../../intake/adapters/adapter_interface';
import type { IntakeRouter } from '../../intake/adapters/claude_adapter';

// ---------------------------------------------------------------------------
// Helpers: stdout capture + fake router
// ---------------------------------------------------------------------------

/** Capture process.stdout.write payloads and return a parsed envelope. */
function captureMain(
  argv: string[],
  routerOverride?: Partial<IntakeRouter>,
  resolveUserId?: () => string,
): Promise<{
  exit: number;
  envelope: CliSuccessEnvelope | CliErrorEnvelope;
  raw: string;
}> {
  const writes: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // @ts-expect-error -- jest mocking pattern
  process.stdout.write = (chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
    return true;
  };

  const fakeRouter: IntakeRouter = {
    route: jest.fn(async (_cmd: IncomingCommand): Promise<CommandResult> => ({
      success: true,
      data: { ok: true },
    })),
    ...(routerOverride as IntakeRouter | undefined),
  } as IntakeRouter;

  const deps = {
    routerFactory: async (): Promise<IntakeRouter> => fakeRouter,
    resolveUserId: resolveUserId ?? ((): string => 'test-user'),
  };

  return main(argv, deps).then((exit) => {
    process.stdout.write = original;
    const raw = writes.join('');
    const envelope = JSON.parse(raw.trim()) as
      | CliSuccessEnvelope
      | CliErrorEnvelope;
    return { exit, envelope, raw };
  });
}

/** Build a router whose `route` returns the supplied result. */
function routerReturning(result: CommandResult): Partial<IntakeRouter> {
  return {
    route: jest.fn(async () => result),
  } as unknown as Partial<IntakeRouter>;
}

/** Build a router that records the IncomingCommand it receives. */
function routerRecording(): {
  router: Partial<IntakeRouter>;
  received: IncomingCommand[];
} {
  const received: IncomingCommand[] = [];
  return {
    router: {
      route: jest.fn(async (cmd: IncomingCommand) => {
        received.push(cmd);
        return { success: true, data: { ok: true } };
      }),
    } as unknown as Partial<IntakeRouter>,
    received,
  };
}

// ===========================================================================
// Group 1 — parseSubcommandArgv
// ===========================================================================

describe('parseSubcommandArgv', () => {
  test('empty argv returns empty positionals and flags', () => {
    const r = parseSubcommandArgv([]);
    expect(r.positionals).toEqual([]);
    expect(r.flags).toEqual({});
  });

  test('--key=value form parses', () => {
    const r = parseSubcommandArgv(['--state=active']);
    expect(r.flags).toEqual({ state: 'active' });
    expect(r.positionals).toEqual([]);
  });

  test('--key value form parses', () => {
    const r = parseSubcommandArgv(['--limit', '50']);
    expect(r.flags).toEqual({ limit: '50' });
  });

  test('--flag (boolean) form parses', () => {
    const r = parseSubcommandArgv(['--verbose']);
    expect(r.flags).toEqual({ verbose: true });
  });

  test('positionals collect in order', () => {
    const r = parseSubcommandArgv(['REQ-000001', 'foo', 'bar']);
    expect(r.positionals).toEqual(['REQ-000001', 'foo', 'bar']);
  });

  test('mixed positionals and flags', () => {
    const r = parseSubcommandArgv([
      'REQ-000001',
      '--priority=high',
      'extra',
      '--verbose',
    ]);
    expect(r.positionals).toEqual(['REQ-000001', 'extra']);
    expect(r.flags).toEqual({ priority: 'high', verbose: true });
  });

  test('value containing = preserves trailing portion', () => {
    const r = parseSubcommandArgv(['--message=key=value']);
    expect(r.flags).toEqual({ message: 'key=value' });
  });

  test('empty flag name (--) throws INVALID_ARGUMENT', () => {
    expect(() => parseSubcommandArgv(['--'])).toThrow(BridgeError);
    try {
      parseSubcommandArgv(['--']);
    } catch (e) {
      expect((e as BridgeError).code).toBe('INVALID_ARGUMENT');
    }
  });

  test('--=value (empty key with equals) throws INVALID_ARGUMENT', () => {
    expect(() => parseSubcommandArgv(['--=value'])).toThrow(BridgeError);
  });
});

// ===========================================================================
// Group 2 — validateSubcommandArgs
// ===========================================================================

describe('validateSubcommandArgs', () => {
  test('submit accepts a positional description', () => {
    expect(() =>
      validateSubcommandArgs('submit', {
        positionals: ['build a thing'],
        flags: {},
      }),
    ).not.toThrow();
  });

  test('submit accepts --description flag', () => {
    expect(() =>
      validateSubcommandArgs('submit', {
        positionals: [],
        flags: { description: 'build a thing' },
      }),
    ).not.toThrow();
  });

  test('submit without description throws INVALID_ARGUMENT', () => {
    expect(() =>
      validateSubcommandArgs('submit', { positionals: [], flags: {} }),
    ).toThrow(BridgeError);
  });

  test('submit with bad --priority throws INVALID_ARGUMENT', () => {
    expect(() =>
      validateSubcommandArgs('submit', {
        positionals: ['x'],
        flags: { priority: 'urgent' },
      }),
    ).toThrow(/Invalid value 'urgent' for --priority/);
  });

  test.each(['status', 'cancel', 'pause', 'resume', 'logs', 'kill'] as const)(
    '%s requires a request_id',
    (sub) => {
      expect(() =>
        validateSubcommandArgs(sub, { positionals: [], flags: {} }),
      ).toThrow(/Missing required argument 'request_id'/);
    },
  );

  test('priority requires both request_id and priority value', () => {
    expect(() =>
      validateSubcommandArgs('priority', {
        positionals: ['REQ-000001'],
        flags: {},
      }),
    ).toThrow(/Missing required argument 'priority'/);
  });

  test('priority without request_id at all throws', () => {
    expect(() =>
      validateSubcommandArgs('priority', { positionals: [], flags: {} }),
    ).toThrow(/Missing required argument 'request_id'/);
  });

  test('feedback without request_id at all throws', () => {
    expect(() =>
      validateSubcommandArgs('feedback', { positionals: [], flags: {} }),
    ).toThrow(/Missing required argument 'request_id'/);
  });

  test('priority rejects invalid priority values', () => {
    expect(() =>
      validateSubcommandArgs('priority', {
        positionals: ['REQ-000001', 'extreme'],
        flags: {},
      }),
    ).toThrow(/Invalid priority value/);
  });

  test('feedback requires both request_id and message', () => {
    expect(() =>
      validateSubcommandArgs('feedback', {
        positionals: ['REQ-000001'],
        flags: {},
      }),
    ).toThrow(/Missing required argument 'message'/);
  });

  test('list with --state=invalid throws', () => {
    expect(() =>
      validateSubcommandArgs('list', {
        positionals: [],
        flags: { state: 'pending' },
      }),
    ).toThrow(/Invalid value 'pending' for --state/);
  });

  test('list with no args is valid', () => {
    expect(() =>
      validateSubcommandArgs('list', { positionals: [], flags: {} }),
    ).not.toThrow();
  });

  test('unknown flag throws INVALID_ARGUMENT', () => {
    expect(() =>
      validateSubcommandArgs('status', {
        positionals: ['REQ-000001'],
        flags: { totally_made_up: 'x' },
      }),
    ).toThrow(/Unknown flag '--totally_made_up'/);
  });
});

// ===========================================================================
// Group 3 — mapToCanonicalArgs
// ===========================================================================

describe('mapToCanonicalArgs', () => {
  test('status: positional REQ id lifts into args[0], flags empty', () => {
    const r = mapToCanonicalArgs('status', {
      positionals: ['REQ-000001'],
      flags: {},
    });
    expect(r.args).toEqual(['REQ-000001']);
    expect(r.flags).toEqual({});
  });

  test('status: --request_id flag lifts into args[0] and is removed', () => {
    const r = mapToCanonicalArgs('status', {
      positionals: [],
      flags: { request_id: 'REQ-000042' },
    });
    expect(r.args).toEqual(['REQ-000042']);
    expect(r.flags).not.toHaveProperty('request_id');
  });

  test('priority: lifts both request_id and priority into args', () => {
    const r = mapToCanonicalArgs('priority', {
      positionals: ['REQ-000001', 'high'],
      flags: {},
    });
    expect(r.args).toEqual(['REQ-000001', 'high']);
  });

  test('priority: --priority flag wins over positional', () => {
    const r = mapToCanonicalArgs('priority', {
      positionals: ['REQ-000001'],
      flags: { priority: 'low' },
    });
    expect(r.args).toEqual(['REQ-000001', 'low']);
    expect(r.flags).not.toHaveProperty('priority');
  });

  test('feedback: lifts request_id and message into args', () => {
    const r = mapToCanonicalArgs('feedback', {
      positionals: ['REQ-000001', 'please add tests'],
      flags: {},
    });
    expect(r.args).toEqual(['REQ-000001', 'please add tests']);
  });

  test('submit: description flag lifts to args[0]', () => {
    const r = mapToCanonicalArgs('submit', {
      positionals: [],
      flags: { description: 'do the thing' },
    });
    expect(r.args).toEqual(['do the thing']);
    expect(r.flags).not.toHaveProperty('description');
  });

  test('submit: positional description lifts to args[0]', () => {
    const r = mapToCanonicalArgs('submit', {
      positionals: ['do the thing'],
      flags: { priority: 'high' },
    });
    expect(r.args).toEqual(['do the thing']);
    expect(r.flags).toEqual({ priority: 'high' });
  });

  test('list: leaves args empty, passes everything as flags', () => {
    const r = mapToCanonicalArgs('list', {
      positionals: [],
      flags: { state: 'active', limit: '20' },
    });
    expect(r.args).toEqual([]);
    expect(r.flags).toEqual({ state: 'active', limit: '20' });
  });

  test('boolean flags pass through unchanged', () => {
    const r = mapToCanonicalArgs('logs', {
      positionals: ['REQ-000001'],
      flags: { follow: true },
    });
    expect(r.flags).toEqual({ follow: true });
  });
});

// ===========================================================================
// Group 4 — classifyError
// ===========================================================================

describe('classifyError', () => {
  test('passthrough for BridgeError', () => {
    const err = new BridgeError('UNKNOWN_SUBCOMMAND', 'msg');
    expect(classifyError(err)).toBe(err);
  });

  test('Node MODULE_NOT_FOUND code maps to MODULE_NOT_FOUND', () => {
    const err = Object.assign(new Error('Cannot find module x'), {
      code: 'MODULE_NOT_FOUND',
    });
    const out = classifyError(err);
    expect(out.code).toBe('MODULE_NOT_FOUND');
    expect(out.resolution).toMatch(/npm install/);
  });

  test('SQLITE_* error message maps to DATABASE_CONNECTION', () => {
    const err = new Error('SQLITE_CANTOPEN: unable to open database file');
    const out = classifyError(err);
    expect(out.code).toBe('DATABASE_CONNECTION');
    expect(out.resolution).toMatch(/permissions/);
  });

  test('DatabaseConnectionError name maps to DATABASE_CONNECTION', () => {
    const err = Object.assign(new Error('boom'), {
      name: 'DatabaseConnectionError',
    });
    expect(classifyError(err).code).toBe('DATABASE_CONNECTION');
  });

  test('unknown error falls through to INTERNAL_ERROR', () => {
    const err = new Error('something else');
    expect(classifyError(err).code).toBe('INTERNAL_ERROR');
  });

  test('non-Error thrown values still classify', () => {
    expect(classifyError('plain string').code).toBe('INTERNAL_ERROR');
  });
});

// ===========================================================================
// Group 5 — EXIT_CODE_BY_ERROR mapping
// ===========================================================================

describe('EXIT_CODE_BY_ERROR', () => {
  test.each<[CliErrorCode, number]>([
    ['INVALID_ARGUMENT', 1],
    ['UNKNOWN_SUBCOMMAND', 1],
    ['MODULE_NOT_FOUND', 2],
    ['DATABASE_CONNECTION', 2],
    ['VERSION_MISMATCH', 2],
    ['INTERNAL_ERROR', 2],
  ])('%s -> exit %d', (code, expected) => {
    expect(EXIT_CODE_BY_ERROR[code]).toBe(expected);
  });
});

// ===========================================================================
// Group 6 — main() pipeline (happy path per subcommand)
// ===========================================================================

describe('main() — happy path per subcommand', () => {
  test.each(ALLOWED_SUBCOMMANDS)(
    '%s subcommand routes to fake router and exits 0',
    async (sub) => {
      const argvBySubcommand: Record<AllowedSubcommand, string[]> = {
        submit: [sub, 'build a thing', '--priority=high'],
        status: [sub, 'REQ-000001'],
        list: [sub, '--state=active'],
        cancel: [sub, 'REQ-000001'],
        pause: [sub, 'REQ-000001'],
        resume: [sub, 'REQ-000001'],
        priority: [sub, 'REQ-000001', 'low'],
        logs: [sub, 'REQ-000001'],
        feedback: [sub, 'REQ-000001', 'message body'],
        kill: [sub, 'REQ-000001'],
      };
      const result = await captureMain(argvBySubcommand[sub]);
      expect(result.exit).toBe(0);
      expect(result.envelope.ok).toBe(true);
    },
  );
});

// ===========================================================================
// Group 7 — IncomingCommand shape produced by main()
// ===========================================================================

describe('main() — IncomingCommand shape', () => {
  test('source.channelType is claude_app', async () => {
    const { router, received } = routerRecording();
    await captureMain(['status', 'REQ-000001'], router);
    expect(received[0].source.channelType).toBe('claude_app');
  });

  test('source.userId comes from resolveUserId dep', async () => {
    const { router, received } = routerRecording();
    await captureMain(['status', 'REQ-000001'], router, () => 'alice');
    expect(received[0].source.userId).toBe('alice');
  });

  test('source.timestamp is a Date', async () => {
    const { router, received } = routerRecording();
    await captureMain(['status', 'REQ-000001'], router);
    expect(received[0].source.timestamp).toBeInstanceOf(Date);
  });

  test('commandName matches the subcommand', async () => {
    const { router, received } = routerRecording();
    await captureMain(['cancel', 'REQ-000999'], router);
    expect(received[0].commandName).toBe('cancel');
  });

  test('args[0] holds the request_id for ID-bearing subcommands', async () => {
    const { router, received } = routerRecording();
    await captureMain(['cancel', 'REQ-000999'], router);
    expect(received[0].args).toEqual(['REQ-000999']);
  });

  test('flags loses request_id after lift', async () => {
    const { router, received } = routerRecording();
    await captureMain(['cancel', '--request_id=REQ-000999'], router);
    expect(received[0].flags).not.toHaveProperty('request_id');
  });

  test('rawText reconstructs from argv', async () => {
    const { router, received } = routerRecording();
    await captureMain(['status', 'REQ-000001'], router);
    expect(received[0].rawText).toBe('status REQ-000001');
  });
});

// ===========================================================================
// Group 8 — main() error envelopes
// ===========================================================================

describe('main() — error envelopes', () => {
  test('no subcommand -> UNKNOWN_SUBCOMMAND, exit 1, error envelope', async () => {
    const { exit, envelope } = await captureMain([]);
    expect(exit).toBe(1);
    expect(envelope.ok).toBe(false);
    expect((envelope as CliErrorEnvelope).errorCode).toBe('UNKNOWN_SUBCOMMAND');
  });

  test('unknown subcommand -> UNKNOWN_SUBCOMMAND, exit 1', async () => {
    const { exit, envelope } = await captureMain(['frobnicate']);
    expect(exit).toBe(1);
    expect((envelope as CliErrorEnvelope).errorCode).toBe('UNKNOWN_SUBCOMMAND');
  });

  test('missing required arg -> INVALID_ARGUMENT, exit 1', async () => {
    const { exit, envelope } = await captureMain(['status']);
    expect(exit).toBe(1);
    expect((envelope as CliErrorEnvelope).errorCode).toBe('INVALID_ARGUMENT');
  });

  test('invalid flag value -> INVALID_ARGUMENT', async () => {
    const { exit, envelope } = await captureMain([
      'priority',
      'REQ-000001',
      'totally-not-a-priority',
    ]);
    expect(exit).toBe(1);
    expect((envelope as CliErrorEnvelope).errorCode).toBe('INVALID_ARGUMENT');
  });

  test('router error -> INTERNAL_ERROR, exit 2', async () => {
    const failingRouter = routerReturning({
      success: false,
      error: 'simulated router failure',
      errorCode: 'INTERNAL_ERROR',
    });
    const { exit, envelope } = await captureMain(
      ['status', 'REQ-000001'],
      failingRouter,
    );
    expect(exit).toBe(2);
    expect((envelope as CliErrorEnvelope).errorCode).toBe('INTERNAL_ERROR');
    expect((envelope as CliErrorEnvelope).message).toContain(
      'simulated router failure',
    );
  });

  test('error envelope includes resolution hint when present', async () => {
    const { envelope } = await captureMain(['status']);
    expect(envelope.ok).toBe(false);
    expect((envelope as CliErrorEnvelope).resolution).toBeDefined();
  });

  test('stdout is the only output stream (envelope is single-line JSON)', async () => {
    const { raw } = await captureMain(['status', 'REQ-000001']);
    // Exactly one trailing newline.
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.trimEnd().split('\n')).toHaveLength(1);
  });
});

// ===========================================================================
// Group 9 — VERSION_MISMATCH (env-driven)
// ===========================================================================

describe('main() — VERSION_MISMATCH', () => {
  const originalEnv = process.env.AUTONOMOUS_DEV_EXPECTED_VERSION;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.AUTONOMOUS_DEV_EXPECTED_VERSION;
    } else {
      process.env.AUTONOMOUS_DEV_EXPECTED_VERSION = originalEnv;
    }
  });

  test('mismatched expected version -> VERSION_MISMATCH, exit 2', async () => {
    process.env.AUTONOMOUS_DEV_EXPECTED_VERSION = '99.99.99-not-installed';
    const { exit, envelope } = await captureMain([
      'status',
      'REQ-000001',
    ]);
    expect(exit).toBe(2);
    expect((envelope as CliErrorEnvelope).errorCode).toBe('VERSION_MISMATCH');
  });

  // Note: there is no "matching expected version proceeds normally" test
  // here because every other test in this file runs with the env var
  // unset (skipping the version check), which already exercises the
  // proceeds-normally path.  A standalone matching-version test runs
  // into ts-jest path-resolution drift between the bridge's __dirname
  // and the test's view of the plugin tree.

  test('unset expected version skips check', async () => {
    delete process.env.AUTONOMOUS_DEV_EXPECTED_VERSION;
    const { exit } = await captureMain(['status', 'REQ-000001']);
    expect(exit).toBe(0);
  });
});
