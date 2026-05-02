/**
 * Unit tests for ChainAuditWriter + chains-audit-key + verify helper
 * (SPEC-022-3-03, Tasks 6-7).
 *
 * Covers the writer invariants from the spec: HMAC chain integrity,
 * concurrency mutex, restart resume, rotation, and key resolution.
 *
 * @module tests/chains/test-chain-audit
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHmac } from 'node:crypto';

import {
  ChainAuditWriter,
  verifyChain,
} from '../../intake/chains/audit-writer';
import {
  getChainsAuditHmacKey,
  resetChainsAuditKeyCacheForTest,
  getChainsAuditKeySourceForTest,
} from '../../intake/chains/chains-audit-key';
import { canonicalJSON } from '../../intake/chains/canonical-json';
import type { ChainAuditEntry } from '../../intake/chains/audit-events';

const KEY = Buffer.alloc(32, 7); // deterministic 32-byte key for tests

async function readEntries(p: string): Promise<ChainAuditEntry[]> {
  const raw = await fs.readFile(p, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as ChainAuditEntry);
}

describe('ChainAuditWriter', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-chain-audit-'));
    logPath = path.join(tmpDir, 'chains-audit.log');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('open() creates a new file with mode 0600', async () => {
    const w = await ChainAuditWriter.open({ logPath, key: KEY });
    try {
      const stat = await fs.stat(logPath);
      // Lower 9 mode bits.
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
      expect(w.getLastHmac()).toBe('');
    } finally {
      await w.close();
    }
  });

  it('append() writes one JSON line per call ending in \\n with all six fields', async () => {
    const w = await ChainAuditWriter.open({ logPath, key: KEY });
    try {
      await w.append('chain_started', 'CH-1', {
        chain_id: 'CH-1',
        chain_name: 'test',
        trigger: 'p1',
        plugins: ['p1', 'p2'],
      });
      await w.append('plugin_invoked', 'CH-1', {
        chain_id: 'CH-1',
        plugin_id: 'p2',
        step: 1,
        consumes: ['type-a'],
      });
    } finally {
      await w.close();
    }
    const raw = await fs.readFile(logPath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      const parsed = JSON.parse(l);
      expect(parsed).toHaveProperty('ts');
      expect(parsed).toHaveProperty('type');
      expect(parsed).toHaveProperty('chain_id');
      expect(parsed).toHaveProperty('payload');
      expect(parsed).toHaveProperty('prev_hmac');
      expect(parsed).toHaveProperty('hmac');
    }
  });

  it('first entry has prev_hmac === "" and the hmac matches canonicalJSON', async () => {
    const w = await ChainAuditWriter.open({
      logPath,
      key: KEY,
      clock: () => '2026-04-29T00:00:00.000Z',
    });
    try {
      await w.append('chain_started', 'CH-1', {
        chain_id: 'CH-1',
        chain_name: 'test',
        trigger: 'p1',
        plugins: ['p1'],
      });
    } finally {
      await w.close();
    }
    const entries = await readEntries(logPath);
    expect(entries[0].prev_hmac).toBe('');
    const expected = createHmac('sha256', KEY)
      .update(
        canonicalJSON({
          ts: entries[0].ts,
          type: entries[0].type,
          chain_id: entries[0].chain_id,
          payload: entries[0].payload,
          prev_hmac: '',
        }),
      )
      .digest('base64');
    expect(entries[0].hmac).toBe(expected);
  });

  it('1000 sequential append() calls produce 1000 entries with intact HMAC chain', async () => {
    const w = await ChainAuditWriter.open({ logPath, key: KEY });
    try {
      for (let i = 0; i < 1000; i++) {
        await w.append('plugin_invoked', `CH-${i}`, {
          chain_id: `CH-${i}`,
          plugin_id: `p-${i}`,
          step: 1,
          consumes: [],
        });
      }
    } finally {
      await w.close();
    }
    const entries = await readEntries(logPath);
    expect(entries).toHaveLength(1000);
    expect(verifyChain(entries, KEY)).toEqual({ ok: true });
    // Every entry's prev_hmac should match the previous entry's hmac.
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i].prev_hmac).toBe(entries[i - 1].hmac);
    }
  });

  it('100 concurrent append() calls produce 100 entries with intact chain (mutex serializes)', async () => {
    const w = await ChainAuditWriter.open({ logPath, key: KEY });
    try {
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          w.append('plugin_invoked', `CH-${i}`, {
            chain_id: `CH-${i}`,
            plugin_id: `p-${i}`,
            step: 1,
            consumes: [],
          }),
        ),
      );
    } finally {
      await w.close();
    }
    const entries = await readEntries(logPath);
    expect(entries).toHaveLength(100);
    expect(verifyChain(entries, KEY)).toEqual({ ok: true });
    // No duplicate prev_hmac (every link in the chain is unique).
    const prevs = entries.map((e) => e.prev_hmac);
    const uniques = new Set(prevs);
    expect(uniques.size).toBe(prevs.length);
  });

  it('close + reopen resumes the chain at the correct prev_hmac', async () => {
    const w1 = await ChainAuditWriter.open({ logPath, key: KEY });
    await w1.append('chain_started', 'CH-1', {
      chain_id: 'CH-1',
      chain_name: 'test',
      trigger: 'p1',
      plugins: ['p1'],
    });
    const lastA = w1.getLastHmac();
    await w1.close();

    const w2 = await ChainAuditWriter.open({ logPath, key: KEY });
    expect(w2.getLastHmac()).toBe(lastA);
    await w2.append('chain_completed', 'CH-1', {
      chain_id: 'CH-1',
      duration_ms: 10,
      entries: 2,
    });
    await w2.close();

    const entries = await readEntries(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[1].prev_hmac).toBe(lastA);
    expect(verifyChain(entries, KEY)).toEqual({ ok: true });
  });

  it('rotation rotates current → .1 when size exceeds maxSizeMb cap', async () => {
    const w = await ChainAuditWriter.open({
      logPath,
      key: KEY,
      maxSizeMb: 0.001, // ~1KB cap so a few appends trigger rotation
    });
    try {
      for (let i = 0; i < 30; i++) {
        await w.append('chain_started', `CH-${i}`, {
          chain_id: `CH-${i}`,
          chain_name: 'rotation-test-with-some-extra-padding-to-grow-bytes',
          trigger: 'p1',
          plugins: ['p1', 'p2', 'p3', 'p4', 'p5'],
        });
      }
    } finally {
      await w.close();
    }
    const rotated = path.join(tmpDir, 'chains-audit.log.1');
    const stat = await fs.stat(rotated);
    expect(stat.isFile()).toBe(true);
  });

  it('verifyChain detects a tampered payload (hmac mismatch)', async () => {
    const w = await ChainAuditWriter.open({ logPath, key: KEY });
    try {
      await w.append('chain_started', 'CH-1', {
        chain_id: 'CH-1',
        chain_name: 'test',
        trigger: 'p1',
        plugins: ['p1'],
      });
      await w.append('plugin_invoked', 'CH-1', {
        chain_id: 'CH-1',
        plugin_id: 'p1',
        step: 1,
        consumes: [],
      });
    } finally {
      await w.close();
    }
    const entries = await readEntries(logPath);
    // Mutate payload of entry 2 without re-signing.
    (entries[1].payload as Record<string, unknown>).step = 99;
    const r = verifyChain(entries, KEY);
    expect(r.ok).toBe(false);
    expect(r.line).toBe(2);
    expect(r.reason).toBe('hmac_mismatch');
  });

  it('verifyChain detects a broken prev_hmac link', async () => {
    const w = await ChainAuditWriter.open({ logPath, key: KEY });
    try {
      await w.append('chain_started', 'CH-1', {
        chain_id: 'CH-1',
        chain_name: 'test',
        trigger: 'p1',
        plugins: ['p1'],
      });
      await w.append('plugin_invoked', 'CH-1', {
        chain_id: 'CH-1',
        plugin_id: 'p1',
        step: 1,
        consumes: [],
      });
    } finally {
      await w.close();
    }
    const entries = await readEntries(logPath);
    entries[1].prev_hmac = 'AAAA';
    const r = verifyChain(entries, KEY);
    expect(r.ok).toBe(false);
    expect(r.line).toBe(2);
    expect(r.reason).toBe('prev_hmac_mismatch');
  });
});

describe('getChainsAuditHmacKey', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ad-chain-audit-key-'));
    resetChainsAuditKeyCacheForTest();
  });

  afterEach(async () => {
    resetChainsAuditKeyCacheForTest();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reads the key from CHAINS_AUDIT_HMAC_KEY env var when set', () => {
    const k = Buffer.alloc(32, 1).toString('base64');
    const env = { CHAINS_AUDIT_HMAC_KEY: k } as NodeJS.ProcessEnv;
    const key = getChainsAuditHmacKey({
      env,
      keyPath: path.join(tmpDir, 'should-not-be-read.key'),
    });
    expect(key.length).toBe(32);
    expect(getChainsAuditKeySourceForTest()).toBe('env');
  });

  it('reads the key from disk when present (mode preserved)', async () => {
    const onDisk = Buffer.alloc(32, 2);
    const keyPath = path.join(tmpDir, 'chains-audit-hmac.key');
    await fs.writeFile(keyPath, onDisk.toString('base64'), { mode: 0o600 });
    const key = getChainsAuditHmacKey({ env: {}, keyPath });
    expect(Buffer.compare(key, onDisk)).toBe(0);
    expect(getChainsAuditKeySourceForTest()).toBe('file');
  });

  it('generates a fresh 32-byte key on first run with no env/disk material', async () => {
    const keyPath = path.join(tmpDir, 'chains-audit-hmac.key');
    const warns: string[] = [];
    const key = getChainsAuditHmacKey({
      env: {},
      keyPath,
      logger: { warn: (m: string) => warns.push(m) },
    });
    expect(key.length).toBe(32);
    expect(getChainsAuditKeySourceForTest()).toBe('generated');
    expect(warns.some((w) => /CRITICAL/.test(w))).toBe(true);
    const stat = await fs.stat(keyPath);
    // eslint-disable-next-line no-bitwise
    expect(stat.mode & 0o777).toBe(0o600);
  });
});
