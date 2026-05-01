/**
 * Per-request advisory file locking (SPEC-012-1-01 §Task 3).
 *
 * Implementation choice (per runbook "File-locking note"): we use a
 * `O_CREAT | O_EXCL`-based lock-file mutex rather than `flock(2)` because
 * neither `proper-lockfile` nor `fs-ext` are installed and Node's built-in
 * `node:fs` does not expose `flock`/`O_EXLOCK`. Properties of this
 * implementation:
 *
 *   - Mutual exclusion within and across processes (kernel guarantee on
 *     `O_EXCL`).
 *   - Crash-safe via PID + `lock_recovery_timeout_ms`: a stale lock from a
 *     dead PID, or older than the recovery timeout, is forcibly cleared on
 *     the next acquire attempt.
 *   - Backoff: 10ms, 20ms, 40ms, 80ms, 160ms, 320ms, capped at 500ms.
 *   - Cross-platform: macOS, Linux, WSL2. (Windows behaviour of `O_EXCL`
 *     differs and is out of scope per spec.)
 *
 * Limitations vs. true `flock`:
 *   - We rely on the lock-holder's cleanup; `flock` would auto-release on
 *     FD close. We compensate with the stale-PID check above, which makes
 *     the system self-healing under crashes.
 *
 * @module core/file_lock
 */

import * as fs from 'fs';
import * as path from 'path';

import { LockTimeoutError } from './types';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Lock-file basename. Lives directly inside the request dir. */
const LOCK_BASENAME = '.lock';
/** Initial backoff between retries; doubles per attempt to a cap. */
const BACKOFF_INITIAL_MS = 10;
const BACKOFF_CAP_MS = 500;
/**
 * If a lock file is older than this, treat it as stale and forcibly clear
 * (the holder almost certainly crashed). 5 minutes is generous compared to
 * the 10s default `lockTimeoutMs`.
 */
const LOCK_RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// FileLock
// ---------------------------------------------------------------------------

/**
 * Per-directory advisory mutex. Only one holder at a time may possess the
 * lock for a given `dir`.
 *
 * Usage:
 * ```ts
 * const lock = await FileLock.acquire('/path/to/dir', 10_000);
 * try {
 *   // critical section
 * } finally {
 *   await lock.release();
 * }
 * ```
 *
 * The lock file contains the holder's PID + acquire timestamp (JSON), used
 * by stale-lock recovery. Operators inspecting the file see useful context.
 */
export class FileLock {
  private readonly lockPath: string;
  private released = false;

  private constructor(lockPath: string) {
    this.lockPath = lockPath;
  }

  /**
   * Acquire the lock on `dir`. Retries with exponential backoff (10→500ms)
   * up to `timeoutMs`. Throws {@link LockTimeoutError} on timeout.
   *
   * Stale-lock recovery: if an existing lock file is older than
   * `LOCK_RECOVERY_TIMEOUT_MS`, OR its recorded PID is no longer alive,
   * we clear it before retrying. This keeps the system self-healing across
   * crashes without relying on OS-level flock auto-release.
   *
   * The directory MUST exist before calling acquire. The caller's
   * responsibility (handoff_manager creates the request dir first).
   */
  static async acquire(dir: string, timeoutMs: number): Promise<FileLock> {
    const lockPath = path.join(dir, LOCK_BASENAME);
    const deadline = Date.now() + timeoutMs;
    let backoff = BACKOFF_INITIAL_MS;
    let attempts = 0;

    /* eslint-disable no-constant-condition */
    while (true) {
      attempts += 1;
      try {
        // O_CREAT | O_EXCL: atomic create-or-fail. If the file already
        // exists, we get EEXIST and fall through to the recovery branch.
        const fd = fs.openSync(
          lockPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
          0o600,
        );
        try {
          // Record holder context for forensics + stale-lock recovery.
          const payload = JSON.stringify({
            pid: process.pid,
            acquired_at: new Date().toISOString(),
          });
          fs.writeSync(fd, payload);
        } finally {
          fs.closeSync(fd);
        }
        return new FileLock(lockPath);
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'EEXIST') {
          // Unexpected error (EACCES, ENOENT on parent, etc) — propagate.
          throw err;
        }
        // EEXIST: someone holds the lock. Try stale-lock recovery first.
        if (FileLock.isStale(lockPath)) {
          // Best-effort unlink; ignore errors (race with the holder
          // releasing concurrently is benign — we'll retry below).
          try {
            fs.unlinkSync(lockPath);
          } catch {
            // ignore
          }
          // Loop without backoff so the retry happens immediately after
          // clearing — minimizes contention.
          continue;
        }
      }

      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `failed to acquire lock after ${attempts} attempts (${timeoutMs}ms timeout)`,
        );
      }

      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    }
    /* eslint-enable no-constant-condition */
  }

  /**
   * Release the lock. Idempotent: a second call is a no-op. Safe to call
   * from `finally` even if a prior `release` already ran (e.g., timeout
   * cleanup path).
   */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      fs.unlinkSync(this.lockPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'ENOENT') {
        // The file was unexpectedly removed by something else (operator
        // intervention, test cleanup). Not fatal — the lock IS released
        // either way; we just log nothing here to avoid noise.
      }
    }
  }

  // -----------------------------------------------------------------------
  // Stale-lock detection
  // -----------------------------------------------------------------------

  /**
   * A lock file is stale if (a) its mtime is older than
   * `LOCK_RECOVERY_TIMEOUT_MS`, OR (b) its recorded PID does not
   * correspond to a live process. Either condition indicates the holder
   * crashed without releasing.
   */
  private static isStale(lockPath: string): boolean {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(lockPath);
    } catch {
      // Already gone — call site will retry the create immediately.
      return false;
    }

    if (Date.now() - stat.mtimeMs > LOCK_RECOVERY_TIMEOUT_MS) return true;

    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, 'utf-8');
    } catch {
      // Race: holder is mid-write. Don't treat as stale yet.
      return false;
    }

    let parsed: { pid?: number };
    try {
      parsed = JSON.parse(raw) as { pid?: number };
    } catch {
      // Truncated / partial write. Wait one more cycle before reaping.
      return false;
    }

    const pid = parsed.pid;
    if (typeof pid !== 'number' || pid <= 0) return false;
    if (pid === process.pid) {
      // It's us (test re-entry, or genuine reentrancy bug). Not stale —
      // surface as lock contention so the caller can timeout cleanly.
      return false;
    }
    try {
      process.kill(pid, 0);
      // Process exists; not stale.
      return false;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      // ESRCH = no such process → stale.
      if (code === 'ESRCH') return true;
      // EPERM = process exists but we can't signal it. Not stale.
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
