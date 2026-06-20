/**
 * Reliability harness runner (#524) — orchestration library.
 *
 * Measures the autonomous-dev pipeline's end-to-end success rate and
 * determinism by running a version-controlled task suite N times against a
 * disposable scratch repo. This is the acceptance metric for the
 * "road to 100%" epic (#532).
 *
 * This module is the library half (parse -> guard -> run -> aggregate ->
 * render -> exit code); it has NO side effects on import so ts-jest can load
 * it. The runnable entrypoint with the bun `import.meta.main` guard lives in
 * the sibling `cli.ts`:
 *
 *   bun tools/reliability/cli.ts --repo <scratch> --tasks all --repeats 3
 *   bun tools/reliability/cli.ts --repo <scratch> --dry-run     # no daemon
 *
 * Flags:
 *   --repo <path>     REQUIRED. Disposable scratch repo. The runner REFUSES
 *                     to target the autonomous-dev repo (or anything inside
 *                     it) — see tools/reliability/guard.ts.
 *   --tasks <ids|all> Comma-separated task ids from task-suite.json, or 'all'
 *                     (default: all).
 *   --repeats <N>     Repeats per task (default: 1). Determinism signal.
 *   --dry-run         Use a mocked CLI + state.json (no real daemon, $0).
 *   --out <file>      Write the machine-readable JSON report here.
 *   --timeout <ms>    Per-run poll timeout (default 1800000 = 30m live).
 *   --interval <ms>   Poll interval (default 15000 = 15s).
 *   --suite <file>    Override the task suite path.
 *
 * COST WARNING: a LIVE run is ~$3 and ~30min PER (task x repeat). Use
 * --dry-run to validate wiring for free; use --tasks/--repeats to scope cost.
 *
 * @module tools/reliability/run-harness
 */

import * as fs from 'fs';
import * as path from 'path';

import { computeSummary } from './aggregate';
import { ForbiddenRepoError } from './guard';
import {
  CliHarness,
  Harness,
  MockHarness,
  runBatch,
  type BatchConfig,
} from './harness';
import { renderReport } from './report';
import type { RunResult, Summary, Task, TaskSuite } from './types';

/** Default task suite shipped alongside the runner. */
const DEFAULT_SUITE_PATH = path.resolve(__dirname, 'task-suite.json');

/** Parsed CLI flags. */
export interface CliOptions {
  repo: string;
  tasks: string; // 'all' or comma-separated ids
  repeats: number;
  dryRun: boolean;
  out?: string;
  timeoutMs: number;
  intervalMs: number;
  suitePath: string;
}

/** Minimal, dependency-free flag parser (the plugin avoids adding deps). */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    repo: '',
    tasks: 'all',
    repeats: 1,
    dryRun: false,
    timeoutMs: 30 * 60 * 1000,
    intervalMs: 15 * 1000,
    suitePath: DEFAULT_SUITE_PATH,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${arg} requires a value`);
      return v;
    };
    switch (arg) {
      case '--repo':
        opts.repo = next();
        break;
      case '--tasks':
        opts.tasks = next();
        break;
      case '--repeats':
        opts.repeats = parsePositiveInt(next(), '--repeats');
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--out':
        opts.out = next();
        break;
      case '--timeout':
        opts.timeoutMs = parsePositiveInt(next(), '--timeout');
        break;
      case '--interval':
        opts.intervalMs = parsePositiveInt(next(), '--interval');
        break;
      case '--suite':
        opts.suitePath = path.resolve(next());
        break;
      case '-h':
      case '--help':
        printUsage();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }
  return opts;
}

function parsePositiveInt(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer, got '${value}'`);
  }
  return n;
}

/** Load + minimally validate the task suite from disk. */
export function loadTaskSuite(suitePath: string): TaskSuite {
  const raw = fs.readFileSync(suitePath, 'utf8');
  const parsed = JSON.parse(raw) as TaskSuite;
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) {
    throw new Error(`task suite ${suitePath} has no tasks[]`);
  }
  for (const t of parsed.tasks) {
    if (!t.id || !t.description || !t.sizeClass) {
      throw new Error(`task suite ${suitePath} has a malformed task: ${JSON.stringify(t)}`);
    }
  }
  return parsed;
}

/** Resolve `--tasks` (ids|all) against the suite, preserving suite order. */
export function selectTasks(suite: TaskSuite, selector: string): Task[] {
  if (selector === 'all') return suite.tasks;
  const wanted = new Set(
    selector
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (wanted.size === 0) throw new Error('--tasks selector is empty');
  const selected = suite.tasks.filter((t) => wanted.has(t.id));
  const found = new Set(selected.map((t) => t.id));
  const missing = [...wanted].filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new Error(
      `unknown task id(s): ${missing.join(', ')}. ` +
        `Available: ${suite.tasks.map((t) => t.id).join(', ')}`,
    );
  }
  return selected;
}

/**
 * End-to-end execution given parsed options: pick the harness (mock for
 * dry-run, CLI otherwise), run the batch, compute the summary. Returns both
 * the raw results and the summary so callers (and tests) can inspect either.
 * Accepts an optional harness override so tests can inject their own mock.
 */
export async function execute(
  opts: CliOptions,
  deps: { harness?: Harness; log?: (line: string) => void } = {},
): Promise<{ results: RunResult[]; summary: Summary; tasks: Task[] }> {
  const suite = loadTaskSuite(opts.suitePath);
  const tasks = selectTasks(suite, opts.tasks);

  const harness: Harness =
    deps.harness ?? (opts.dryRun ? new MockHarness() : new CliHarness());

  const cfg: BatchConfig = {
    repo: opts.repo,
    repeats: opts.repeats,
    pollTimeoutMs: opts.timeoutMs,
    pollIntervalMs: opts.intervalMs,
    dryRun: opts.dryRun,
    log: deps.log,
    // In dry-run, collapse the clock + sleep so the batch finishes instantly.
    ...(opts.dryRun ? { sleep: async () => {} } : {}),
  };

  const results = await runBatch(harness, tasks, cfg);
  const summary = computeSummary(results);
  return { results, summary, tasks };
}

function printUsage(): void {
  process.stdout.write(
    [
      'Usage: bun tools/reliability/cli.ts --repo <scratch> [options]',
      '',
      '  --repo <path>      REQUIRED disposable scratch repo (NOT autonomous-dev).',
      '  --tasks <ids|all>  Task ids (comma-sep) or "all" (default: all).',
      '  --repeats <N>      Repeats per task (default: 1).',
      '  --dry-run          Mocked CLI + state.json; no daemon, $0.',
      '  --out <file>       Write JSON report to file.',
      '  --timeout <ms>     Per-run poll timeout (default 1800000).',
      '  --interval <ms>    Poll interval (default 15000).',
      '  --suite <file>     Override task-suite.json path.',
      '',
      'COST: a LIVE run is ~$3 / ~30min per (task x repeat). Use --dry-run first.',
      '',
    ].join('\n'),
  );
}

/** CLI main: parse, guard, run, print, persist, set exit code. */
export async function main(argv: string[]): Promise<number> {
  let opts: CliOptions;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`Error: ${asMessage(err)}\n\n`);
    printUsage();
    return 2;
  }

  if (!opts.repo) {
    process.stderr.write('Error: --repo is required.\n\n');
    printUsage();
    return 2;
  }

  if (!opts.dryRun) {
    process.stderr.write(
      'WARNING: live mode. Each (task x repeat) is ~$3 / ~30min. ' +
        'Ctrl-C now if unintended; use --dry-run to validate for free.\n',
    );
  }

  try {
    const { results, summary } = await execute(opts, {
      log: (line) => process.stderr.write(line + '\n'),
    });

    if (opts.out) {
      const report = { generatedAt: new Date().toISOString(), opts: redact(opts), summary, results };
      fs.writeFileSync(opts.out, JSON.stringify(report, null, 2) + '\n');
    }

    process.stdout.write(
      renderReport(summary, results, { dryRun: opts.dryRun, outPath: opts.out }) + '\n',
    );

    // Non-zero exit when not every run was green, so CI/operators can gate.
    return summary.successRate === 1 && summary.totalRuns > 0 ? 0 : 1;
  } catch (err) {
    if (err instanceof ForbiddenRepoError) {
      process.stderr.write(`REFUSED: ${err.message}\n`);
      return 3;
    }
    process.stderr.write(`Error: ${asMessage(err)}\n`);
    return 1;
  }
}

/** Drop nothing sensitive today, but keep a hook for future secret-bearing flags. */
function redact(opts: CliOptions): CliOptions {
  return { ...opts };
}

function asMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
