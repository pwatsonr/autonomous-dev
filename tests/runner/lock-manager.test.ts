import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { LockManager, type LockFileContent } from '../../src/runner/lock-manager';

describe('LockManager', () => {
  let tmpDir: string;
  let lockDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-test-'));
    lockDir = path.join(tmpDir, '.autonomous-dev/observations');
    await fs.mkdir(lockDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: read lock file content. */
  async function readLock(serviceName: string): Promise<LockFileContent | null> {
    const lockFile = path.join(lockDir, `.lock-${serviceName}`);
    try {
      const raw = await fs.readFile(lockFile, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  /** Helper: check if lock file exists. */
  async function lockFileExists(serviceName: string): Promise<boolean> {
    try {
      await fs.access(path.join(lockDir, `.lock-${serviceName}`));
      return true;
    } catch {
      return false;
    }
  }

  /** Helper: write a lock file directly. */
  async function writeLockDirect(
    serviceName: string,
    content: LockFileContent,
  ): Promise<void> {
    const lockFile = path.join(lockDir, `.lock-${serviceName}`);
    await fs.writeFile(lockFile, JSON.stringify(content), 'utf-8');
  }

  // --- TC-1-4-05: Lock acquisition ---
  describe('TC-1-4-05: lock acquisition', () => {
    it('creates a lock file with PID and timestamp when no lock exists', async () => {
      const manager = new LockManager(lockDir);
      const result = await manager.acquire('api-gateway');

      expect(result).toBe(true);

      const content = await readLock('api-gateway');
      expect(content).not.toBeNull();
      expect(content!.pid).toBe(process.pid);
      expect(content!.service).toBe('api-gateway');
      expect(new Date(content!.acquired_at).getTime()).not.toBeNaN();
    });

    it('writes lock file to .lock-<service-name> path', async () => {
      const manager = new LockManager(lockDir);
      await manager.acquire('my-service');

      const exists = await lockFileExists('my-service');
      expect(exists).toBe(true);
    });
  });

  // --- TC-1-4-06: Lock conflict wait ---
  describe('TC-1-4-06: lock conflict wait', () => {
    it('waits with backoff and acquires after lock is released', async () => {
      const delayLog: number[] = [];

      // Simulate a lock that is released after the 2nd delay call
      let delayCallCount = 0;
      const serviceName = 'conflict-service';

      // Write a fresh lock from "another process"
      await writeLockDirect(serviceName, {
        pid: process.pid + 1,
        acquired_at: new Date().toISOString(),
        service: serviceName,
      });

      const manager = new LockManager(lockDir, {
        initialBackoffMs: 50,
        maxBackoffMs: 200,
        waitTimeoutMs: 5000,
        delayFn: async (ms: number) => {
          delayLog.push(ms);
          delayCallCount++;
          // Release the lock on the 2nd backoff iteration
          if (delayCallCount >= 2) {
            await fs.unlink(path.join(lockDir, `.lock-${serviceName}`)).catch(() => {});
          }
        },
      });

      const result = await manager.acquire(serviceName);
      expect(result).toBe(true);
      // Should have waited at least twice
      expect(delayLog.length).toBeGreaterThanOrEqual(2);
      // Exponential backoff: first delay < second delay
      expect(delayLog[1]).toBeGreaterThanOrEqual(delayLog[0]);
    });
  });

  // --- TC-1-4-07: Lock conflict timeout ---
  describe('TC-1-4-07: lock conflict timeout', () => {
    it('returns false when lock is held for longer than wait timeout', async () => {
      const serviceName = 'timeout-service';

      // Write a fresh lock
      await writeLockDirect(serviceName, {
        pid: process.pid + 1,
        acquired_at: new Date().toISOString(),
        service: serviceName,
      });

      // Simulate time passing past the wait timeout
      let currentTime = Date.now();
      const manager = new LockManager(lockDir, {
        waitTimeoutMs: 100,
        initialBackoffMs: 10,
        maxBackoffMs: 50,
        staleThresholdMs: 60 * 60 * 1000, // 1 hour -- won't trigger
        now: () => {
          const d = new Date(currentTime);
          currentTime += 60; // advance 60ms each call
          return d;
        },
        delayFn: async () => {
          // no-op (don't actually wait)
        },
      });

      const result = await manager.acquire(serviceName);
      expect(result).toBe(false);
    });
  });

  // --- TC-1-4-08: Stale lock cleanup ---
  describe('TC-1-4-08: stale lock cleanup', () => {
    it('cleans stale lock and acquires when lock is >60 minutes old', async () => {
      const serviceName = 'stale-service';
      const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000);

      await writeLockDirect(serviceName, {
        pid: 99999,
        acquired_at: ninetyMinutesAgo.toISOString(),
        service: serviceName,
      });

      const manager = new LockManager(lockDir);
      const result = await manager.acquire(serviceName);

      expect(result).toBe(true);

      // Old lock should have been replaced with our PID
      const content = await readLock(serviceName);
      expect(content!.pid).toBe(process.pid);
    });
  });

  // --- TC-1-4-15: Lock release on error ---
  describe('TC-1-4-15: lock release', () => {
    it('releases a lock by removing the lock file', async () => {
      const manager = new LockManager(lockDir);
      await manager.acquire('release-test');

      expect(await lockFileExists('release-test')).toBe(true);

      await manager.release('release-test');

      expect(await lockFileExists('release-test')).toBe(false);
    });

    it('does not throw when releasing a non-existent lock', async () => {
      const manager = new LockManager(lockDir);
      await expect(manager.release('nonexistent')).resolves.toBeUndefined();
    });
  });

  // --- cleanStaleLocks ---
  describe('cleanStaleLocks', () => {
    it('removes all stale locks and returns cleaned service names', async () => {
      const ninetyMinutesAgo = new Date(Date.now() - 90 * 60 * 1000);

      await writeLockDirect('stale-a', {
        pid: 1111,
        acquired_at: ninetyMinutesAgo.toISOString(),
        service: 'stale-a',
      });
      await writeLockDirect('stale-b', {
        pid: 2222,
        acquired_at: ninetyMinutesAgo.toISOString(),
        service: 'stale-b',
      });
      // Fresh lock -- should NOT be cleaned
      await writeLockDirect('fresh', {
        pid: 3333,
        acquired_at: new Date().toISOString(),
        service: 'fresh',
      });

      const manager = new LockManager(lockDir);
      const cleaned = await manager.cleanStaleLocks();

      expect(cleaned.sort()).toEqual(['stale-a', 'stale-b']);
      expect(await lockFileExists('stale-a')).toBe(false);
      expect(await lockFileExists('stale-b')).toBe(false);
      expect(await lockFileExists('fresh')).toBe(true);
    });

    it('returns empty array when no lock files exist', async () => {
      const manager = new LockManager(lockDir);
      const cleaned = await manager.cleanStaleLocks();
      expect(cleaned).toEqual([]);
    });
  });

  // --- getLockFilePath ---
  describe('getLockFilePath', () => {
    it('returns correct path for a service name', () => {
      const manager = new LockManager('/some/dir');
      expect(manager.getLockFilePath('my-svc')).toBe('/some/dir/.lock-my-svc');
    });
  });
});
