/**
 * `autonomous-dev deploy plan` (SPEC-023-2-04, Task 8).
 *
 * Read-only preview: NO state writes, NO telemetry, NO escalations.
 * Resolves the env, runs the selector with optional override, computes
 * the estimated cost via `backend.estimateDeployCost?.(params)`, reads
 * today's cost ledger, and renders either a human table or `--json`.
 *
 * @module intake/cli/deploy_plan_command
 */

import { Command } from 'commander';

import { configPathFor, loadConfig, resolveEnvironment } from '../deploy/environment';
import { selectBackend, type SelectorBackendRegistry } from '../deploy/selector';
import { productionSelectorRegistry } from '../deploy/selector-registry-adapter';
import { readTodayLedger } from '../deploy/cost-cap';
import { BackendRegistry } from '../deploy/registry';
import type { BackendSelection } from '../deploy/selector';

export interface DeployPlanStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface DeployPlanOptions {
  env?: string;
  backend?: string;
  json?: boolean;
  requestDir?: string;
  registry?: SelectorBackendRegistry;
}

interface PlanRow {
  environment: string;
  backend: string;
  selectionSource: string;
  approval: string;
  costCapUsd: number;
  estimatedCostUsd: number;
  todaysCostUsd: number;
  headroomUsd: number;
  parameters: Record<string, string | number | boolean>;
  configPath: string | null;
  source: 'deploy.yaml' | 'fallback';
}

function renderHuman(row: PlanRow): string {
  const lines: string[] = [];
  lines.push('Deploy plan (read-only preview)');
  lines.push('');
  lines.push(`  Environment:        ${row.environment}`);
  lines.push(`  Config path:        ${row.configPath ?? '(fallback; no deploy.yaml)'}`);
  lines.push(`  Backend:            ${row.backend} (source: ${row.selectionSource})`);
  lines.push(`  Approval:           ${row.approval}`);
  lines.push(`  Cost cap (USD):     ${formatUsd(row.costCapUsd)}${row.costCapUsd === 0 ? ' (no cap)' : ''}`);
  lines.push(`  Estimated cost:     ${formatUsd(row.estimatedCostUsd)} (estimated; actuals may differ)`);
  lines.push(`  Today's cost:       ${formatUsd(row.todaysCostUsd)}`);
  lines.push(`  Headroom (USD):     ${formatUsd(row.headroomUsd)}`);
  lines.push('  Parameters:');
  const keys = Object.keys(row.parameters).sort();
  if (keys.length === 0) lines.push('    (none)');
  for (const k of keys) lines.push(`    - ${k}=${JSON.stringify(row.parameters[k])}`);
  return lines.join('\n') + '\n';
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

async function safeEstimate(
  backendName: string,
  params: Record<string, unknown>,
): Promise<number> {
  try {
    const backend = BackendRegistry.get(backendName) as unknown as {
      estimateDeployCost?: (p: Record<string, unknown>) => Promise<number> | number;
    };
    if (typeof backend.estimateDeployCost === 'function') {
      const v = await backend.estimateDeployCost(params);
      return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
    }
    return 0;
  } catch {
    return 0;
  }
}

export async function runDeployPlan(
  options: DeployPlanOptions,
  streams: DeployPlanStreams = {},
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const requestDir = options.requestDir ?? process.cwd();
  const envName = options.env ?? 'dev';
  const registry = options.registry ?? productionSelectorRegistry;

  let row: PlanRow;
  try {
    const config = await loadConfig(requestDir);
    const resolved = resolveEnvironment(config, envName, {
      configPath: config ? configPathFor(requestDir) : null,
    });
    const selection: BackendSelection = selectBackend({
      resolved,
      registry,
      override: options.backend ? { backend: options.backend } : undefined,
      repoDefaultBackend: config?.default_backend,
    });
    const estimated = await safeEstimate(selection.backendName, selection.parameters);
    const ledger = await readTodayLedger(requestDir, resolved.envName).catch(() => ({
      envName: resolved.envName,
      dayUtc: '',
      totalUsd: 0,
      entries: [],
    }));
    const headroom = resolved.costCapUsd === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(0, resolved.costCapUsd - ledger.totalUsd);
    row = {
      environment: resolved.envName,
      backend: selection.backendName,
      selectionSource: selection.source,
      approval: resolved.approval,
      costCapUsd: resolved.costCapUsd,
      estimatedCostUsd: estimated,
      todaysCostUsd: ledger.totalUsd,
      headroomUsd: Number.isFinite(headroom) ? headroom : 0,
      parameters: selection.parameters,
      configPath: resolved.configPath,
      source: resolved.source,
    };
  } catch (err) {
    stderr.write(`${(err as Error).message}\n`);
    return 1;
  }

  if (options.json) {
    stdout.write(
      JSON.stringify(
        {
          environment: row.environment,
          backend: row.backend,
          selectionSource: row.selectionSource,
          approval: row.approval,
          costCapUsd: row.costCapUsd,
          estimatedCostUsd: row.estimatedCostUsd,
          todaysCostUsd: row.todaysCostUsd,
          headroomUsd: row.headroomUsd,
          parameters: row.parameters,
          configPath: row.configPath,
          source: row.source,
        },
        null,
        2,
      ) + '\n',
    );
    return 0;
  }
  stdout.write(renderHuman(row));
  return 0;
}

export function registerDeployPlanCommand(
  program: Command,
  streams: DeployPlanStreams = {},
): void {
  let deployGroup: Command | undefined = program.commands.find(
    (c: Command) => c.name() === 'deploy',
  );
  if (!deployGroup) {
    deployGroup = program
      .command('deploy')
      .description('Deployment operations')
      .exitOverride();
  }
  deployGroup
    .command('plan')
    .description('Preview the resolved environment, backend, parameters, and cost. Read-only.')
    .option('--env <name>', 'Environment name (default: dev)')
    .option('--backend <name>', 'Override backend (request-override source)')
    .option('--json', 'Emit JSON instead of a human-readable summary', false)
    .option('--request-dir <path>', 'Override the request worktree directory')
    .action(async (opts: Record<string, unknown>) => {
      const code = await runDeployPlan(
        {
          env: typeof opts.env === 'string' ? opts.env : undefined,
          backend: typeof opts.backend === 'string' ? opts.backend : undefined,
          json: opts.json === true,
          requestDir: typeof opts.requestDir === 'string' ? opts.requestDir : undefined,
        },
        streams,
      );
      if (code !== 0) {
        throw Object.assign(new Error('deploy plan failed'), { exitCode: code });
      }
    });
}
