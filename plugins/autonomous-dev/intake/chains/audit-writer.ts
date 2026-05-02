/**
 * `ChainAuditWriter` — HMAC-chained append-only NDJSON forensics log
 * (SPEC-022-3-03, Tasks 6-7).
 *
 * Mirrors the contract of PLAN-019-4's `intake/audit/audit-writer.ts` but
 * targets a SEPARATE on-disk file (`~/.autonomous-dev/chains-audit.log`) so
 * chain forensics and hook forensics can be analyzed independently. The
 * key (`CHAINS_AUDIT_HMAC_KEY`) is also separate; rotating one does not
 * invalidate the other.
 *
 * Invariants:
 *   - `init()` opens (creates if absent, mode 0600) the log and recovers
 *     the chain head from the LAST line — daemon restart resumes the
 *     chain in O(1) regardless of file size.
 *   - `append()` is serialized by a JS-promise mutex so concurrent
 *     callers cannot race on `prevHmac` read-modify-write. Cross-process
 *     concurrency is bounded by `O_APPEND` atomic-write semantics on
 *     sub-`PIPE_BUF` lines.
 *   - The HMAC is taken over `canonicalJSON({ts, type, chain_id, payload,
 *     prev_hmac})` so verifiers reproduce the bytes deterministically.
 *   - Rotation: when the file exceeds `maxSizeMb` (default 100MB), the
 *     current file is renamed to `<path>.1`, `.1`→`.2`, …, `.9`→`.10`,
 *     `.10` is dropped, and a fresh chain (`prev_hmac = ''`) starts.
 *
 * Audit emission is fail-OPEN: if `append()` throws (disk full, etc.),
 * the executor logs ERROR and keeps running. Forensics gaps are
 * detectable via the entry-count mismatch in `chain_completed.entries`.
 *
 * @module intake/chains/audit-writer
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs, type FileHandle } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { canonicalJSON } from './canonical-json';
import {
  type ChainAuditEntry,
  type ChainEventPayloads,
  type ChainEventType,
} from './audit-events';

/** Default rotation cap (megabytes). */
export const DEFAULT_AUDIT_LOG_MAX_MB = 100;

/** Default log path. Overridable via the `logPath` constructor option. */
export function defaultChainAuditLogPath(home: string = homedir()): string {
  return join(home, '.autonomous-dev', 'chains-audit.log');
}

export interface ChainAuditWriterOptions {
  /** Absolute log path. Defaults to `~/.autonomous-dev/chains-audit.log`. */
  logPath?: string;
  /** 32-byte HMAC key. Required: callers must resolve via {@link getChainsAuditHmacKey}. */
  key: Buffer;
  /** Rotation cap in MB. Defaults to {@link DEFAULT_AUDIT_LOG_MAX_MB}. */
  maxSizeMb?: number;
  /** Test-only clock injection. Defaults to `() => new Date().toISOString()`. */
  clock?: () => string;
  /** Logger for the rare append/rotate failure. Defaults to console. */
  logger?: { warn: (s: string) => void; error?: (s: string) => void };
}

/**
 * Append-only HMAC-chained NDJSON writer. Use {@link ChainAuditWriter.open}
 * to construct.
 */
export class ChainAuditWriter {
  private fh: FileHandle | null;
  private mutex: Promise<unknown> = Promise.resolve();
  private prevHmac: string;
  private readonly key: Buffer;
  private readonly logPath: string;
  private readonly maxSizeBytes: number;
  private readonly clock: () => string;
  private readonly logger: { warn: (s: string) => void; error?: (s: string) => void };

  private constructor(
    fh: FileHandle,
    logPath: string,
    key: Buffer,
    prevHmac: string,
    maxSizeBytes: number,
    clock: () => string,
    logger: { warn: (s: string) => void; error?: (s: string) => void },
  ) {
    this.fh = fh;
    this.logPath = logPath;
    this.key = key;
    this.prevHmac = prevHmac;
    this.maxSizeBytes = maxSizeBytes;
    this.clock = clock;
    this.logger = logger;
  }

  /**
   * Open `logPath` (creating it with mode 0600 if absent) and recover the
   * chain head from the last existing line, if any. Empty/absent file →
   * `prevHmac = ''` (genesis).
   */
  static async open(opts: ChainAuditWriterOptions): Promise<ChainAuditWriter> {
    const logPath = opts.logPath ?? defaultChainAuditLogPath();
    await fs.mkdir(dirname(logPath), { recursive: true, mode: 0o700 });
    const fh = await fs.open(logPath, 'a', 0o600);
    try {
      await fs.chmod(logPath, 0o600);
    } catch {
      /* idempotent best-effort */
    }
    const prev = await readLastHmac(logPath);
    const maxSizeMb = opts.maxSizeMb ?? DEFAULT_AUDIT_LOG_MAX_MB;
    return new ChainAuditWriter(
      fh,
      logPath,
      opts.key,
      prev,
      maxSizeMb * 1024 * 1024,
      opts.clock ?? (() => new Date().toISOString()),
      opts.logger ?? {
        warn: (s: string) => console.warn(s),
        error: (s: string) => console.error(s),
      },
    );
  }

  /**
   * Append one entry. Serializes with prior in-flight appends so
   * `prevHmac` reads and writes are atomic.
   *
   * Returns the fully-formed entry for callers that want to verify or
   * echo it back. On any I/O failure the underlying error propagates;
   * the mutex itself is reset so a single failure does not poison
   * subsequent appends.
   */
  async append<T extends ChainEventType>(
    type: T,
    chainId: string,
    payload: ChainEventPayloads[T],
  ): Promise<ChainAuditEntry<T>> {
    const next = this.mutex.then(async () => {
      if (!this.fh) throw new Error('ChainAuditWriter: append() after close()');
      const ts = this.clock();
      const prev_hmac = this.prevHmac;
      const body = { ts, type, chain_id: chainId, payload, prev_hmac };
      const hmac = createHmac('sha256', this.key)
        .update(canonicalJSON(body))
        .digest('base64');
      const full: ChainAuditEntry<T> = { ...body, hmac };
      const line = JSON.stringify(full) + '\n';
      await this.fh.write(line, null, 'utf8');
      this.prevHmac = hmac;
      await this.maybeRotate();
      return full;
    });
    this.mutex = next.catch(() => {
      /* swallow on the chain so subsequent appends are not poisoned */
    });
    return next;
  }

  /** Wait for in-flight appends to settle and close the underlying fd. */
  async close(): Promise<void> {
    try {
      await this.mutex;
    } catch {
      /* the failing append already rejected its caller */
    }
    if (this.fh) {
      await this.fh.close();
      this.fh = null;
    }
  }

  /** Currently-known last HMAC. Useful for tests + chain-restart audits. */
  getLastHmac(): string {
    return this.prevHmac;
  }

  /** Path of the underlying log file. */
  getLogPath(): string {
    return this.logPath;
  }

  /**
   * Rotate when the file exceeds the cap. Called inside the mutex so the
   * file handle swap is race-free against concurrent appends.
   */
  private async maybeRotate(): Promise<void> {
    if (!this.fh) return;
    const stat = await this.fh.stat();
    if (stat.size <= this.maxSizeBytes) return;

    // Close current fd, then rotate .9→.10, .8→.9, … .1→.2, current→.1.
    await this.fh.close();
    this.fh = null;
    for (let i = 9; i >= 1; i--) {
      const src = `${this.logPath}.${i}`;
      const dst = `${this.logPath}.${i + 1}`;
      try {
        await fs.rename(src, dst);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT') throw err;
      }
    }
    await fs.rename(this.logPath, `${this.logPath}.1`);
    // Drop the oldest if it overflowed past .10.
    await fs.rm(`${this.logPath}.11`, { force: true });

    // Reopen a fresh empty file for the next chain.
    this.fh = await fs.open(this.logPath, 'a', 0o600);
    try {
      await fs.chmod(this.logPath, 0o600);
    } catch {
      /* best-effort */
    }
    // Each rotated file is its own HMAC chain; new chain starts at genesis.
    this.prevHmac = '';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the last newline-terminated line of `path` and return its parsed
 * `hmac` field, or '' if the file is empty/unreadable. Uses a backwards
 * `read()` chunk so we don't slurp huge logs into memory.
 *
 * Bumps chunk to 64 KiB to comfortably cover any reasonable single
 * payload (chain audit entries are small JSON objects, but large
 * `chain_started.plugins` lists could push a few hundred bytes).
 */
async function readLastHmac(path: string): Promise<string> {
  const stat = await fs.stat(path).catch(() => null);
  if (!stat || stat.size === 0) return '';

  const fh = await fs.open(path, 'r');
  try {
    const chunkSize = Math.min(65536, stat.size);
    const buf = Buffer.alloc(chunkSize);
    const start = Math.max(0, stat.size - chunkSize);
    const { bytesRead } = await fh.read(buf, 0, chunkSize, start);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    if (lastLine.trim().length === 0) return '';
    try {
      const parsed = JSON.parse(lastLine) as Partial<ChainAuditEntry>;
      if (typeof parsed.hmac === 'string' && parsed.hmac.length > 0) {
        return parsed.hmac;
      }
    } catch {
      // Corrupt last line — restart at genesis. The next `chains audit
      // verify` run will flag the bad line.
    }
    return '';
  } finally {
    await fh.close();
  }
}

/**
 * Recompute and verify the HMAC chain over an array of parsed entries.
 * Returns `{ ok: true }` on success or
 * `{ ok: false, line, reason }` on the first failure (1-based line idx).
 *
 * Used by both `chains audit verify` and the writer's own consistency
 * checks. Pure: no I/O.
 */
export interface VerifyResult {
  ok: boolean;
  line?: number;
  reason?: 'hmac_mismatch' | 'prev_hmac_mismatch';
  details?: { expected: string; got: string };
}

export function verifyChain(
  entries: ChainAuditEntry[],
  key: Buffer,
): VerifyResult {
  let priorHmac = '';
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const lineNum = i + 1;
    if (e.prev_hmac !== priorHmac) {
      return {
        ok: false,
        line: lineNum,
        reason: 'prev_hmac_mismatch',
        details: { expected: priorHmac, got: e.prev_hmac },
      };
    }
    const expected = createHmac('sha256', key)
      .update(
        canonicalJSON({
          ts: e.ts,
          type: e.type,
          chain_id: e.chain_id,
          payload: e.payload,
          prev_hmac: e.prev_hmac,
        }),
      )
      .digest('base64');
    const a = Buffer.from(expected, 'base64');
    const b = Buffer.from(e.hmac, 'base64');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return {
        ok: false,
        line: lineNum,
        reason: 'hmac_mismatch',
        details: { expected, got: e.hmac },
      };
    }
    priorHmac = e.hmac;
  }
  return { ok: true };
}
