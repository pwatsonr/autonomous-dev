/**
 * Per-environment cost-cap pre-check + ledger (SPEC-023-2-04).
 *
 * Skeleton introduced here so the orchestrator (SPEC-023-2-03) can
 * import the full contract; SPEC-023-2-04 fleshes out the daily-aggregate
 * + UTC-rollover behavior. Both shapes are stable across the two specs.
 *
 * Persistence: `<requestDir>/.autonomous-dev/deployments/cost-ledger-<env>.json`
 *
 * @module intake/deploy/cost-cap
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { canonicalJSON } from '../chains/canonical-json';

export interface CostLedgerEntry {
  deployId: string;
  usd: number;
  ts: string;
}

export interface CostLedger {
  envName: string;
  /** UTC date "YYYY-MM-DD" the ledger covers. */
  dayUtc: string;
  /** Sum of accepted deploys on `dayUtc`. */
  totalUsd: number;
  entries: CostLedgerEntry[];
}

export interface CheckCostCapArgs {
  requestDir: string;
  envName: string;
  /** 0 means no cap. */
  capUsd: number;
  estimatedUsd: number;
}

export type CheckCostCapResult =
  | { allowed: true; ledger: CostLedger }
  | { allowed: false; reason: string; ledger: CostLedger };

export interface RecordCostArgs {
  requestDir: string;
  envName: string;
  deployId: string;
  usd: number;
}

/** Test seam for deterministic UTC days. */
let dayOverride: (() => string) | null = null;
export function __setCostCapDayForTest(fn: (() => string) | null): void {
  dayOverride = fn;
}
function todayUtc(): string {
  if (dayOverride) return dayOverride();
  const d = new Date();
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function ledgerPath(requestDir: string, envName: string): string {
  return join(requestDir, '.autonomous-dev', 'deployments', `cost-ledger-${envName}.json`);
}
function archiveDir(requestDir: string): string {
  return join(requestDir, '.autonomous-dev', 'deployments', '.archive');
}

async function readLedger(requestDir: string, envName: string): Promise<CostLedger | null> {
  const path = ledgerPath(requestDir, envName);
  try {
    const text = await fs.readFile(path, 'utf8');
    return JSON.parse(text) as CostLedger;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function writeLedger(requestDir: string, ledger: CostLedger): Promise<void> {
  const path = ledgerPath(requestDir, ledger.envName);
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp.${randomBytes(8).toString('hex')}`;
  const handle = await fs.open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(canonicalJSON(ledger as unknown as Record<string, unknown>), {
      encoding: 'utf8',
    });
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, path);
}

async function rolloverIfNeeded(
  requestDir: string,
  envName: string,
  current: CostLedger | null,
  today: string,
): Promise<CostLedger> {
  if (current === null) {
    return { envName, dayUtc: today, totalUsd: 0, entries: [] };
  }
  if (current.dayUtc === today) return current;
  // Day boundary: move old ledger to .archive/cost-ledger-<env>-<date>.json.
  const arch = archiveDir(requestDir);
  await fs.mkdir(arch, { recursive: true, mode: 0o700 });
  const archPath = join(arch, `cost-ledger-${envName}-${current.dayUtc}.json`);
  await fs.rename(ledgerPath(requestDir, envName), archPath).catch(() => undefined);
  return { envName, dayUtc: today, totalUsd: 0, entries: [] };
}

/**
 * Decide whether `estimatedUsd` may proceed against `capUsd` given the
 * current ledger state for today (UTC). Does NOT mutate the ledger.
 */
export async function checkCostCap(args: CheckCostCapArgs): Promise<CheckCostCapResult> {
  const today = todayUtc();
  let ledger = await readLedger(args.requestDir, args.envName);
  ledger = await rolloverIfNeeded(args.requestDir, args.envName, ledger, today);

  if (args.capUsd === 0) {
    return { allowed: true, ledger };
  }
  if (args.estimatedUsd > args.capUsd) {
    return {
      allowed: false,
      reason: 'single deploy estimate exceeds cap',
      ledger,
    };
  }
  if (ledger.totalUsd + args.estimatedUsd > args.capUsd) {
    return {
      allowed: false,
      reason: 'estimate would exceed daily cap',
      ledger,
    };
  }
  return { allowed: true, ledger };
}

/**
 * Append a successful deploy's cost to today's ledger. Idempotent on
 * `deployId`: a second call with the same id is a no-op.
 */
export async function recordCost(args: RecordCostArgs): Promise<void> {
  const today = todayUtc();
  let ledger = await readLedger(args.requestDir, args.envName);
  ledger = await rolloverIfNeeded(args.requestDir, args.envName, ledger, today);

  if (ledger.entries.some((e) => e.deployId === args.deployId)) return;

  const entry: CostLedgerEntry = {
    deployId: args.deployId,
    usd: args.usd,
    ts: new Date().toISOString(),
  };
  const next: CostLedger = {
    ...ledger,
    totalUsd: ledger.totalUsd + args.usd,
    entries: [...ledger.entries, entry],
  };
  await writeLedger(args.requestDir, next);
}

/** Test/CLI helper to read today's ledger without mutation. */
export async function readTodayLedger(
  requestDir: string,
  envName: string,
): Promise<CostLedger> {
  const today = todayUtc();
  let ledger = await readLedger(requestDir, envName);
  ledger = await rolloverIfNeeded(requestDir, envName, ledger, today);
  return ledger;
}
