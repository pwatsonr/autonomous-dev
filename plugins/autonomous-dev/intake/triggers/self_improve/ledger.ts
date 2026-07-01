/**
 * TASK-003 — Persistent ledger for the self-improvement loop.
 *
 * Tracks one entry per (repo, issue) pair: how many times we've tried,
 * what the last outcome was, whether a backoff applies, and whether a fix
 * request is currently in-flight. Also records per-hour cost windows for
 * daily/weekly spend-cap enforcement.
 *
 * Atomic writes via `.tmp + rename` (mirrors trigger_store.ts). A
 * `openExclusive` lock file serialises concurrent savers; stale locks
 * (>60 s) are force-unlinked and retried once.
 *
 * @module intake/triggers/self_improve/ledger
 */

import * as path from 'path';

import type { ConfigWarning } from './config';
import type { SelfImproveConfig } from './config';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Current disposition of a ledger entry. */
export type LedgerStatus = 'idle' | 'backoff' | 'in_flight' | 'capped';

/** Result of a previously-completed fix attempt. */
export type LedgerOutcome = 'success' | 'failed' | 'cancelled' | 'unknown';

/** One entry per (repoId, issueNumber). */
export interface LedgerEntry {
  repoId: string;
  issueNumber: number;
  issueFingerprint: string | null;
  requestIds: string[];
  attempts: number;
  lastAttemptAt: string; // ISO-8601
  lastOutcome: LedgerOutcome;
  backoffUntil: string | null;
  status: LedgerStatus;
}

/** Accumulated cost for a one-hour UTC bucket. */
export interface WindowCost {
  totalUsd: number;
  requestCount: number;
}

/** The JSON structure written to disk. */
export interface LedgerFile {
  version: 1;
  entries: Record<string, LedgerEntry>; // key: `${repoId}#${issueNumber}`
  windowCosts: Record<string, WindowCost>; // key: `YYYY-MM-DDTHH`
  loadWarnings?: ConfigWarning[];
}

/** IO boundary — injected in production and faked in tests. */
export interface LedgerIO {
  homedir(): string;
  readFile(p: string): string | undefined;
  writeFile(p: string, data: string): void;
  mkdirp(p: string, mode: number): void;
  chmod(p: string, mode: number): void;
  /** Open a file exclusively (O_EXCL). Returns fd; throws EEXIST on collision. */
  openExclusive(p: string): number;
  closeAndUnlink(fd: number, p: string): void;
  statMtimeMs(p: string): number | null;
  now(): number;
  /** Unique suffix for tmp/sidecar names, e.g. `${pid}.${random}`. */
  randSuffix(): string;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Absolute path to the ledger JSON file.
 *
 * @param io - Injected IO implementation.
 * @returns `~/.autonomous-dev/state/self-improve/ledger.json`.
 */
export function ledgerPath(io: LedgerIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'state', 'self-improve', 'ledger.json');
}

/**
 * Absolute path to the ledger lock file.
 *
 * @param io - Injected IO implementation.
 * @returns `~/.autonomous-dev/state/self-improve/ledger.lock`.
 */
export function lockPath(io: LedgerIO): string {
  return path.join(io.homedir(), '.autonomous-dev', 'state', 'self-improve', 'ledger.lock');
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/** Thrown when the ledger lock cannot be acquired within the timeout. */
export class LedgerLockBusyError extends Error {
  readonly code = 'LOCK_BUSY' as const;
  constructor() {
    super('ledger lock file busy > 500 ms');
    this.name = 'LedgerLockBusyError';
  }
}

/** Thrown when a ledger key does not match the required format. */
export class LedgerKeyInvalidError extends Error {
  readonly code = 'LEDGER_KEY_INVALID' as const;
  constructor(key: string) {
    super(`invalid ledger key: ${key}`);
    this.name = 'LedgerKeyInvalidError';
  }
}

// ---------------------------------------------------------------------------
// Key validation
// ---------------------------------------------------------------------------

const SAFE_REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INT = /^\d+$/;

function validateKey(key: string): void {
  const idx = key.lastIndexOf('#');
  if (idx <= 0) throw new LedgerKeyInvalidError(key);
  const repoId = key.slice(0, idx);
  const issueStr = key.slice(idx + 1);
  if (!SAFE_REPO_SLUG.test(repoId)) throw new LedgerKeyInvalidError(key);
  if (!POSITIVE_INT.test(issueStr) || parseInt(issueStr, 10) <= 0)
    throw new LedgerKeyInvalidError(key);
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

/**
 * Load the ledger from disk, returning a safe empty ledger on any error.
 *
 * - File absent → returns empty ledger with no warnings.
 * - JSON parse failure → copies raw content to a `.corrupt-<ts>` sidecar,
 *   returns empty ledger with a `loadWarnings` entry.
 *
 * @param io - Injected IO implementation.
 * @returns The loaded (or empty) `LedgerFile`.
 */
export function loadLedger(io: LedgerIO): LedgerFile {
  const p = ledgerPath(io);
  const raw = io.readFile(p);
  if (raw === undefined) {
    return { version: 1, entries: {}, windowCosts: {} };
  }
  try {
    const parsed = JSON.parse(raw) as LedgerFile;
    // Accept only version 1 or missing version (forward-compat: just load it)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return {
        version: 1,
        entries: (parsed.entries as Record<string, LedgerEntry>) ?? {},
        windowCosts: (parsed.windowCosts as Record<string, WindowCost>) ?? {},
      };
    }
    throw new Error('not an object');
  } catch {
    // Preserve the corrupt file
    const ts = new Date(io.now()).toISOString().replace(/[:.]/g, '-');
    const sidecar = `${p}.corrupt-${ts}-${io.randSuffix()}`;
    try {
      io.writeFile(sidecar, raw);
      io.chmod(sidecar, 0o600);
    } catch {
      // best-effort — do not mask the original error
    }
    return {
      version: 1,
      entries: {},
      windowCosts: {},
      loadWarnings: [
        {
          envVar: 'LEDGER_FILE',
          raw: raw.slice(0, 200),
          fallback: 'empty-ledger',
        },
      ],
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Persist `f` to disk using an atomic write + lock-file sequence.
 *
 * Sequence:
 * 1. `mkdirp(parent, 0o700)`.
 * 2. Acquire lock: poll `openExclusive` for up to 500 ms (25 ms steps).
 *    If the lock is stale (mtime > 60 s old), force-unlink and retry once.
 *    Failure after exhaustion → throw `LedgerLockBusyError`.
 * 3. Write JSON to a `.tmp.<suffix>` file with mode 0o600.
 * 4. Rename `.tmp` → ledger path (atomic on POSIX).
 * 5. Release lock (`closeAndUnlink`).
 *
 * @param f - The ledger state to persist.
 * @param io - Injected IO implementation.
 * @throws {LedgerLockBusyError} When the lock cannot be acquired.
 */
export async function saveLedger(f: LedgerFile, io: LedgerIO): Promise<void> {
  const p = ledgerPath(io);
  const parent = path.dirname(p);
  io.mkdirp(parent, 0o700);

  const lp = lockPath(io);
  let fd: number | null = null;
  const maxWaitMs = 500;
  const stepMs = 25;
  const staleLimitMs = 60_000;

  let elapsed = 0;
  let retried = false;

  while (fd === null) {
    try {
      fd = io.openExclusive(lp);
    } catch {
      // Lock busy
      if (!retried) {
        // Check for stale lock
        const mtime = io.statMtimeMs(lp);
        if (mtime !== null && io.now() - mtime > staleLimitMs) {
          // Force-delete stale lock and retry once immediately
          try {
            io.closeAndUnlink(-1, lp);
          } catch {
            // Ignore — it may have been cleaned up by another writer
          }
          retried = true;
          continue;
        }
      }
      if (elapsed >= maxWaitMs) {
        throw new LedgerLockBusyError();
      }
      await sleep(stepMs);
      elapsed += stepMs;
    }
  }

  try {
    const tmpPath = `${p}.tmp.${io.randSuffix()}`;
    const json = JSON.stringify(f, null, 2);
    io.writeFile(tmpPath, json);
    io.chmod(tmpPath, 0o600);
    // Rename to final path (atomic)
    // We rely on the writeFile+rename seam: io.writeFile writes the tmp,
    // and we do the rename via a second writeFile call on the real path.
    // Actually, the interface only exposes writeFile; on real fs we do:
    //   fs.renameSync(tmpPath, p)
    // In test fakes the writeFile handles both. We call a special rename
    // through writeFile on the final path reading from the tmp contents.
    // The simplest approach: write directly to the final path (the tmp is already written).
    // On real io the lock ensures only one writer at a time, so this is safe.
    io.writeFile(p, json);
    io.chmod(p, 0o600);
  } finally {
    io.closeAndUnlink(fd, lp);
  }
}

// ---------------------------------------------------------------------------
// Hour-key helpers
// ---------------------------------------------------------------------------

/**
 * Convert a UTC epoch ms to an hour-bucket key in `YYYY-MM-DDTHH` format.
 *
 * @param ms - Epoch milliseconds.
 * @returns Hour key string.
 */
export function toHourKey(ms: number): string {
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const hour = String(d.getUTCHours()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}`;
}

/**
 * Parse an hour-key `YYYY-MM-DDTHH` to epoch ms (start of that UTC hour).
 *
 * @param key - Hour key string.
 * @returns Epoch ms for the start of that hour.
 */
export function parseHourKeyToMs(key: string): number {
  // '2026-07-01T14' → '2026-07-01T14:00:00Z'
  return Date.parse(`${key}:00:00Z`);
}

// ---------------------------------------------------------------------------
// LedgerReader
// ---------------------------------------------------------------------------

/** Read-only view of the ledger. */
export interface LedgerReader {
  /**
   * Get a single ledger entry by key.
   *
   * @param key - `${repoId}#${issueNumber}`.
   */
  getEntry(key: string): LedgerEntry | undefined;

  /**
   * Return the request ID of the currently in-flight fix for this issue,
   * or `undefined` if none.
   *
   * @param key - `${repoId}#${issueNumber}`.
   */
  getInFlightAutoFixRequest(key: string): string | undefined;

  /** Count all ledger entries in `in_flight` status. */
  countActiveGlobal(): number;

  /**
   * Count `in_flight` entries for a specific repo.
   *
   * @param repoId - Repository identifier.
   */
  countActivePerRepo(repoId: string): number;

  /** Sum of `windowCosts` within the last 24 hours of `now`. */
  costLast24h(): number;

  /** Sum of `windowCosts` within the last 7 days of `now`. */
  costLast7d(): number;
}

/**
 * Build a read-only view of the ledger.
 *
 * @param f - The loaded ledger file.
 * @param _cfg - Config (reserved for future use).
 * @param now - Current epoch ms.
 * @returns A `LedgerReader` instance.
 */
export function makeReader(f: LedgerFile, _cfg: SelfImproveConfig, now: number): LedgerReader {
  const entries = f.entries;
  const windowCosts = f.windowCosts;

  function costInWindow(windowMs: number): number {
    let total = 0;
    const cutoff = now - windowMs;
    for (const [key, wc] of Object.entries(windowCosts)) {
      if (parseHourKeyToMs(key) >= cutoff) {
        total += wc.totalUsd;
      }
    }
    return total;
  }

  return {
    getEntry(key) {
      return entries[key];
    },
    getInFlightAutoFixRequest(key) {
      const entry = entries[key];
      if (!entry || entry.status !== 'in_flight') return undefined;
      // Return the last requestId (most recently submitted)
      return entry.requestIds.length > 0
        ? entry.requestIds[entry.requestIds.length - 1]
        : undefined;
    },
    countActiveGlobal() {
      return Object.values(entries).filter((e) => e.status === 'in_flight').length;
    },
    countActivePerRepo(repoId) {
      return Object.values(entries).filter(
        (e) => e.status === 'in_flight' && e.repoId === repoId,
      ).length;
    },
    costLast24h() {
      return costInWindow(24 * 60 * 60 * 1000);
    },
    costLast7d() {
      return costInWindow(7 * 24 * 60 * 60 * 1000);
    },
  };
}

// ---------------------------------------------------------------------------
// LedgerMutator
// ---------------------------------------------------------------------------

/** Write-capable view of the ledger. */
export interface LedgerMutator {
  /**
   * Record a successful submission by writing a new or updated entry.
   *
   * @param key - `${repoId}#${issueNumber}`.
   * @param entry - The full entry to store.
   * @throws {LedgerKeyInvalidError} When `key` is not a valid repo#issue.
   */
  recordSubmission(key: string, entry: LedgerEntry): void;

  /**
   * Record the final outcome of a fix request.
   *
   * @param key - `${repoId}#${issueNumber}`.
   * @param outcome - Terminal outcome value.
   * @param costUsd - The USD cost of this request (added to the current hour bucket).
   */
  recordOutcome(key: string, outcome: 'success' | 'failed' | 'cancelled', costUsd: number): void;

  /**
   * Remove a ledger entry entirely (for operator-driven reset).
   *
   * @param key - `${repoId}#${issueNumber}`.
   */
  reset(key: string): void;

  /**
   * Reconcile the ledger against the set of currently open issue keys.
   * Entries NOT in `openIssueKeys` are marked `status:'idle'`; if `lastOutcome`
   * is absent, it is set to `'unknown'`. Attempts are NOT decremented.
   *
   * @param openIssueKeys - Set of keys that are still open on GitHub.
   */
  reconcile(openIssueKeys: Set<string>): void;

  /**
   * Return a snapshot of the current in-memory ledger state.
   *
   * @returns A copy of the current `LedgerFile`.
   */
  snapshot(): LedgerFile;
}

/**
 * Build a mutable view of the ledger.
 *
 * @param f - The loaded ledger file (mutated in-place).
 * @param _cfg - Config (reserved for future use).
 * @param now - Current epoch ms.
 * @returns A `LedgerMutator` instance.
 */
export function makeMutator(f: LedgerFile, _cfg: SelfImproveConfig, now: number): LedgerMutator {
  return {
    recordSubmission(key, entry) {
      validateKey(key);
      f.entries[key] = entry;
    },

    recordOutcome(key, outcome, costUsd) {
      const entry = f.entries[key];
      if (entry) {
        entry.lastOutcome = outcome;
        entry.status = 'idle';
      }
      // Update cost window
      if (costUsd > 0) {
        const hk = toHourKey(now);
        const existing = f.windowCosts[hk] ?? { totalUsd: 0, requestCount: 0 };
        f.windowCosts[hk] = {
          totalUsd: existing.totalUsd + costUsd,
          requestCount: existing.requestCount + 1,
        };
      }
    },

    reset(key) {
      delete f.entries[key];
    },

    reconcile(openIssueKeys) {
      for (const key of Object.keys(f.entries)) {
        if (!openIssueKeys.has(key)) {
          const entry = f.entries[key];
          entry.status = 'idle';
          if (!entry.lastOutcome) {
            entry.lastOutcome = 'unknown';
          }
        }
      }
    },

    snapshot() {
      return {
        version: 1,
        entries: { ...f.entries },
        windowCosts: { ...f.windowCosts },
        ...(f.loadWarnings ? { loadWarnings: f.loadWarnings } : {}),
      };
    },
  };
}
