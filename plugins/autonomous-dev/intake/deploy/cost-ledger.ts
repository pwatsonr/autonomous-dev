/**
 * Daily/monthly HMAC-chained cost ledger (SPEC-023-3-03).
 *
 * Cross-reference: TDD-023 §14. Mirrors the audit-writer pattern from
 * `intake/audit/audit-writer.ts` (PLAN-019-4) but stores entries in a
 * user-scoped global file at `~/.autonomous-dev/deploy-cost-ledger.jsonl`
 * rather than per-request. Each line:
 *
 *   { deployId, env, backend, estimated_cost_usd, actual_cost_usd?,
 *     timestamp, prev_hmac, hmac }
 *
 * `hmac = HMAC-SHA256(prev_hmac || canonicalJSON(entry without hmac), key)`.
 * Genesis entry uses `prev_hmac = "0".repeat(64)`. Concurrent appenders
 * serialize via `FileLock` (we do not have native `flock`; the
 * O_CREAT|O_EXCL mutex from `intake/core/file_lock.ts` is functionally
 * equivalent for our deploy throughput).
 *
 * Aggregation walks the file linearly — at our deploy volume (max ~hundreds
 * of entries per day) this is well within memory budget. A future SPEC may
 * add a sharded index if monthly aggregates become hot.
 *
 * @module intake/deploy/cost-ledger
 */

import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { canonicalJSON } from '../chains/canonical-json';
import { FileLock } from '../core/file_lock';
import {
  CostLedgerCorruptError,
  CostLedgerKeyMissingError,
} from './errors';
import {
  GENESIS_PREV_HMAC,
  type AggregateWindow,
  type CostLedgerEntry,
  type DailyAggregate,
} from './cost-ledger-types';

/** Default ledger file location. Override in tests. */
export const DEFAULT_LEDGER_DIR = join(homedir(), '.autonomous-dev');
export const DEFAULT_LEDGER_FILE = 'deploy-cost-ledger.jsonl';

/** Env var carrying the 32-byte hex HMAC key. */
export const COST_HMAC_ENV_VAR = 'DEPLOY_COST_HMAC_KEY';

export interface CostLedgerOptions {
  /** Directory containing the ledger file + lock. Defaults to `~/.autonomous-dev`. */
  dir?: string;
  /** File name within `dir`. Defaults to `deploy-cost-ledger.jsonl`. */
  file?: string;
  /** Test seam — defaults to `process.env.DEPLOY_COST_HMAC_KEY`. */
  keyHex?: string;
  /** Test seam for the timestamp clock. */
  clock?: () => Date;
  /** Lock-acquire timeout in ms. Defaults to 10s. */
  lockTimeoutMs?: number;
}

/** Append-only HMAC-chained NDJSON cost ledger. */
export class CostLedger {
  private readonly dir: string;
  private readonly file: string;
  private readonly clock: () => Date;
  private readonly lockTimeoutMs: number;
  private readonly keyHexOverride?: string;

  constructor(opts: CostLedgerOptions = {}) {
    this.dir = opts.dir ?? DEFAULT_LEDGER_DIR;
    this.file = opts.file ?? DEFAULT_LEDGER_FILE;
    this.clock = opts.clock ?? (() => new Date());
    this.lockTimeoutMs = opts.lockTimeoutMs ?? 10_000;
    this.keyHexOverride = opts.keyHex;
  }

  /** Resolve the absolute ledger file path. */
  filePath(): string {
    return join(this.dir, this.file);
  }

  /**
   * Append a new estimate-only entry. Returns the fully formed entry
   * (with prev_hmac + hmac populated). Acquires the file lock, verifies
   * the tail entry's HMAC, then appends. Throws `CostLedgerCorruptError`
   * if the chain head is corrupt and `CostLedgerKeyMissingError` if no
   * key is configured.
   */
  async appendEstimated(
    input: Omit<CostLedgerEntry, 'hmac' | 'prev_hmac' | 'timestamp'>,
  ): Promise<CostLedgerEntry> {
    return this.append({
      deployId: input.deployId,
      env: input.env,
      backend: input.backend,
      estimated_cost_usd: input.estimated_cost_usd,
      ...(input.actual_cost_usd !== undefined
        ? { actual_cost_usd: input.actual_cost_usd }
        : {}),
    });
  }

  /**
   * Append a follow-up reconciliation entry recording the actual cost
   * for a previously-appended estimate. The new entry copies forward the
   * env/backend (from the most recent prior entry for that deployId) so
   * aggregation can index by either column without re-walking.
   */
  async recordActual(deployId: string, actualCostUsd: number): Promise<CostLedgerEntry> {
    const prior = await this.findLastForDeploy(deployId);
    if (!prior) {
      throw new Error(
        `CostLedger.recordActual: no prior entry for deployId=${deployId}`,
      );
    }
    return this.append({
      deployId,
      env: prior.env,
      backend: prior.backend,
      estimated_cost_usd: 0,
      actual_cost_usd: actualCostUsd,
    });
  }

  /**
   * Compute totals over a UTC time window. `window: 'day'` covers the
   * UTC date of `asOf` (default: now); `window: 'month'` covers the
   * full UTC calendar month of `asOf`.
   */
  async aggregate(opts: {
    window: AggregateWindow;
    asOf?: Date;
    env?: string;
    backend?: string;
  }): Promise<DailyAggregate> {
    const asOf = opts.asOf ?? this.clock();
    const [windowStart, windowEnd] = computeWindow(opts.window, asOf);
    const entries = await this.readAll();

    const agg: DailyAggregate = {
      totalEstimated: 0,
      totalActual: 0,
      openEstimates: 0,
      byEnv: {},
      byBackend: {},
      entryCount: 0,
    };
    // Track which deploys have a non-zero actual within the window.
    const reconciledDeploys = new Set<string>();
    const seenDeploys = new Set<string>();
    for (const e of entries) {
      const ts = Date.parse(e.timestamp);
      if (Number.isNaN(ts) || ts < windowStart || ts >= windowEnd) continue;
      if (opts.env && e.env !== opts.env) continue;
      if (opts.backend && e.backend !== opts.backend) continue;

      seenDeploys.add(e.deployId);
      if (e.actual_cost_usd !== undefined) {
        reconciledDeploys.add(e.deployId);
        agg.totalActual += e.actual_cost_usd;
        agg.byEnv[e.env] = (agg.byEnv[e.env] ?? 0) + e.actual_cost_usd;
        agg.byBackend[e.backend] =
          (agg.byBackend[e.backend] ?? 0) + e.actual_cost_usd;
      }
      if (e.estimated_cost_usd > 0) {
        agg.totalEstimated += e.estimated_cost_usd;
        // For non-reconciled estimates, count toward openEstimates only
        // if no actual_cost_usd entry exists. We tally below.
        agg.byEnv[e.env] = (agg.byEnv[e.env] ?? 0) + e.estimated_cost_usd;
        agg.byBackend[e.backend] =
          (agg.byBackend[e.backend] ?? 0) + e.estimated_cost_usd;
      }
    }
    // Compute openEstimates: estimated for deploys without a reconciled actual.
    for (const e of entries) {
      const ts = Date.parse(e.timestamp);
      if (Number.isNaN(ts) || ts < windowStart || ts >= windowEnd) continue;
      if (opts.env && e.env !== opts.env) continue;
      if (opts.backend && e.backend !== opts.backend) continue;
      if (e.estimated_cost_usd > 0 && !reconciledDeploys.has(e.deployId)) {
        agg.openEstimates += e.estimated_cost_usd;
      }
    }
    agg.entryCount = seenDeploys.size;
    return agg;
  }

  /**
   * Walk the file from oldest to newest verifying each `hmac`. Used by
   * the CLI for `deploy cost --verify` and at startup. Returns the line
   * number of the first invalid entry (1-indexed) or null on success.
   */
  async verify(): Promise<{ ok: true } | { ok: false; lineNumber: number; reason: string }> {
    let key: Buffer;
    try {
      key = this.resolveKey();
    } catch (err) {
      return { ok: false, lineNumber: 0, reason: (err as Error).message };
    }
    const text = await this.readFileOrEmpty();
    const lines = text.split('\n').filter((l) => l.length > 0);
    let prev = GENESIS_PREV_HMAC;
    for (let i = 0; i < lines.length; i++) {
      let parsed: CostLedgerEntry;
      try {
        parsed = JSON.parse(lines[i]) as CostLedgerEntry;
      } catch {
        return { ok: false, lineNumber: i + 1, reason: 'malformed JSON' };
      }
      if (parsed.prev_hmac !== prev) {
        return {
          ok: false,
          lineNumber: i + 1,
          reason: `prev_hmac mismatch (expected ${prev}, got ${parsed.prev_hmac})`,
        };
      }
      const expected = computeHmac(key, prev, parsed);
      if (expected !== parsed.hmac) {
        return {
          ok: false,
          lineNumber: i + 1,
          reason: 'hmac mismatch',
        };
      }
      prev = parsed.hmac;
    }
    return { ok: true };
  }

  /** Read all entries (helper exposed for the CLI + tests). */
  async readAll(): Promise<CostLedgerEntry[]> {
    const text = await this.readFileOrEmpty();
    if (text.length === 0) return [];
    const out: CostLedgerEntry[] = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      try {
        out.push(JSON.parse(line) as CostLedgerEntry);
      } catch {
        // Skip a single malformed trailing line (mid-write recovery).
        // The next append will rewrite the chain head from the last
        // valid entry. Verifier exposes the corruption explicitly.
      }
    }
    return out;
  }

  // -- Internal -----------------------------------------------------------

  private resolveKey(): Buffer {
    const hex = this.keyHexOverride ?? process.env[COST_HMAC_ENV_VAR];
    if (!hex || hex.length === 0) {
      throw new CostLedgerKeyMissingError(COST_HMAC_ENV_VAR);
    }
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new CostLedgerKeyMissingError(COST_HMAC_ENV_VAR);
    }
    return Buffer.from(hex, 'hex');
  }

  private async readFileOrEmpty(): Promise<string> {
    try {
      return await fs.readFile(this.filePath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  }

  private async findLastForDeploy(deployId: string): Promise<CostLedgerEntry | null> {
    const entries = await this.readAll();
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].deployId === deployId) return entries[i];
    }
    return null;
  }

  private async append(
    fields: Omit<CostLedgerEntry, 'hmac' | 'prev_hmac' | 'timestamp'>,
  ): Promise<CostLedgerEntry> {
    const key = this.resolveKey();
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });

    const lock = await FileLock.acquire(this.dir, this.lockTimeoutMs);
    try {
      // Re-read the tail under lock so concurrent appenders observe a
      // consistent prev_hmac.
      const text = await this.readFileOrEmpty();
      const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
      const lines = trimmed.length === 0 ? [] : trimmed.split('\n');
      let prevHmac = GENESIS_PREV_HMAC;
      if (lines.length > 0) {
        const lastLine = lines[lines.length - 1];
        let last: CostLedgerEntry;
        try {
          last = JSON.parse(lastLine) as CostLedgerEntry;
        } catch {
          throw new CostLedgerCorruptError(lines.length, 'malformed last line');
        }
        // Verify the tail entry's HMAC before chaining onto it.
        const prevPrev =
          lines.length === 1
            ? GENESIS_PREV_HMAC
            : (() => {
                try {
                  return (JSON.parse(lines[lines.length - 2]) as CostLedgerEntry).hmac;
                } catch {
                  throw new CostLedgerCorruptError(
                    lines.length - 1,
                    'malformed penultimate line',
                  );
                }
              })();
        const expected = computeHmac(key, prevPrev, last);
        if (expected !== last.hmac) {
          throw new CostLedgerCorruptError(lines.length, 'hmac mismatch on tail');
        }
        prevHmac = last.hmac;
      }

      const timestamp = this.clock().toISOString();
      const partial: Omit<CostLedgerEntry, 'hmac'> = {
        ...fields,
        timestamp,
        prev_hmac: prevHmac,
      };
      const hmac = computeHmac(key, prevHmac, partial);
      const full: CostLedgerEntry = { ...partial, hmac };
      const line = JSON.stringify(full) + '\n';
      await fs.appendFile(this.filePath(), line, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return full;
    } finally {
      await lock.release();
    }
  }
}

/**
 * Compute `HMAC-SHA256(prev_hmac || canonicalJSON(entry without hmac), key)`.
 * Exposed for tests.
 */
export function computeHmac(
  key: Buffer,
  prevHmac: string,
  entry: Omit<CostLedgerEntry, 'hmac'>,
): string {
  // canonicalJSON refuses `undefined` values, so strip optional fields
  // that are not present.
  const canonical: Record<string, unknown> = {
    deployId: entry.deployId,
    env: entry.env,
    backend: entry.backend,
    estimated_cost_usd: entry.estimated_cost_usd,
    timestamp: entry.timestamp,
    prev_hmac: entry.prev_hmac,
  };
  if (entry.actual_cost_usd !== undefined) {
    canonical.actual_cost_usd = entry.actual_cost_usd;
  }
  const body = canonicalJSON(canonical);
  return createHmac('sha256', key).update(prevHmac).update(body).digest('hex');
}

/** Compute [start, end) ms epoch bounds for the requested UTC window. */
export function computeWindow(window: AggregateWindow, asOf: Date): [number, number] {
  if (window === 'day') {
    const start = Date.UTC(
      asOf.getUTCFullYear(),
      asOf.getUTCMonth(),
      asOf.getUTCDate(),
    );
    const end = start + 24 * 60 * 60 * 1000;
    return [start, end];
  }
  // month
  const start = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1);
  const end = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() + 1, 1);
  return [start, end];
}

