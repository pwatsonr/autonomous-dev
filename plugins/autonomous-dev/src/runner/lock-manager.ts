/**
 * Per-service lock file creation, checking, and stale lock cleanup
 * (SPEC-007-1-4, Task 9).
 *
 * Lock files are advisory -- they prevent concurrent observation runs
 * from processing the same service simultaneously.
 *
 * Lock file location: .autonomous-dev/observations/.lock-<service-name>
 * Lock file content: JSON with pid, acquired_at, and service fields.
 *
 * Stale lock threshold: 60 minutes.
 * Wait timeout: 5 minutes with exponential backoff.
 */

import * as fs from 'fs/promises';
import * as path from 'path';

export interface LockFileContent {
  pid: number;
  acquired_at: string; // ISO 8601
  service: string;
}

/** Configuration for the lock manager. */
export interface LockManagerOptions {
  /** Stale lock threshold in milliseconds (default: 60 * 60 * 1000 = 1 hour). */
  staleThresholdMs?: number;
  /** Maximum wait time in milliseconds when a lock is held (default: 5 * 60 * 1000 = 5 min). */
  waitTimeoutMs?: number;
  /** Initial backoff delay in milliseconds (default: 1000). */
  initialBackoffMs?: number;
  /** Maximum backoff delay in milliseconds (default: 30_000). */
  maxBackoffMs?: number;
  /** Function to get current time -- injectable for testing. */
  now?: () => Date;
  /** Delay function -- injectable for testing. */
  delayFn?: (ms: number) => Promise<void>;
}

const DEFAULT_STALE_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_INITIAL_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

export class LockManager {
  private readonly lockDir: string;
  private readonly staleThresholdMs: number;
  private readonly waitTimeoutMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly now: () => Date;
  private readonly delayFn: (ms: number) => Promise<void>;

  /**
   * @param lockDir The directory where lock files are stored
   *                (typically .autonomous-dev/observations/)
   * @param options Optional configuration overrides
   */
  constructor(lockDir: string, options: LockManagerOptions = {}) {
    this.lockDir = lockDir;
    this.staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    this.initialBackoffMs = options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.now = options.now ?? (() => new Date());
    this.delayFn = options.delayFn ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Returns the lock file path for a given service.
   */
  getLockFilePath(serviceName: string): string {
    return path.join(this.lockDir, `.lock-${serviceName}`);
  }

  /**
   * Checks whether a lock file exists at the given path.
   */
  async lockExists(lockFile: string): Promise<boolean> {
    try {
      await fs.access(lockFile);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Reads and parses a lock file's content.
   * Returns null if the file cannot be read or parsed.
   */
  async readLockFile(lockFile: string): Promise<LockFileContent | null> {
    try {
      const raw = await fs.readFile(lockFile, 'utf-8');
      return JSON.parse(raw) as LockFileContent;
    } catch {
      return null;
    }
  }

  /**
   * Determines whether a lock file is stale (older than staleThresholdMs).
   */
  async isStale(lockFile: string): Promise<boolean> {
    const content = await this.readLockFile(lockFile);
    if (!content) return true; // Unreadable lock is treated as stale

    const acquiredAt = new Date(content.acquired_at).getTime();
    const currentTime = this.now().getTime();
    return currentTime - acquiredAt > this.staleThresholdMs;
  }

  /**
   * Removes a stale lock file.
   */
  async cleanStaleLock(lockFile: string): Promise<void> {
    await fs.unlink(lockFile).catch(() => {});
  }

  /**
   * Waits for a lock to be released using exponential backoff.
   *
   * @param lockFile Path to the lock file
   * @returns true if the lock was released within the timeout, false otherwise
   */
  async waitForLock(lockFile: string): Promise<boolean> {
    const startTime = this.now().getTime();
    let backoff = this.initialBackoffMs;

    while (this.now().getTime() - startTime < this.waitTimeoutMs) {
      await this.delayFn(backoff);

      if (!(await this.lockExists(lockFile))) {
        return true;
      }

      // Check if it became stale while waiting
      if (await this.isStale(lockFile)) {
        await this.cleanStaleLock(lockFile);
        return true;
      }

      backoff = Math.min(backoff * 2, this.maxBackoffMs);
    }

    return false;
  }

  /**
   * Acquires a lock for the given service.
   *
   * 1. If no lock exists, create one immediately.
   * 2. If a lock exists and is stale (>60 min), clean it and acquire.
   * 3. If a lock exists and is active, wait with exponential backoff (up to 5 min).
   * 4. If the wait times out, return false (service will be skipped).
   *
   * @param serviceName The name of the service to lock
   * @returns true if the lock was acquired, false if acquisition failed
   */
  async acquire(serviceName: string): Promise<boolean> {
    const lockFile = this.getLockFilePath(serviceName);

    await fs.mkdir(this.lockDir, { recursive: true });

    if (await this.lockExists(lockFile)) {
      if (await this.isStale(lockFile)) {
        await this.cleanStaleLock(lockFile);
      } else {
        const acquired = await this.waitForLock(lockFile);
        if (!acquired) return false;
      }
    }

    const lockContent: LockFileContent = {
      pid: process.pid,
      acquired_at: this.now().toISOString(),
      service: serviceName,
    };

    await fs.writeFile(lockFile, JSON.stringify(lockContent, null, 2), 'utf-8');
    return true;
  }

  /**
   * Releases a lock for the given service by removing its lock file.
   * This is safe to call even if the lock file does not exist.
   */
  async release(serviceName: string): Promise<void> {
    const lockFile = this.getLockFilePath(serviceName);
    await fs.unlink(lockFile).catch(() => {});
  }

  /**
   * Scans the lock directory for all stale lock files and removes them.
   *
   * @returns A list of service names whose stale locks were cleaned
   */
  async cleanStaleLocks(): Promise<string[]> {
    const cleaned: string[] = [];

    let entries: string[];
    try {
      entries = await fs.readdir(this.lockDir);
    } catch {
      return cleaned; // Directory doesn't exist yet
    }

    const lockFiles = entries.filter((f) => f.startsWith('.lock-'));

    for (const lockFileName of lockFiles) {
      const lockFile = path.join(this.lockDir, lockFileName);
      if (await this.isStale(lockFile)) {
        const serviceName = lockFileName.replace(/^\.lock-/, '');
        await this.cleanStaleLock(lockFile);
        cleaned.push(serviceName);
      }
    }

    return cleaned;
  }
}
