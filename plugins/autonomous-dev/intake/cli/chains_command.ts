/**
 * `autonomous-dev chains` subcommand group (SPEC-022-1-04, Task 9).
 *
 * Two read-only IPC commands against the running daemon:
 *
 *   - `chains list [--json]` — table of every registered chain edge
 *     (`producer | consumer | artifactType | schemaVersion`).
 *   - `chains graph [--format dot|mermaid]` — emits the dependency graph
 *     in Graphviz DOT or Mermaid syntax for visualization.
 *
 * Both commands route via the existing IPC client (SPEC-019-1-04). The
 * daemon must be running; absence prints `daemon is not running` to
 * stderr and exits 1.
 *
 * Exposes `registerChainsCommand(program)` for the cli_adapter to wire
 * the subcommand into the top-level `commander` program.
 *
 * @module cli/chains_command
 */

import { Command, Option } from 'commander';
import { send } from '../hooks/ipc-client';
import type { IpcRequest, IpcResponse } from '../hooks/ipc-server';
import type { ChainEdge } from '../chains/dependency-graph';
import type { ChainGraphFormat } from '../chains/render';

/**
 * Stream pair injected for testability — defaults to process.stdout/stderr.
 */
export interface ChainsCommandStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

/**
 * Send hook injected for testability — defaults to the real IPC client.
 */
export type ChainsIpcSend = (req: IpcRequest) => Promise<IpcResponse>;

export interface ChainsCommandDeps extends ChainsCommandStreams {
  send?: ChainsIpcSend;
}

/**
 * Format a list of ChainEdges as a fixed-width table.
 *
 * Returns the rendered string (with trailing newline). Does NOT print —
 * pure for testability.
 */
export function renderChainsTable(edges: ChainEdge[]): string {
  if (edges.length === 0) {
    return '(no chain edges registered)\n';
  }
  const sorted = [...edges].sort((a, b) => {
    if (a.from !== b.from) return a.from.localeCompare(b.from);
    if (a.to !== b.to) return a.to.localeCompare(b.to);
    return a.artifactType.localeCompare(b.artifactType);
  });
  const headers = ['Producer', 'Consumer', 'Artifact Type', 'Schema Version'];
  const rows: string[][] = [headers];
  for (const e of sorted) {
    rows.push([e.from, e.to, e.artifactType, e.schemaVersion]);
  }
  const widths = headers.map((_, col) =>
    Math.max(...rows.map((r) => r[col].length)),
  );
  const lines: string[] = [];
  for (const r of rows) {
    lines.push(r.map((cell, i) => cell.padEnd(widths[i])).join(' | '));
  }
  return lines.join('\n') + '\n';
}

/**
 * Run `chains list`. Exit code: 0 on success, 1 when the daemon is
 * unreachable or returned an error.
 */
export async function runChainsList(
  opts: { json?: boolean },
  deps: ChainsCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const sendFn = deps.send ?? send;
  let res: IpcResponse;
  try {
    res = await sendFn({ command: 'chains-list' });
  } catch (err) {
    stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  if (res.status !== 'ok') {
    stderr.write(`ERROR: ${res.error ?? 'unknown error'}\n`);
    return 1;
  }
  const edges = (res.payload ?? []) as ChainEdge[];
  if (opts.json) {
    stdout.write(JSON.stringify(edges, null, 2) + '\n');
    return 0;
  }
  stdout.write(renderChainsTable(edges));
  return 0;
}

/**
 * Run `chains graph --format <dot|mermaid>`. Default format is `dot`.
 */
export async function runChainsGraph(
  opts: { format?: string },
  deps: ChainsCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const fmt = opts.format ?? 'dot';
  if (fmt !== 'dot' && fmt !== 'mermaid') {
    stderr.write(`unsupported format '${fmt}' (use dot or mermaid)\n`);
    return 1;
  }
  const sendFn = deps.send ?? send;
  let res: IpcResponse;
  try {
    res = await sendFn({ command: 'chains-graph', format: fmt as ChainGraphFormat });
  } catch (err) {
    stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
  if (res.status !== 'ok') {
    stderr.write(`ERROR: ${res.error ?? 'unknown error'}\n`);
    return 1;
  }
  stdout.write(String(res.payload ?? ''));
  if (typeof res.payload === 'string' && !res.payload.endsWith('\n')) {
    stdout.write('\n');
  }
  return 0;
}

/**
 * Register `chains list` and `chains graph` under a top-level `chains`
 * group on the supplied commander program. Mirrors the registration
 * pattern used by `cli_adapter_standards.ts`.
 */
export function registerChainsCommand(
  program: Command,
  deps: ChainsCommandDeps = {},
): void {
  const chains = program
    .command('chains')
    .description('Inspect the plugin chain dependency graph')
    .exitOverride();

  chains
    .command('list')
    .description('List all registered chain edges (producer → consumer)')
    .option('--json', 'Emit raw JSON instead of a table', false)
    .action(async (opts: Record<string, unknown>) => {
      const code = await runChainsList(
        { json: opts.json === true },
        deps,
      );
      if (code !== 0) {
        // Surface the failure to commander so the top-level catch can
        // exit with the right code.
        throw new Error('chains list failed');
      }
    });

  chains
    .command('graph')
    .description('Emit the dependency graph in DOT or Mermaid syntax')
    .addOption(
      new Option('--format <fmt>', 'Output format')
        .choices(['dot', 'mermaid'])
        .default('dot'),
    )
    .action(async (opts: Record<string, unknown>) => {
      const code = await runChainsGraph(
        { format: typeof opts.format === 'string' ? opts.format : 'dot' },
        deps,
      );
      if (code !== 0) {
        throw new Error('chains graph failed');
      }
    });
}
