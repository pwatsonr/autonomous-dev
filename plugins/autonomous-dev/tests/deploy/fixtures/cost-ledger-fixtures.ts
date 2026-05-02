/**
 * Test fixtures for SPEC-023-3-04 cost-ledger / cost-cap tests.
 *
 * Builder functions construct an HMAC-chained ledger file at a desired
 * percentage of cap. Ledgers are signed against the test key supplied via
 * `process.env.DEPLOY_COST_HMAC_KEY` (set per-test). No JSONL fixtures are
 * checked in: doing so would couple the suite to a specific key.
 *
 * @module tests/deploy/fixtures/cost-ledger-fixtures
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { CostLedger } from '../../../intake/deploy/cost-ledger';

/** Test key — exactly 32 bytes hex (64 chars). */
export const TEST_HMAC_KEY = 'a'.repeat(64);

export interface BuildLedgerArgs {
  /** Directory the ledger lives in. */
  dir: string;
  /** Total spend as a percent of cap (e.g. 80 for 80% of cap). */
  percent: number;
  /** Cap in USD per day. Defaults to 100 so percent maps 1:1. */
  capUsd?: number;
  /** Number of entries to spread the spend over. Default 1. */
  entries?: number;
  /** Default "now" used for timestamps. */
  now?: () => Date;
  /** Default env tag. */
  env?: string;
  /** Default backend tag. */
  backend?: string;
}

/**
 * Build a real HMAC-chained ledger file at the requested fill percent.
 * Uses the production `CostLedger` so the chain is byte-for-byte what the
 * appender would have written.
 */
export async function buildLedgerAt(args: BuildLedgerArgs): Promise<{
  ledger: CostLedger;
  totalSpentUsd: number;
}> {
  const cap = args.capUsd ?? 100;
  const total = (args.percent / 100) * cap;
  const entries = args.entries ?? 1;
  const per = total / entries;
  const now =
    args.now ??
    (() => new Date(Date.UTC(2026, 4, 2, 12, 0, 0))); // 2026-05-02T12:00:00Z

  const ledger = new CostLedger({
    dir: args.dir,
    keyHex: TEST_HMAC_KEY,
    clock: now,
  });
  for (let i = 0; i < entries; i++) {
    await ledger.appendEstimated({
      deployId: `dep-${i.toString().padStart(4, '0')}`,
      env: args.env ?? 'prod',
      backend: args.backend ?? 'static',
      estimated_cost_usd: per,
    });
  }
  return { ledger, totalSpentUsd: total };
}

/**
 * Materialize an admin override file at `dir/deploy-cap-overrides.json`
 * with the given records.
 */
export async function writeOverrides(
  dir: string,
  overrides: { actor: string; deployId: string; expires_at: string }[],
): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'deploy-cap-overrides.json');
  await fs.writeFile(path, JSON.stringify({ overrides }, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
}
