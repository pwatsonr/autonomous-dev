/**
 * Runner / dry-run wiring tests (#524).
 *
 * These exercise the orchestration end-to-end against the MOCK harness (no
 * daemon, $0): submit -> poll-to-terminal -> read phase_history -> record ->
 * aggregate -> render. They also pin the two hard safety/UX contracts:
 *   1. the runner REFUSES to target the autonomous-dev repo, and
 *   2. flag parsing + task selection behave.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { computeSummary } from '../aggregate';
import {
  AUTONOMOUS_DEV_REPO_ROOT,
  ForbiddenRepoError,
  assertRepoAllowed,
  isSameOrInside,
} from '../guard';
import {
  CliHarness,
  Harness,
  MockHarness,
  MockScript,
  parseCliJson,
  runBatch,
  type BatchConfig,
} from '../harness';
import { renderReport } from '../report';
import {
  execute,
  loadTaskSuite,
  parseArgs,
  selectTasks,
  main,
} from '../run-harness';
import type { RequestStatus, Task } from '../types';
import { phaseHistory } from './fixtures';

/** A scratch repo path guaranteed to be outside the autonomous-dev tree. */
const SCRATCH_REPO = path.join(os.tmpdir(), 'reliability-harness-scratch');

const TASKS: Task[] = [
  { id: 'trivial', description: 'append a line', sizeClass: 'trivial-docs', expectedTerminalPhase: 'done' },
  { id: 'flaky', description: 'add a fn + test', sizeClass: 'small', expectedTerminalPhase: 'done' },
];

/** BatchConfig that makes the loop run instantly (no real clock/sleep). */
function fastCfg(over: Partial<BatchConfig> = {}): BatchConfig {
  return {
    repo: SCRATCH_REPO,
    repeats: 1,
    pollTimeoutMs: 10_000,
    pollIntervalMs: 1,
    dryRun: true,
    sleep: async () => {},
    ...over,
  };
}

describe('repo guard', () => {
  test('refuses the autonomous-dev repo root itself', () => {
    expect(() => assertRepoAllowed(AUTONOMOUS_DEV_REPO_ROOT)).toThrow(ForbiddenRepoError);
  });
  test('refuses a path nested inside the autonomous-dev repo', () => {
    const inside = path.join(AUTONOMOUS_DEV_REPO_ROOT, 'plugins', 'autonomous-dev');
    expect(() => assertRepoAllowed(inside)).toThrow(/Refusing to run/);
  });
  test('refuses an empty repo', () => {
    expect(() => assertRepoAllowed('')).toThrow(ForbiddenRepoError);
  });
  test('allows an unrelated scratch path', () => {
    expect(() => assertRepoAllowed(SCRATCH_REPO)).not.toThrow();
  });
  test('isSameOrInside is true for self and descendants, false for siblings', () => {
    expect(isSameOrInside('/a/b', '/a/b')).toBe(true);
    expect(isSameOrInside('/a/b/c', '/a/b')).toBe(true);
    expect(isSameOrInside('/a/bb', '/a/b')).toBe(false);
    expect(isSameOrInside('/a', '/a/b')).toBe(false);
  });
  test('runBatch enforces the guard before any submission', async () => {
    const harness = new MockHarness();
    await expect(
      runBatch(harness, TASKS, fastCfg({ repo: AUTONOMOUS_DEV_REPO_ROOT })),
    ).rejects.toBeInstanceOf(ForbiddenRepoError);
  });
});

describe('runBatch — mock orchestration', () => {
  test('records one well-formed result per task x repeat', async () => {
    const harness = new MockHarness();
    const results = await runBatch(harness, TASKS, fastCfg({ repeats: 2 }));
    expect(results).toHaveLength(4); // 2 tasks x 2 repeats
    for (const r of results) {
      expect(r.requestId).toMatch(/^REQ-DRYRUN-\d{4}$/);
      expect(r.status).toBe('done');
      expect(r.terminalPhase).toBe('monitor');
      expect(r.dryRun).toBe(true);
      expect(typeof r.costUsd).toBe('number');
      expect(r.perPhaseRetries).toBeDefined();
    }
    // repeats are labelled 1..N per task
    expect(results.filter((r) => r.taskId === 'trivial').map((r) => r.repeat)).toEqual([1, 2]);
  });

  test('reads retries + cost from the scripted phase_history', async () => {
    const scripts: Record<string, MockScript> = {
      flaky: {
        statusSequence: ['failed'],
        terminalPhase: 'code',
        blocker: 'verification failed',
        phaseHistory: phaseHistory([
          { state: 'prd', retry_count: 0, cost_usd: 0.4 },
          { state: 'code', retry_count: 2, cost_usd: 1.6 },
        ]),
      },
    };
    const harness = new MockHarness(scripts);
    const results = await runBatch(harness, [TASKS[1]], fastCfg());
    const r = results[0];
    expect(r.status).toBe('failed');
    expect(r.perPhaseRetries).toEqual({ prd: 0, code: 2 });
    expect(r.totalRetries).toBe(2);
    expect(r.costUsd).toBeCloseTo(2.0, 10);
    expect(r.blocker).toBe('verification failed');
  });

  test('multi-poll: stays in loop until a terminal status appears', async () => {
    const scripts: Record<string, MockScript> = {
      trivial: {
        statusSequence: ['queued', 'active', 'active', 'done'] as RequestStatus[],
        terminalPhase: 'monitor',
        phaseHistory: phaseHistory([{ state: 'monitor', retry_count: 0, cost_usd: 0.2 }]),
      },
    };
    const harness = new MockHarness(scripts);
    const results = await runBatch(harness, [TASKS[0]], fastCfg());
    expect(results[0].status).toBe('done');
    expect(results[0].terminalPhase).toBe('monitor');
  });

  test('records timeout when no terminal status is reached before the deadline', async () => {
    const scripts: Record<string, MockScript> = {
      trivial: {
        statusSequence: ['active'] as RequestStatus[], // never terminal
        terminalPhase: 'active',
        phaseHistory: phaseHistory([{ state: 'code', retry_count: 1, cost_usd: 0.5 }]),
      },
    };
    const harness = new MockHarness(scripts);
    // Use a real-ish clock that advances so the deadline is hit quickly.
    let t = 0;
    const cfg = fastCfg({
      pollTimeoutMs: 5,
      pollIntervalMs: 1,
      now: () => (t += 2),
    });
    const results = await runBatch(harness, [TASKS[0]], cfg);
    expect(results[0].status).toBe('timeout');
    expect(results[0].totalRetries).toBe(1);
  });

  test('#552: final status check after the deadline rescues an off-by-one-poll done', async () => {
    // First poll returns 'active'; the request settles to 'done' on the next
    // status() call. With pollTimeoutMs tiny, the while-loop exits after one
    // 'active' poll; the post-deadline final check then sees 'done'.
    const scripts: Record<string, MockScript> = {
      trivial: {
        statusSequence: ['active', 'done'] as RequestStatus[],
        terminalPhase: 'monitor',
        phaseHistory: phaseHistory([{ state: 'monitor', retry_count: 0, cost_usd: 0 }]),
      },
    };
    const harness = new MockHarness(scripts);
    // Clock tuned so the while-loop runs exactly ONE poll ('active'), then the
    // deadline passes, then the post-deadline final check sees 'done':
    // startedAt=60, deadline=160; check1 t=120<160 (poll active); check2 t=180>=160 (exit).
    let t = 0;
    const cfg = fastCfg({ pollTimeoutMs: 100, pollIntervalMs: 1, now: () => (t += 60) });
    const results = await runBatch(harness, [TASKS[0]], cfg);
    expect(results[0].status).toBe('done'); // NOT 'timeout'
    expect(results[0].terminalPhase).toBe('monitor');
  });

  test('#552: per-task timeoutMs is used when --timeout is not explicit', async () => {
    // A task with a generous timeoutMs must not be timed out by a small batch
    // default. The mock settles 'done' on the 2nd poll; the per-task timeout
    // (large) keeps polling long enough, while the batch default (tiny) would not.
    const taskWithTimeout: Task = {
      id: 'trivial',
      description: 'append a line',
      sizeClass: 'trivial-docs',
      expectedTerminalPhase: 'done',
      timeoutMs: 10_000,
    };
    const scripts: Record<string, MockScript> = {
      trivial: {
        statusSequence: ['active', 'done'] as RequestStatus[],
        terminalPhase: 'monitor',
        phaseHistory: phaseHistory([{ state: 'monitor', retry_count: 0, cost_usd: 0 }]),
      },
    };
    const harness = new MockHarness(scripts);
    let t = 0;
    // Batch default tiny (1ms) + NOT explicit → per-task 10s wins → reaches done.
    const cfg = fastCfg({ pollTimeoutMs: 1, pollIntervalMs: 1, timeoutExplicit: false, now: () => (t += 2) });
    const results = await runBatch(harness, [taskWithTimeout], cfg);
    expect(results[0].status).toBe('done');
  });

  test('#552: explicit --timeout overrides a generous per-task timeoutMs', async () => {
    // Same task, but timeoutExplicit=true with a tiny pollTimeoutMs → the
    // per-task 10s is ignored and the run times out (never-terminal script).
    const taskWithTimeout: Task = {
      id: 'trivial',
      description: 'append a line',
      sizeClass: 'trivial-docs',
      expectedTerminalPhase: 'done',
      timeoutMs: 10_000,
    };
    const scripts: Record<string, MockScript> = {
      trivial: {
        statusSequence: ['active'] as RequestStatus[], // never terminal
        terminalPhase: 'active',
        phaseHistory: phaseHistory([{ state: 'code', retry_count: 0, cost_usd: 0 }]),
      },
    };
    const harness = new MockHarness(scripts);
    let t = 0;
    const cfg = fastCfg({ pollTimeoutMs: 5, pollIntervalMs: 1, timeoutExplicit: true, now: () => (t += 2) });
    const results = await runBatch(harness, [taskWithTimeout], cfg);
    expect(results[0].status).toBe('timeout');
  });

  test('a thrown submit is recorded as a failed run, not a crash', async () => {
    const harness: Harness = {
      submit: async () => {
        throw new Error('daemon down');
      },
      status: async () => ({ status: 'done' as RequestStatus, currentPhase: 'done', blocker: null }),
      readPhaseHistory: async () => [],
    };
    const results = await runBatch(harness, [TASKS[0]], fastCfg());
    expect(results[0].status).toBe('failed');
    expect(results[0].terminalPhase).toBe('submit');
    expect(results[0].blocker).toMatch(/submit failed: daemon down/);
  });
});

describe('CliHarness — parses the real CLI JSON contract (no daemon)', () => {
  // `formatResult` emits `JSON.stringify(data, null, 2)` for object payloads.
  // submit -> { requestId, position, estimatedWait }; status ->
  // { requestId, status, currentPhase, blocker, ... }. We feed those exact
  // shapes through an injected subprocess runner.
  const submitOut = JSON.stringify(
    { requestId: 'REQ-000200', position: 1, estimatedWait: '< 1m' },
    null,
    2,
  );
  const statusOut = JSON.stringify(
    {
      requestId: 'REQ-000200',
      status: 'done',
      currentPhase: 'monitor',
      blocker: null,
      ageMs: 123,
    },
    null,
    2,
  );

  test('submit extracts requestId from the pretty-printed payload', async () => {
    const calls: string[][] = [];
    const harness = new CliHarness('/fake/cli.sh', (args) => {
      calls.push(args);
      return `${submitOut}\n`;
    });
    const id = await harness.submit('/tmp/scratch', TASKS[0]);
    expect(id).toBe('REQ-000200');
    // forwards description, --repo, and --size
    expect(calls[0]).toEqual([
      'request',
      'submit',
      'append a line',
      '--repo',
      '/tmp/scratch',
      '--size',
      'trivial-docs',
    ]);
  });

  test('status maps .status/.currentPhase/.blocker from the payload', async () => {
    const harness = new CliHarness('/fake/cli.sh', () => `${statusOut}\n`);
    const snap = await harness.status('/tmp/scratch', 'REQ-000200');
    expect(snap).toEqual({ status: 'done', currentPhase: 'monitor', blocker: null });
  });

  test('submit throws a helpful error when no requestId is present', async () => {
    const harness = new CliHarness('/fake/cli.sh', () => 'OK\n');
    await expect(harness.submit('/tmp/scratch', TASKS[0])).rejects.toThrow(
      /expected JSON object|no requestId/,
    );
  });

  test('#546: submit + status parse through the real preamble + migration line', async () => {
    // The actual CLI stdout: a build notice, a single-line migration event, THEN
    // the pretty payload — two JSON values, not one. Regression for #546.
    const noisy = (payload: object): string =>
      'Building CLI adapter...\n' +
      '{"event":"migration.complete","applied":[],"schemaVersion":5}\n' +
      JSON.stringify(payload, null, 2) +
      '\n';
    const submitH = new CliHarness('/fake/cli.sh', () =>
      noisy({ requestId: 'REQ-000546', position: 2, estimatedWait: '46m' }),
    );
    expect(await submitH.submit('/tmp/scratch', TASKS[0])).toBe('REQ-000546');

    const statusH = new CliHarness('/fake/cli.sh', () =>
      noisy({ requestId: 'REQ-000546', status: 'done', currentPhase: 'monitor', blocker: null }),
    );
    expect(await statusH.status('/tmp/scratch', 'REQ-000546')).toEqual({
      status: 'done',
      currentPhase: 'monitor',
      blocker: null,
    });
  });
});

describe('parseCliJson', () => {
  test('grabs the JSON object even with surrounding noise', () => {
    expect(parseCliJson('build notice\n{\n  "id": "REQ-1"\n}\n')).toEqual({ id: 'REQ-1' });
  });
  test('#546: returns the LAST object when a migration line precedes the payload', () => {
    const out =
      'Building CLI adapter...\n' +
      '{"event":"migration.complete","applied":[],"schemaVersion":5}\n' +
      '{\n  "requestId": "REQ-000546",\n  "position": 1\n}\n';
    expect(parseCliJson(out)).toEqual({ requestId: 'REQ-000546', position: 1 });
  });
  test('#546: ignores braces inside string values', () => {
    expect(
      parseCliJson('note {x}\n{"msg":"a } brace { inside a string","id":"REQ-2"}'),
    ).toEqual({ msg: 'a } brace { inside a string', id: 'REQ-2' });
  });
  test('throws when there is no object', () => {
    expect(() => parseCliJson('OK')).toThrow(/expected JSON object/);
  });
});

describe('renderReport', () => {
  test('produces a non-empty, dry-run-annotated table with the headline rate', async () => {
    const harness = new MockHarness();
    const results = await runBatch(harness, TASKS, fastCfg({ repeats: 2 }));
    const summary = computeSummary(results);
    const text = renderReport(summary, results, { dryRun: true });
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('success rate');
    expect(text).toContain('100.0%');
    expect(text).toContain('PER-TASK DETERMINISM');
    expect(text).toContain('PER-RUN DETAIL');
    expect(text).toContain('trivial');
  });
});

describe('parseArgs', () => {
  test('parses flags and applies defaults', () => {
    const o = parseArgs(['--repo', '/tmp/x', '--tasks', 'a,b', '--repeats', '3', '--dry-run']);
    expect(o).toMatchObject({ repo: '/tmp/x', tasks: 'a,b', repeats: 3, dryRun: true });
    expect(o.timeoutMs).toBe(60 * 60 * 1000); // #552: raised 30→60m
    expect(o.timeoutExplicit).toBe(false);
  });
  test('#552: --timeout marks timeoutExplicit', () => {
    const o = parseArgs(['--timeout', '900000']);
    expect(o.timeoutMs).toBe(900000);
    expect(o.timeoutExplicit).toBe(true);
  });
  test('rejects a non-positive --repeats', () => {
    expect(() => parseArgs(['--repeats', '0'])).toThrow(/positive integer/);
  });
  test('rejects unknown flags', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown flag/);
  });
});

describe('selectTasks', () => {
  const suite = { tasks: TASKS };
  test('all returns the full suite in order', () => {
    expect(selectTasks(suite, 'all').map((t) => t.id)).toEqual(['trivial', 'flaky']);
  });
  test('subset selects in suite order regardless of selector order', () => {
    expect(selectTasks(suite, 'flaky,trivial').map((t) => t.id)).toEqual(['trivial', 'flaky']);
  });
  test('throws on unknown id with the list of available ids', () => {
    expect(() => selectTasks(suite, 'nope')).toThrow(/unknown task id/);
  });
});

describe('loadTaskSuite — the shipped suite', () => {
  test('the committed task-suite.json is valid and non-empty', () => {
    const suitePath = path.resolve(__dirname, '..', 'task-suite.json');
    const suite = loadTaskSuite(suitePath);
    expect(suite.tasks.length).toBeGreaterThanOrEqual(3);
    for (const t of suite.tasks) {
      expect(t.id).toBeTruthy();
      expect(t.description).toBeTruthy();
      expect(['trivial-docs', 'small', 'standard', 'large']).toContain(t.sizeClass);
      expect(t.expectedTerminalPhase).toBe('done');
    }
  });
});

describe('execute — dry-run end-to-end via the shipped suite', () => {
  test('runs the real suite through the mock harness and summarizes', async () => {
    const { results, summary, tasks } = await execute(
      {
        repo: SCRATCH_REPO,
        tasks: 'all',
        repeats: 2,
        dryRun: true,
        timeoutMs: 1000,
        intervalMs: 1,
        suitePath: path.resolve(__dirname, '..', 'task-suite.json'),
      },
      {},
    );
    expect(tasks.length).toBeGreaterThanOrEqual(3);
    expect(results.length).toBe(tasks.length * 2);
    expect(summary.successRate).toBe(1);
    expect(summary.totalRuns).toBe(results.length);
  });
});

describe('main — exit codes + JSON report file', () => {
  // main() writes the report/usage to the real process streams; silence them
  // so they don't pollute the Jest console (mirrors cli_adapter.test.ts).
  let outSpy: jest.SpyInstance;
  let errSpy: jest.SpyInstance;
  beforeEach(() => {
    outSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  test('REFUSED (exit 3) when --repo targets the autonomous-dev repo', async () => {
    const code = await main(['--repo', AUTONOMOUS_DEV_REPO_ROOT, '--dry-run']);
    expect(code).toBe(3);
  });

  test('exit 2 when --repo is missing', async () => {
    const code = await main(['--dry-run']);
    expect(code).toBe(2);
  });

  test('dry-run against scratch exits 0 and writes a well-formed JSON report', async () => {
    const outPath = path.join(os.tmpdir(), `reliability-report-${process.pid}.json`);
    try {
      const code = await main([
        '--repo',
        SCRATCH_REPO,
        '--dry-run',
        '--tasks',
        'all',
        '--repeats',
        '1',
        '--out',
        outPath,
      ]);
      expect(code).toBe(0);
      const report = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      expect(report.summary.successRate).toBe(1);
      expect(Array.isArray(report.results)).toBe(true);
      expect(report.results.length).toBeGreaterThanOrEqual(3);
      expect(report.generatedAt).toBeTruthy();
    } finally {
      fs.rmSync(outPath, { force: true });
    }
  });
});
