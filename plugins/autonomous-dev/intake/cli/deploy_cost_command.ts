/**
 * `autonomous-dev deploy cost` CLI (SPEC-023-3-03, Task 8).
 *
 * Read-only spend reporting against the daily/monthly HMAC-chained cost
 * ledger (`intake/deploy/cost-ledger.ts`). Default window is `--day`;
 * `--month` aggregates the entire current calendar UTC month. Filters
 * by `--env` and `--backend` are applied before aggregation. `--json`
 * emits a machine-readable object (DailyAggregate plus cap_usd,
 * pct_of_cap, window).
 *
 * Exit codes:
 *   - 0 success
 *   - 2 ledger corruption (with stderr message)
 *
 * @module intake/cli/deploy_cost_command
 */

import { Command } from 'commander';

import { CostLedger } from '../deploy/cost-ledger';
import {
  DEFAULT_CAP_USD_PER_DAY,
  type CostCapConfig,
} from '../deploy/cost-cap-enforcer';
import { CostLedgerCorruptError, CostLedgerKeyMissingError } from '../deploy/errors';
import type { AggregateWindow, DailyAggregate } from '../deploy/cost-ledger-types';

export interface DeployCostStreams {
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface DeployCostOptions {
  day?: boolean;
  month?: boolean;
  env?: string;
  backend?: string;
  json?: boolean;
  /** Test seam: pre-built ledger; production builds one via `new CostLedger()`. */
  ledger?: CostLedger;
  /** Test seam: config provider; defaults to a static cap. */
  config?: () => Promise<CostCapConfig> | CostCapConfig;
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** Render the human-readable text output. Pure for testability. */
export function renderCostReport(
  agg: DailyAggregate,
  capUsd: number,
  window: AggregateWindow,
): string {
  const projected = agg.totalActual + agg.openEstimates;
  const pct = capUsd > 0 ? projected / capUsd : 0;
  const lines: string[] = [];
  lines.push(`Deploy cost (${window} window, UTC)`);
  lines.push('');
  lines.push(`  Estimated:        ${formatUsd(agg.totalEstimated)}`);
  lines.push(`  Actual:           ${formatUsd(agg.totalActual)}`);
  lines.push(`  Open (unrec'd):   ${formatUsd(agg.openEstimates)}`);
  lines.push(`  Entries:          ${agg.entryCount}`);
  lines.push(`  Cap (USD/day):    ${formatUsd(capUsd)}`);
  lines.push(`  % of cap:         ${(pct * 100).toFixed(1)}%`);
  lines.push('');
  lines.push('  By env:');
  const envKeys = Object.keys(agg.byEnv).sort();
  if (envKeys.length === 0) lines.push('    (none)');
  for (const k of envKeys) lines.push(`    ${k}: ${formatUsd(agg.byEnv[k])}`);
  lines.push('');
  lines.push('  By backend:');
  const beKeys = Object.keys(agg.byBackend).sort();
  if (beKeys.length === 0) lines.push('    (none)');
  for (const k of beKeys) lines.push(`    ${k}: ${formatUsd(agg.byBackend[k])}`);
  return lines.join('\n') + '\n';
}

/** Run `deploy cost`. Returns the process exit code. */
export async function runDeployCost(
  opts: DeployCostOptions,
  streams: DeployCostStreams = {},
): Promise<number> {
  const stdout = streams.stdout ?? process.stdout;
  const stderr = streams.stderr ?? process.stderr;
  const window: AggregateWindow = opts.month ? 'month' : 'day';
  const ledger = opts.ledger ?? new CostLedger();
  const cfgProvider =
    opts.config ?? (() => ({ cost_cap_usd_per_day: DEFAULT_CAP_USD_PER_DAY }));

  let cfg: CostCapConfig;
  try {
    cfg = await cfgProvider();
  } catch {
    cfg = { cost_cap_usd_per_day: DEFAULT_CAP_USD_PER_DAY };
  }
  const capUsd =
    cfg.cost_cap_usd_per_day > 0
      ? cfg.cost_cap_usd_per_day
      : DEFAULT_CAP_USD_PER_DAY;

  let agg: DailyAggregate;
  try {
    agg = await ledger.aggregate({
      window,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.backend ? { backend: opts.backend } : {}),
    });
  } catch (err) {
    if (err instanceof CostLedgerCorruptError) {
      stderr.write(`error: cost ledger corrupt: ${err.message}\n`);
      return 2;
    }
    if (err instanceof CostLedgerKeyMissingError) {
      stderr.write(`error: ${err.message}\n`);
      return 2;
    }
    throw err;
  }
  const projected = agg.totalActual + agg.openEstimates;
  const pct = capUsd > 0 ? projected / capUsd : 0;

  if (opts.json) {
    const payload = {
      ...agg,
      cap_usd: capUsd,
      pct_of_cap: Number(pct.toFixed(4)),
      window,
    };
    stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return 0;
  }
  stdout.write(renderCostReport(agg, capUsd, window));
  return 0;
}

/** Plug `deploy cost` under the top-level `deploy` group. */
export function registerDeployCostCommand(
  program: Command,
  streams: DeployCostStreams = {},
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
    .command('cost')
    .description('Report deploy spend against the daily/monthly cap')
    .option('--day', 'Aggregate the current UTC day (default)', false)
    .option('--month', 'Aggregate the current UTC calendar month', false)
    .option('--env <env>', 'Filter to one environment')
    .option('--backend <name>', 'Filter to one backend')
    .option('--json', 'Emit JSON instead of text', false)
    .action(async (opts: Record<string, unknown>) => {
      const code = await runDeployCost(
        {
          day: opts.day === true,
          month: opts.month === true,
          ...(typeof opts.env === 'string' ? { env: opts.env } : {}),
          ...(typeof opts.backend === 'string' ? { backend: opts.backend } : {}),
          json: opts.json === true,
        },
        streams,
      );
      if (code !== 0) throw new Error('deploy cost failed');
    });
}
