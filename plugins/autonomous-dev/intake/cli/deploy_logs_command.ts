/**
 * `autonomous-dev deploy logs` CLI (SPEC-023-3-03, Task 9).
 *
 * Reads per-component deploy logs (`build`, `deploy`, `health`, `monitor`)
 * for a given deployId. Emits all rotations in chronological order
 * (`<comp>.log.10` → `<comp>.log.1` → `<comp>.log`) followed by the
 * current file. Default component is `deploy`. Exit codes:
 *   - 0 success
 *   - 1 deployId directory missing
 *   - 2 a log file is malformed (with line number on stderr)
 *
 * @module intake/cli/deploy_logs_command
 */

import { Command } from 'commander';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import type { LogComponent, LogLine } from '../deploy/logger';

export interface DeployLogsStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface DeployLogsOptions {
  deployId: string;
  component?: LogComponent;
  json?: boolean;
  /** Absolute path to the request-root that owns `.autonomous-dev/deploy-logs/`. */
  requestRoot: string;
}

const VALID_COMPONENTS: readonly LogComponent[] = ['build', 'deploy', 'health', 'monitor'];

function deployLogDir(requestRoot: string, deployId: string, component: LogComponent): string {
  return join(requestRoot, '.autonomous-dev', 'deploy-logs', deployId, component);
}

/** Format a single line in human mode. Pure helper. */
export function formatLogLine(line: LogLine): string {
  const fieldsStr = Object.keys(line.fields).length === 0
    ? ''
    : ` ${JSON.stringify(line.fields)}`;
  return `[${line.ts}] [${line.level}] ${line.message}${fieldsStr}`;
}

/**
 * Resolve the chronological list of files for one component:
 * `<comp>.log.10`, `.9`, ..., `.1`, then `<comp>.log`. Skips files that
 * don't exist.
 */
async function listChronologicalFiles(dir: string, component: LogComponent): Promise<string[]> {
  const out: string[] = [];
  for (let i = 10; i >= 1; i--) {
    const p = join(dir, `${component}.log.${i}`);
    try {
      await fs.stat(p);
      out.push(p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  const cur = join(dir, `${component}.log`);
  try {
    await fs.stat(cur);
    out.push(cur);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return out;
}

/** Run `deploy logs`. Returns the process exit code. */
export async function runDeployLogs(
  opts: DeployLogsOptions,
  streams: DeployLogsStreams = {},
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const component: LogComponent = opts.component ?? 'deploy';
  if (!VALID_COMPONENTS.includes(component)) {
    stderr.write(`error: invalid --component '${component}'; expected one of ${VALID_COMPONENTS.join(', ')}\n`);
    return 1;
  }

  const baseDir = join(opts.requestRoot, '.autonomous-dev', 'deploy-logs', opts.deployId);
  try {
    await fs.stat(baseDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      stderr.write(`error: no logs found for deployId=${opts.deployId} under ${opts.requestRoot}\n`);
      return 1;
    }
    throw err;
  }

  const compDir = deployLogDir(opts.requestRoot, opts.deployId, component);
  const files = await listChronologicalFiles(compDir, component);
  if (files.length === 0) {
    // Component dir exists or doesn't — either way, no lines to emit.
    return 0;
  }

  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw.length === 0) continue;
      if (opts.json) {
        // Validate JSON parse but emit the original byte sequence so byte-
        // for-byte parity with the on-disk file is preserved.
        try {
          JSON.parse(raw);
        } catch {
          stderr.write(`error: malformed log line in ${file}:${i + 1}\n`);
          return 2;
        }
        stdout.write(`${raw}\n`);
      } else {
        let parsed: LogLine;
        try {
          parsed = JSON.parse(raw) as LogLine;
        } catch {
          stderr.write(`error: malformed log line in ${file}:${i + 1}\n`);
          return 2;
        }
        stdout.write(formatLogLine(parsed) + '\n');
      }
    }
  }
  return 0;
}

/** Plug `deploy logs` under the top-level `deploy` group. */
export function registerDeployLogsCommand(
  program: Command,
  streams: DeployLogsStreams = {},
): void {
  let deployGroup: Command | undefined = program.commands.find(
    (c: Command) => c.name() === 'deploy',
  );
  if (!deployGroup) {
    deployGroup = program
      .command('deploy')
      .description('Deployment backend operations')
      .exitOverride();
  }
  deployGroup
    .command('logs')
    .description('Print structured logs for one deploy')
    .argument('<deployId>', 'Deploy ULID')
    .option('--component <comp>', 'Component (build|deploy|health|monitor)', 'deploy')
    .option('--request-root <path>', 'Request root containing .autonomous-dev/', process.cwd())
    .option('--json', 'Emit raw JSONL instead of pretty text', false)
    .action(async (deployId: string, opts: Record<string, unknown>) => {
      const component = String(opts.component ?? 'deploy') as LogComponent;
      const code = await runDeployLogs(
        {
          deployId,
          component,
          requestRoot: String(opts.requestRoot ?? process.cwd()),
          json: opts.json === true,
        },
        streams,
      );
      if (code !== 0) throw new Error('deploy logs failed');
    });
}
