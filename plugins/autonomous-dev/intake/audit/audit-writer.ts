/**
 * AuditWriter — single-fd append-only HMAC-chained NDJSON writer
 * (SPEC-019-4-04, Task 7).
 *
 * Implementation choice (documented per PLAN-019-4 instructions): the
 * pre-existing `intake/authz/audit_logger.ts` is a SQLite-backed authz
 * decision logger and does NOT speak the file-based HMAC-chained NDJSON
 * contract this spec requires (PLAN-014-3 used a different format for the
 * portal). We therefore implement option (b): a fresh `AuditWriter` that
 * owns the chain and key directly. It does NOT wrap the authz logger;
 * the two systems serve disjoint surfaces.
 *
 * Invariants:
 *   - The fd is opened with `O_WRONLY | O_APPEND | O_CREAT`, mode 0600,
 *     so even cross-process writers cannot interleave bytes within a
 *     single sub-`PIPE_BUF` write.
 *   - A JS-level promise mutex (`this.mutex = this.mutex.then(...)`)
 *     serializes appends within the process so chain reads/writes of
 *     `lastHmac` are atomic from the JS scheduler's perspective.
 *   - On open of a non-empty log, the LAST line is parsed and its `hmac`
 *     becomes the new `lastHmac` so a daemon restart continues the chain.
 *   - Lines exceeding `MAX_ENTRY_BYTES` are truncated by replacing the
 *     `payload` with a `_truncated` marker before signing — the marker is
 *     itself signed so the truncation is auditable.
 *
 * Cross-reference: SPEC-019-4-04 Writer; TDD-019 §14.
 *
 * @module intake/audit/audit-writer
 */

import { createHmac } from 'node:crypto';
import { promises as fs, type FileHandle } from 'node:fs';

import { canonicalize } from '../hooks/fingerprint';
import {
  GENESIS_HMAC,
  MAX_ENTRY_BYTES,
  MAX_PAYLOAD_BYTES,
  type AuditEntryCommon,
  type AuditEntryInput,
} from './audit-types';

export interface AuditWriterOpenOptions {
  /** Absolute path to the audit log file. Created if absent (mode 0600). */
  logPath: string;
  /** 32-byte HMAC key from `resolveAuditKey()`. */
  key: Buffer;
}

/**
 * Append-only HMAC-chained audit writer. See module-level doc for the
 * full invariant set. Use `AuditWriter.open(opts)` to construct.
 */
export class AuditWriter {
  private fh: FileHandle | null;
  private mutex: Promise<unknown> = Promise.resolve();
  private lastHmac: string;
  private readonly key: Buffer;
  private readonly logPath: string;

  private constructor(fh: FileHandle, logPath: string, key: Buffer, lastHmac: string) {
    this.fh = fh;
    this.logPath = logPath;
    this.key = key;
    this.lastHmac = lastHmac;
  }

  /**
   * Open `logPath` (creating it with mode 0600 if absent) and recover the
   * chain head from the last existing line, if any.
   */
  static async open(opts: AuditWriterOpenOptions): Promise<AuditWriter> {
    // Ensure mode 0600 even if the file already exists with looser perms;
    // chmod is idempotent and hardens against operator misconfig.
    const fh = await fs.open(opts.logPath, 'a', 0o600);
    try {
      await fs.chmod(opts.logPath, 0o600);
    } catch {
      // chmod failures are non-fatal (e.g. read-only fs in tests); the open
      // already succeeded with the correct mode for the create path.
    }
    const lastHmac = await readLastHmac(opts.logPath);
    return new AuditWriter(fh, opts.logPath, opts.key, lastHmac);
  }

  /**
   * Append one entry. Serializes with prior in-flight appends via a JS
   * promise mutex so `lastHmac` reads and writes are atomic.
   *
   * Returns the fully-formed entry (including computed `prev_hmac` and
   * `hmac`) so callers can verify or echo it back to operators.
   */
  async append(entry: AuditEntryInput): Promise<AuditEntryCommon> {
    const next = this.mutex.then(async () => {
      if (!this.fh) throw new Error('AuditWriter: append() after close()');
      const prev_hmac = this.lastHmac;

      // Truncate oversized payloads BEFORE signing so the truncation marker
      // is part of the signed bytes and survives verification round-trips.
      const payload = maybeTruncatePayload(entry.payload);

      const signedBody = canonicalize({
        ts: entry.ts,
        type: entry.type,
        plugin_id: entry.plugin_id,
        plugin_version: entry.plugin_version,
        payload,
      });
      const hmac = createHmac('sha256', this.key)
        .update(prev_hmac)
        .update(signedBody)
        .digest('hex');

      const full: AuditEntryCommon = { ...entry, payload, prev_hmac, hmac };
      const line = JSON.stringify(full) + '\n';
      // Hard ceiling: if even the truncated form exceeds PIPE_BUF, refuse
      // (this should be unreachable because `maybeTruncatePayload` caps the
      // payload well below MAX_ENTRY_BYTES, but an aberrant ts/type/plugin
      // identity could in principle push past). Failing loud beats silently
      // breaking the chain.
      if (Buffer.byteLength(line, 'utf8') > MAX_ENTRY_BYTES) {
        throw new Error(
          `AuditWriter: serialized entry exceeds ${MAX_ENTRY_BYTES} bytes after truncation; identity fields too large`,
        );
      }
      await this.fh.write(line, null, 'utf8');
      this.lastHmac = hmac;
      return full;
    });
    this.mutex = next.catch(() => {
      // Swallow rejection on the mutex chain itself so a failed append
      // does not poison subsequent appends. The `next` promise still
      // rejects to the caller below.
    });
    return next;
  }

  /** Wait for in-flight appends to settle and close the underlying fd. */
  async close(): Promise<void> {
    try {
      await this.mutex;
    } catch {
      // ignore — the failing append already rejected its caller.
    }
    if (this.fh) {
      await this.fh.close();
      this.fh = null;
    }
  }

  /** Currently-known last HMAC. Useful for tests + chain-restart audits. */
  getLastHmac(): string {
    return this.lastHmac;
  }

  /** Path of the underlying log file. */
  getLogPath(): string {
    return this.logPath;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the last newline-terminated line of `path` and return its parsed
 * `hmac` field, or `GENESIS` if the file is empty/unreadable.
 *
 * Uses a backwards `read()` walk so we don't slurp 100MB logs into memory.
 */
async function readLastHmac(path: string): Promise<string> {
  const stat = await fs.stat(path).catch(() => null);
  if (!stat || stat.size === 0) return GENESIS_HMAC;

  const fh = await fs.open(path, 'r');
  try {
    const chunkSize = Math.min(4096, stat.size);
    const buf = Buffer.alloc(chunkSize);
    // Read the trailing chunk; this covers all entries because
    // MAX_ENTRY_BYTES === 4096 so the last line is always inside.
    const start = Math.max(0, stat.size - chunkSize);
    const { bytesRead } = await fh.read(buf, 0, chunkSize, start);
    const text = buf.slice(0, bytesRead).toString('utf8');
    // Strip a trailing newline so split doesn't yield an empty tail.
    const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    if (lastLine.trim().length === 0) return GENESIS_HMAC;
    try {
      const parsed = JSON.parse(lastLine) as Partial<AuditEntryCommon>;
      if (typeof parsed.hmac === 'string' && parsed.hmac.length > 0) {
        return parsed.hmac;
      }
    } catch {
      // Corrupt last line — treat as GENESIS so the next entry restarts the
      // chain rather than amplifying the corruption. Verifier will flag the
      // bad line on the next `audit verify` run.
    }
    return GENESIS_HMAC;
  } finally {
    await fh.close();
  }
}

/**
 * If `payload` would push the serialized line past `MAX_PAYLOAD_BYTES`,
 * replace it with a truncation marker that records the original size and
 * the type set of the original payload. The truncated form is signed so
 * verifiers see the same canonicalization the writer produced.
 */
function maybeTruncatePayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const serialized = canonicalize(payload);
  const size = Buffer.byteLength(serialized, 'utf8');
  if (size <= MAX_PAYLOAD_BYTES) return payload;
  return {
    _truncated: true,
    _original_size: size,
    _original_keys: Object.keys(payload).sort(),
  };
}
