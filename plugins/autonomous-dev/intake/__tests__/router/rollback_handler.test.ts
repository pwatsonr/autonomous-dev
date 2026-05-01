/**
 * Rollback handler idempotency + sanitization tests (SPEC-012-1-02).
 *
 * @module __tests__/router/rollback_handler.test
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  rollbackF1,
  rollbackF2,
  rollbackF3,
} from '../../router/rollback_handler';

function mkfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomous-dev-rollback-'));
  const p = path.join(dir, 'state.json.tmp.123.deadbeef00000000');
  fs.writeFileSync(p, '{"x":1}');
  return p;
}

describe('rollbackF1', () => {
  test('is a no-op (just logs)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await rollbackF1({ requestId: 'REQ-000001' });
      await rollbackF1({ requestId: 'REQ-000001' }); // idempotent
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('rollbackF2', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test('unlinks an existing temp file', async () => {
    const p = mkfile();
    expect(fs.existsSync(p)).toBe(true);
    await rollbackF2({ requestId: 'REQ-000001', tmpPath: p });
    expect(fs.existsSync(p)).toBe(false);
  });

  test('is idempotent (second call on missing file succeeds)', async () => {
    const p = mkfile();
    await rollbackF2({ requestId: 'REQ-000001', tmpPath: p });
    await rollbackF2({ requestId: 'REQ-000001', tmpPath: p }); // ENOENT-tolerant
    expect(fs.existsSync(p)).toBe(false);
  });

  test('handles missing tmpPath gracefully', async () => {
    await rollbackF2({ requestId: 'REQ-000001' });
    expect(warn).toHaveBeenCalled();
  });

  test('discord-source error is path-sanitized in log', async () => {
    await rollbackF2({
      requestId: 'REQ-000001',
      source: 'discord',
      error: new Error('disk full at /var/lib/autonomous-dev/state.json'),
    });
    const lastCall = warn.mock.calls[0][0] as string;
    expect(lastCall).not.toMatch(/\/var\/lib\/autonomous-dev/);
    expect(lastCall).toContain('<path>');
  });
});

describe('rollbackF3', () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  test('rolls back the txn AND unlinks the temp', async () => {
    const p = mkfile();
    let rollbackCalled = false;
    const fakeDb = {
      exec(stmt: string): void {
        if (/ROLLBACK/i.test(stmt)) rollbackCalled = true;
      },
    };
    await rollbackF3({ requestId: 'REQ-000001', tmpPath: p, db: fakeDb });
    expect(rollbackCalled).toBe(true);
    expect(fs.existsSync(p)).toBe(false);
  });

  test('treats "no transaction" as success', async () => {
    const p = mkfile();
    const fakeDb = {
      exec(): void {
        throw new Error('cannot rollback - no transaction is active');
      },
    };
    await rollbackF3({ requestId: 'REQ-000001', tmpPath: p, db: fakeDb });
    expect(fs.existsSync(p)).toBe(false);
  });

  test('still unlinks temp even if DB rollback throws unrecoverably', async () => {
    const p = mkfile();
    const fakeDb = {
      exec(): void {
        throw new Error('fatal SQLite error');
      },
    };
    await rollbackF3({ requestId: 'REQ-000001', tmpPath: p, db: fakeDb });
    expect(fs.existsSync(p)).toBe(false);
  });

  test('is idempotent', async () => {
    const p = mkfile();
    const fakeDb = { exec(): void {} };
    await rollbackF3({ requestId: 'REQ-000001', tmpPath: p, db: fakeDb });
    await rollbackF3({ requestId: 'REQ-000001', tmpPath: p, db: fakeDb });
    expect(fs.existsSync(p)).toBe(false);
  });
});
