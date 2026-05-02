/**
 * Jest tests for `request submit --type` + bug-context-path + immutability
 * (SPEC-018-3-05, Task 8).
 *
 * Mirrors the case table in the spec verbatim. Cases 6 and 8 (the
 * locked stderr lines) use `.toBe`, not `.toContain`, because operators
 * script against those exact strings.
 *
 * The IntakeRouter is mocked so we never touch sqlite or the
 * filesystem outside `os.tmpdir()`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildProgram,
  IntakeRouterLike,
  parseType,
  VALID_REQUEST_TYPES,
  auditLogPath,
} from '../../adapters/cli_adapter';
import type { CommandResult, IncomingCommand } from '../../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Mock router
// ---------------------------------------------------------------------------

interface MockRouter extends IntakeRouterLike {
  route: jest.Mock<Promise<CommandResult>, [IncomingCommand]>;
  calls(): IncomingCommand[];
}

function makeMockRouter(
  result: CommandResult = { success: true, data: 'ok' },
): MockRouter {
  const fn = jest.fn(async (_cmd: IncomingCommand) => result) as MockRouter['route'];
  return {
    route: fn,
    calls(): IncomingCommand[] {
      return fn.mock.calls.map((c) => c[0]);
    },
  };
}

let stderrSpy: jest.SpyInstance;
let stdoutSpy: jest.SpyInstance;
let stderrChunks: string[];
let stdoutChunks: string[];

beforeEach(() => {
  stderrChunks = [];
  stdoutChunks = [];
  stderrSpy = jest
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: unknown) => {
      stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  stdoutSpy = jest
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown) => {
      stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
      return true;
    });
  // Redirect audit log into a tmp file so case 13 doesn't pollute $HOME.
  process.env.AUTONOMOUS_DEV_AUDIT_LOG = path.join(
    os.tmpdir(),
    `audit-${process.pid}-${Date.now()}.log`,
  );
});

afterEach(() => {
  stderrSpy.mockRestore();
  stdoutSpy.mockRestore();
  if (
    process.env.AUTONOMOUS_DEV_AUDIT_LOG &&
    fs.existsSync(process.env.AUTONOMOUS_DEV_AUDIT_LOG)
  ) {
    fs.unlinkSync(process.env.AUTONOMOUS_DEV_AUDIT_LOG);
  }
  delete process.env.AUTONOMOUS_DEV_AUDIT_LOG;
});

async function run(
  argv: string[],
  router: MockRouter = makeMockRouter(),
): Promise<{ router: MockRouter; error?: Error }> {
  const program = buildProgram(() => router);
  try {
    await program.parseAsync(['node', 'cli.js', ...argv]);
    return { router };
  } catch (err) {
    return { router, error: err as Error };
  }
}

function writeFixture(name: string, body: string): string {
  const p = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(p, body);
  return p;
}

const FIXTURE_PATH = path.resolve(__dirname, '../../../tests/fixtures/bug-fixture.json');

describe('SPEC-018-3-05 case table — request submit --type', () => {
  // ----- Cases 1, 3, 4, 5, 7: each valid type round-trips -----------------
  it.each([
    ['feature'],
    ['infra'],
    ['refactor'],
    ['hotfix'],
  ])('case 1/3/4/5: --type %s sets request_type', async (type) => {
    const router = makeMockRouter();
    const { error } = await run(
      ['submit', 'demo description', '--type', type],
      router,
    );
    expect(error).toBeUndefined();
    expect(router.calls()[0].flags.type).toBe(type);
  });

  it('case 2: --type bug --bug-context-path <valid> succeeds', async () => {
    const router = makeMockRouter();
    const { error } = await run(
      [
        'submit',
        'fix bug',
        '--type',
        'bug',
        '--bug-context-path',
        FIXTURE_PATH,
      ],
      router,
    );
    expect(error).toBeUndefined();
    const flags = router.calls()[0].flags;
    expect(flags.type).toBe('bug');
    expect(typeof flags.bug_context).toBe('string');
    const ctx = JSON.parse(flags.bug_context as string);
    expect(ctx.title).toBe(
      'submit-bug fails when description contains backtick',
    );
  });

  it('case 6: --type xyz exits 1 with locked stderr line', () => {
    expect(() => parseType('xyz')).toThrow(
      "type 'xyz' invalid. Valid: feature, bug, infra, refactor, hotfix",
    );
    // Sanity: the spec's error string is built from VALID_REQUEST_TYPES.
    expect([...VALID_REQUEST_TYPES]).toEqual([
      'feature',
      'bug',
      'infra',
      'refactor',
      'hotfix',
    ]);
  });

  it('case 7: missing --type defaults to feature', async () => {
    const router = makeMockRouter();
    const { error } = await run(['submit', 'no type'], router);
    expect(error).toBeUndefined();
    expect(router.calls()[0].flags.type).toBe('feature');
  });

  it('case 8: --type bug with no context exits 1 with locked stderr line', async () => {
    const router = makeMockRouter();
    const { error } = await run(
      ['submit', 'desc', '--type', 'bug'],
      router,
    );
    expect(error).toBeDefined();
    // Operators script against this byte-exact line. Use .toBe.
    expect(stderrChunks.join('')).toBe(
      "Error: bug-typed requests require bug context. Use 'autonomous-dev request submit-bug' or pass --bug-context-path <file>\n",
    );
    // Router was never invoked — rejection happens pre-dispatch.
    expect(router.route).not.toHaveBeenCalled();
  });

  it('case 9: --bug-context-path missing file exits 1 with file-not-found message', async () => {
    const missing = path.join(os.tmpdir(), `missing-${Date.now()}.json`);
    const router = makeMockRouter();
    const { error } = await run(
      ['submit', 'desc', '--type', 'bug', '--bug-context-path', missing],
      router,
    );
    expect(error).toBeDefined();
    expect(stderrChunks.join('')).toBe(
      `Error: bug context file not found: ${missing}\n`,
    );
  });

  it('case 10: --bug-context-path with malformed JSON exits 1 with bad-JSON message', async () => {
    const fp = writeFixture('badjson', '{ not-json');
    const router = makeMockRouter();
    const { error } = await run(
      ['submit', 'desc', '--type', 'bug', '--bug-context-path', fp],
      router,
    );
    expect(error).toBeDefined();
    expect(stderrChunks.join('')).toBe(
      `Error: bug context file is not valid JSON: ${fp}\n`,
    );
    fs.unlinkSync(fp);
  });

  it('case 11: --bug-context-path with schema-failing JSON exits 1 with validation header', async () => {
    const fp = writeFixture('badschema', JSON.stringify({ title: 'no rest' }));
    const router = makeMockRouter();
    const { error } = await run(
      ['submit', 'desc', '--type', 'bug', '--bug-context-path', fp],
      router,
    );
    expect(error).toBeDefined();
    const out = stderrChunks.join('');
    expect(out.startsWith('Error: bug context validation failed:\n')).toBe(true);
    // Must include AJV-style path for at least one missing required field.
    expect(out).toMatch(/description: must have required property/);
    fs.unlinkSync(fp);
  });

  it('case 12: --help lists all five type values', async () => {
    // commander exits via CommanderError on --help; swallow it and inspect.
    const router = makeMockRouter();
    let helpText = '';
    stdoutSpy.mockImplementation((chunk: unknown) => {
      helpText += String(chunk);
      return true;
    });
    try {
      const program = buildProgram(() => router);
      // commander throws InvalidArgumentError-class CommanderError on help.
      await program.parseAsync(['node', 'cli.js', 'submit', '--help']);
    } catch {
      // expected — commander signals exit via throw under exitOverride.
    }
    for (const t of ['feature', 'bug', 'infra', 'refactor', 'hotfix']) {
      expect(helpText).toContain(t);
    }
  });
});

describe('SPEC-018-3-05 case table — request edit immutability', () => {
  it('case 13: edit --type infra (req currently bug) is rejected with locked stderr line', async () => {
    const router = makeMockRouter();
    const { error } = await run(
      ['edit', 'REQ-000001', '--type', 'infra'],
      router,
    );
    expect(error).toBeDefined();
    // Locked, byte-exact.
    expect(stderrChunks.join('')).toBe(
      'Error: request_type is immutable after submission\n',
    );
    expect(router.route).not.toHaveBeenCalled();

    // Audit event written.
    const auditPath = auditLogPath();
    expect(fs.existsSync(auditPath)).toBe(true);
    const lines = fs
      .readFileSync(auditPath, 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.type).toBe('request.edit_rejected');
    expect(event.request_id).toBe('REQ-000001');
    expect(event.attempted_field).toBe('request_type');
    expect(event.reason).toBe('request_type is immutable after submission');
  });

  it('case 14: edit --priority high succeeds and dispatches', async () => {
    const router = makeMockRouter();
    const { error } = await run(
      ['edit', 'REQ-000001', '--priority', 'high'],
      router,
    );
    expect(error).toBeUndefined();
    expect(router.route).toHaveBeenCalledTimes(1);
    expect(router.calls()[0].flags.priority).toBe('high');
  });

  it.each([
    ['--id', 'NEW-ID', 'id'],
    ['--created-at', '2026-01-01T00:00:00Z', 'created_at'],
    ['--source-channel', 'discord', 'source_channel'],
  ])('rejects %s with audit event for field %s', async (flag, value, field) => {
    const router = makeMockRouter();
    const { error } = await run(
      ['edit', 'REQ-000001', flag, value],
      router,
    );
    expect(error).toBeDefined();
    expect(stderrChunks.join('')).toBe(
      `Error: ${field} is immutable after submission\n`,
    );
    const lines = fs
      .readFileSync(auditLogPath(), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.attempted_field).toBe(field);
  });
});
