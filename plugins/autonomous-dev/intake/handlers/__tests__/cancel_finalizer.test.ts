/**
 * Unit tests for cancel_finalizer.ts (REQ-000059).
 *
 * Covers T-U-01 through T-U-11 from the spec §5.1.
 *
 * @module handlers/__tests__/cancel_finalizer.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  CANCELLED_TOMBSTONE_BASENAME,
  finalizeCancellation,
  isCancelledTombstonePresent,
  writeCancelledTombstone,
} from '../cancel_finalizer';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cancel-finalizer-test-')));
}

// ---------------------------------------------------------------------------
// T-U-01: Happy path creates tombstone
// ---------------------------------------------------------------------------

describe('finalizeCancellation', () => {
  test('T-U-01: happy path creates tombstone with correct permissions and size', async () => {
    const dir = tmpDir();
    const gateDir = tmpDir();
    try {
      const result = await finalizeCancellation({
        requestPath: dir,
        repoBasename: 'myrepo',
        requestId: 'REQ-000001',
        gateDecisionsDir: gateDir,
      });

      expect(result.tombstoneWritten).toBe(true);
      expect(result.gateDecisionDeleted).toBe(true);
      expect(result.warnings).toEqual([]);

      const tombstonePath = path.join(dir, CANCELLED_TOMBSTONE_BASENAME);
      expect(fs.existsSync(tombstonePath)).toBe(true);

      const stat = fs.statSync(tombstonePath);
      expect(stat.size).toBe(0);
      // Check mode (skip on platforms that don't support mode bits reliably)
      if (process.platform !== 'win32') {
        expect(stat.mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(gateDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // T-U-02: Idempotent second call
  // -------------------------------------------------------------------------
  test('T-U-02: idempotent second call leaves tombstone present and no warnings', async () => {
    const dir = tmpDir();
    const gateDir = tmpDir();
    try {
      await finalizeCancellation({
        requestPath: dir,
        repoBasename: 'myrepo',
        requestId: 'REQ-000001',
        gateDecisionsDir: gateDir,
      });

      const result = await finalizeCancellation({
        requestPath: dir,
        repoBasename: 'myrepo',
        requestId: 'REQ-000001',
        gateDecisionsDir: gateDir,
      });

      expect(result.tombstoneWritten).toBe(true);
      expect(result.gateDecisionDeleted).toBe(true);
      expect(result.warnings).toEqual([]);

      const tombstonePath = path.join(dir, CANCELLED_TOMBSTONE_BASENAME);
      expect(fs.existsSync(tombstonePath)).toBe(true);
      expect(fs.statSync(tombstonePath).size).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(gateDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // T-U-03: EACCES on tombstone create surfaces as warning
  // -------------------------------------------------------------------------
  test('T-U-03: read-only directory causes tombstoneWritten=false and warning', async () => {
    // Skip under root (uid 0 ignores mode bits on most filesystems).
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      return;
    }
    // Skip on Windows.
    if (process.platform === 'win32') {
      return;
    }

    const dir = tmpDir();
    const gateDir = tmpDir();
    try {
      fs.chmodSync(dir, 0o500); // read+exec only, no write

      const result = await finalizeCancellation({
        requestPath: dir,
        repoBasename: 'myrepo',
        requestId: 'REQ-000001',
        gateDecisionsDir: gateDir,
      });

      expect(result.tombstoneWritten).toBe(false);
      expect(result.warnings.length).toBeGreaterThanOrEqual(1);
      expect(result.warnings[0]).toMatch(/tombstone write failed/);

      // The function must not throw
      const tombstonePath = path.join(dir, CANCELLED_TOMBSTONE_BASENAME);
      expect(fs.existsSync(tombstonePath)).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o700); // restore writable so rmSync works
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(gateDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // T-U-04: Deletes pre-existing gate-decision file
  // -------------------------------------------------------------------------
  test('T-U-04: deletes pre-existing gate-decision file', async () => {
    const dir = tmpDir();
    const gateDir = tmpDir();
    const gateFile = path.join(gateDir, 'myrepo__REQ-000001.json');
    try {
      fs.writeFileSync(gateFile, '{}');
      expect(fs.existsSync(gateFile)).toBe(true);

      const result = await finalizeCancellation({
        requestPath: dir,
        repoBasename: 'myrepo',
        requestId: 'REQ-000001',
        gateDecisionsDir: gateDir,
      });

      expect(result.gateDecisionDeleted).toBe(true);
      expect(result.warnings).toEqual([]);
      expect(fs.existsSync(gateFile)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(gateDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // T-U-05: ENOENT gate-decision is a no-op success
  // -------------------------------------------------------------------------
  test('T-U-05: absent gate-decision file → gateDecisionDeleted=true and no warnings', async () => {
    const dir = tmpDir();
    const gateDir = tmpDir();
    try {
      // Do NOT create the gate file.
      const result = await finalizeCancellation({
        requestPath: dir,
        repoBasename: 'myrepo',
        requestId: 'REQ-000001',
        gateDecisionsDir: gateDir,
      });

      expect(result.gateDecisionDeleted).toBe(true);
      expect(result.warnings).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(gateDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // T-U-10: Default gateDecisionsDir resolution (no override)
  // -------------------------------------------------------------------------
  test('T-U-10: AUTONOMOUS_DEV_STATE_DIR env override controls default gate dir', async () => {
    const dir = tmpDir();
    const stateDir = tmpDir();
    const gateDir = path.join(stateDir, 'gate-decisions');
    fs.mkdirSync(gateDir, { recursive: true });
    const gateFile = path.join(gateDir, 'myrepo__REQ-000001.json');
    const prev = process.env.AUTONOMOUS_DEV_STATE_DIR;
    try {
      fs.writeFileSync(gateFile, '{}');
      process.env.AUTONOMOUS_DEV_STATE_DIR = stateDir;

      const result = await finalizeCancellation({
        requestPath: dir,
        repoBasename: 'myrepo',
        requestId: 'REQ-000001',
        // no gateDecisionsDir override — should use AUTONOMOUS_DEV_STATE_DIR
      });

      expect(result.gateDecisionDeleted).toBe(true);
      expect(fs.existsSync(gateFile)).toBe(false);
    } finally {
      if (prev === undefined) {
        delete process.env.AUTONOMOUS_DEV_STATE_DIR;
      } else {
        process.env.AUTONOMOUS_DEV_STATE_DIR = prev;
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// isCancelledTombstonePresent
// ---------------------------------------------------------------------------

describe('isCancelledTombstonePresent', () => {
  test('T-U-06: returns false for non-existent path', () => {
    expect(isCancelledTombstonePresent('/nonexistent/path/that/does/not/exist')).toBe(false);
  });

  test('T-U-07: returns true when tombstone file exists', () => {
    const dir = tmpDir();
    try {
      fs.writeFileSync(path.join(dir, CANCELLED_TOMBSTONE_BASENAME), '');
      expect(isCancelledTombstonePresent(dir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T-U-08: returns false when tombstone path is a directory (not a regular file)', () => {
    const dir = tmpDir();
    try {
      fs.mkdirSync(path.join(dir, CANCELLED_TOMBSTONE_BASENAME));
      expect(isCancelledTombstonePresent(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('does not throw when stat encounters any error', () => {
    // Should never throw — even for weird paths.
    expect(() => isCancelledTombstonePresent('\0invalid')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// writeCancelledTombstone
// ---------------------------------------------------------------------------

describe('writeCancelledTombstone', () => {
  test('creates tombstone and returns true', () => {
    const dir = tmpDir();
    try {
      const warnings: string[] = [];
      const result = writeCancelledTombstone(dir, warnings);
      expect(result).toBe(true);
      expect(warnings).toEqual([]);
      expect(fs.existsSync(path.join(dir, CANCELLED_TOMBSTONE_BASENAME))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('idempotent (EEXIST → success, no warning)', () => {
    const dir = tmpDir();
    try {
      writeCancelledTombstone(dir);
      const warnings: string[] = [];
      const result = writeCancelledTombstone(dir, warnings);
      expect(result).toBe(true);
      expect(warnings).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('T-U-09: returns false and accumulates warning on failure', () => {
    // Pass a path whose parent does not exist.
    const nonExistentParent = path.join(os.tmpdir(), `cancel-finalizer-nonexistent-${Date.now()}`);
    const warnings: string[] = [];
    const result = writeCancelledTombstone(nonExistentParent, warnings);
    expect(result).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  test('works without warnings array (no crash)', () => {
    const dir = tmpDir();
    try {
      // No warnings argument — should not throw.
      expect(() => writeCancelledTombstone(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
