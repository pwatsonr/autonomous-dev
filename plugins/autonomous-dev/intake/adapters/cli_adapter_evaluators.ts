/**
 * `autonomous-dev evaluators` subcommand family (SPEC-021-2-04, Task 10).
 *
 * Two verbs:
 *   - `evaluators list [--config <path>]`
 *       Prints a table (NAME, TYPE, PATH) of all evaluators registered
 *       against the registry constructed from the optional config file's
 *       `extensions.evaluators_allowlist`. When no config is supplied, only
 *       the 5 built-ins are listed.
 *
 *   - `evaluators add <abs-path> --config <path>`
 *       Appends `<abs-path>` to `extensions.evaluators_allowlist` in the
 *       given config JSON file. The file is rewritten atomically via
 *       temp+rename. Exit codes:
 *         0 — added (or already-present, with informational stdout)
 *         1 — admin auth failure (when AUTONOMOUS_DEV_ADMIN env not set)
 *         2 — bad input (relative path, missing --config)
 *
 * Deviations from the spec text §Implementation Details:
 *   - The spec assumed `requireAdmin()` (PRD-009/TDD-009), `readConfig()` /
 *     `writeConfig()` (TDD-007), and `sendDaemonSignal()` helpers exist.
 *     None do in this codebase. We replicate the minimum surface here:
 *       * admin gate: require AUTONOMOUS_DEV_ADMIN=1 (env-driven; same
 *         pattern as `auth.ts`'s admin marker for standards request
 *         overrides).
 *       * config IO: read/write the JSON file at --config directly,
 *         using temp+rename for atomicity.
 *       * daemon signal: best-effort; if AUTONOMOUS_DEV_DAEMON_PID env is
 *         set, `process.kill(pid, 'SIGUSR1')`. Otherwise a no-op note is
 *         printed. The orchestrator/daemon owners can wire the signal
 *         endpoint in a follow-up.
 *
 * @module intake/adapters/cli_adapter_evaluators
 */

import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { Command } from 'commander';

import { EvaluatorRegistry } from '../standards/evaluator-registry';
import type { RegisteredEvaluator } from '../standards/evaluator-registry';

export interface EvaluatorsCliIO {
  stdout: (s: string) => void;
  stderr: (s: string) => void;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_IO: EvaluatorsCliIO = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
};

interface ConfigShape {
  extensions?: {
    evaluators_allowlist?: string[];
  };
  [key: string]: unknown;
}

function readAllowlist(configPath: string | undefined): string[] {
  if (!configPath) return [];
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as ConfigShape;
    return parsed.extensions?.evaluators_allowlist ?? [];
  } catch {
    return [];
  }
}

function writeConfigAtomically(configPath: string, cfg: ConfigShape): void {
  const dir = dirname(configPath);
  const tmp = join(dir, `.${Date.now()}-${process.pid}.tmp`);
  const fd = openSync(tmp, 'w', 0o600);
  try {
    writeSync(fd, JSON.stringify(cfg, null, 2) + '\n');
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, configPath);
}

/** Render a 3-column ASCII table. */
function renderTable(rows: Array<[string, string, string]>): string {
  const headers: [string, string, string] = ['NAME', 'TYPE', 'PATH'];
  const all = [headers, ...rows];
  const widths = [0, 1, 2].map((i) =>
    all.reduce((m, r) => Math.max(m, r[i].length), 0),
  );
  const formatRow = (r: [string, string, string]): string =>
    `${r[0].padEnd(widths[0])}  ${r[1].padEnd(widths[1])}  ${r[2]}`;
  return all.map(formatRow).join('\n') + '\n';
}

export async function runEvaluatorsList(
  configPath: string | undefined,
  io: EvaluatorsCliIO = DEFAULT_IO,
): Promise<number> {
  const allowlist = readAllowlist(configPath);
  const reg = new EvaluatorRegistry(() => allowlist);
  const rows: Array<[string, string, string]> = reg.list().map((e: RegisteredEvaluator) => [
    e.name,
    e.kind,
    e.kind === 'builtin' ? '<built-in>' : e.absolutePath,
  ]);
  io.stdout(renderTable(rows));
  return 0;
}

export async function runEvaluatorsAdd(
  absPath: string,
  configPath: string | undefined,
  io: EvaluatorsCliIO = DEFAULT_IO,
): Promise<number> {
  if (io.env.AUTONOMOUS_DEV_ADMIN !== '1') {
    io.stderr(
      'error: admin authorization required (set AUTONOMOUS_DEV_ADMIN=1)\n',
    );
    return 1;
  }
  if (!absPath || !isAbsolute(absPath)) {
    io.stderr(`error: path must be absolute (got "${absPath}")\n`);
    return 2;
  }
  if (!configPath) {
    io.stderr('error: --config <path> is required for evaluators add\n');
    return 2;
  }
  let cfg: ConfigShape;
  try {
    cfg = JSON.parse(readFileSync(configPath, 'utf8')) as ConfigShape;
  } catch {
    cfg = {};
  }
  cfg.extensions ??= {};
  cfg.extensions.evaluators_allowlist ??= [];
  if (cfg.extensions.evaluators_allowlist.includes(absPath)) {
    io.stdout(`already in allowlist: ${absPath}\n`);
    return 0;
  }
  cfg.extensions.evaluators_allowlist.push(absPath);
  writeConfigAtomically(configPath, cfg);
  io.stdout(`added: ${absPath}\n`);

  const pid = io.env.AUTONOMOUS_DEV_DAEMON_PID
    ? parseInt(io.env.AUTONOMOUS_DEV_DAEMON_PID, 10)
    : NaN;
  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 'SIGUSR1');
      io.stdout(`sent SIGUSR1 to daemon (pid ${pid}) for reload.\n`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      io.stdout(`note: failed to signal daemon: ${msg}\n`);
    }
  } else {
    io.stdout(
      'note: AUTONOMOUS_DEV_DAEMON_PID not set; daemon must be reloaded out-of-band.\n',
    );
  }
  return 0;
}

export function registerEvaluatorsCommand(program: Command): void {
  const ev = program
    .command('evaluators')
    .description('Inspect and manage standards evaluators (PLAN-021-2)');

  ev.command('list')
    .description('List built-in and custom evaluators')
    .option('--config <path>', 'Path to the autonomous-dev config JSON file')
    .action(async (opts: { config?: string }) => {
      const code = await runEvaluatorsList(opts.config);
      process.exitCode = code;
    });

  ev.command('add <absPath>')
    .description('Append a custom evaluator path to the allowlist')
    .option('--config <path>', 'Path to the autonomous-dev config JSON file')
    .action(async (absPath: string, opts: { config?: string }) => {
      const code = await runEvaluatorsAdd(absPath, opts.config);
      process.exitCode = code;
    });
}
