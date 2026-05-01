/**
 * FileLock advisory mutex tests (SPEC-012-1-01 §Task 3).
 *
 * @module __tests__/core/file_lock.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { FileLock } from '../../core/file_lock';
import { LockTimeoutError } from '../../core/types';

function mkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-lock-'));
}

function rmdir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

describe('FileLock', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdir();
  });

  afterEach(() => {
    rmdir(dir);
  });

  test('acquire + release succeeds on a fresh dir', async () => {
    const lock = await FileLock.acquire(dir, 1000);
    await lock.release();
    expect(fs.existsSync(path.join(dir, '.lock'))).toBe(false);
  });

  test('release is idempotent', async () => {
    const lock = await FileLock.acquire(dir, 1000);
    await lock.release();
    await lock.release(); // must not throw
  });

  test('second acquire on same dir blocks until first releases', async () => {
    const first = await FileLock.acquire(dir, 1000);

    let secondAcquired = false;
    const secondPromise = FileLock.acquire(dir, 5000).then((l) => {
      secondAcquired = true;
      return l;
    });

    // Allow scheduler to attempt the second acquire and back off.
    await new Promise((r) => setTimeout(r, 50));
    expect(secondAcquired).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
  });

  test('acquire on different dirs runs concurrently', async () => {
    const dirB = mkdir();
    try {
      const start = Date.now();
      const [a, b] = await Promise.all([
        FileLock.acquire(dir, 1000),
        FileLock.acquire(dirB, 1000),
      ]);
      const elapsed = Date.now() - start;
      // Both should complete in under 100ms (parallel) — generous bound for CI.
      expect(elapsed).toBeLessThan(500);
      await a.release();
      await b.release();
    } finally {
      rmdir(dirB);
    }
  });

  test('throws LockTimeoutError when contended past timeout', async () => {
    const first = await FileLock.acquire(dir, 1000);
    try {
      await expect(FileLock.acquire(dir, 100)).rejects.toThrow(LockTimeoutError);
    } finally {
      await first.release();
    }
  });

  test('clears stale lock from dead PID', async () => {
    // Manually create a lock file with a non-existent PID.
    fs.writeFileSync(
      path.join(dir, '.lock'),
      JSON.stringify({ pid: 999999, acquired_at: new Date().toISOString() }),
    );
    // Acquire should detect ESRCH and clear the stale lock.
    const lock = await FileLock.acquire(dir, 2000);
    await lock.release();
  });

  test('preserves lock file holder PID', async () => {
    const lock = await FileLock.acquire(dir, 1000);
    const raw = fs.readFileSync(path.join(dir, '.lock'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.pid).toBe(process.pid);
    await lock.release();
  });
});
