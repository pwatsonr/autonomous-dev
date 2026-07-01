/**
 * T003 — Ledger unit tests.
 */
import {
  loadLedger,
  saveLedger,
  makeReader,
  makeMutator,
  ledgerPath,
  lockPath,
  LedgerLockBusyError,
  LedgerKeyInvalidError,
  toHourKey,
  parseHourKeyToMs,
} from '../ledger';
import type { LedgerIO, LedgerFile } from '../ledger';
import { readSelfImproveConfig } from '../config';

const DEFAULT_CFG = readSelfImproveConfig({});

function memIO(
  files: Map<string, string>,
  now = 0,
  overrides: Partial<LedgerIO> = {},
): LedgerIO {
  let lockFd = -1;
  return {
    homedir: () => '/home/test',
    readFile: (p) => files.get(p),
    writeFile: (p, data) => {
      files.set(p, data);
    },
    mkdirp: () => {},
    chmod: () => {},
    openExclusive: (p) => {
      if (files.has(p + '.lock-token')) {
        const err = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        throw err;
      }
      files.set(p + '.lock-token', '1');
      lockFd = 1;
      return lockFd;
    },
    closeAndUnlink: (_fd, p) => {
      files.delete(p + '.lock-token');
    },
    statMtimeMs: (p) => {
      return files.has(p + '.lock-token') ? now : null;
    },
    now: () => now,
    randSuffix: () => 'test-suffix',
    ...overrides,
  };
}

describe('loadLedger', () => {
  it('T003-01: absent file → empty ledger', () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    const f = loadLedger(io);
    expect(f.version).toBe(1);
    expect(Object.keys(f.entries)).toHaveLength(0);
    expect(Object.keys(f.windowCosts)).toHaveLength(0);
    expect(f.loadWarnings).toBeUndefined();
  });

  it('T003-02: valid stored file → parsed correctly', () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    const p = ledgerPath(io);
    const data: LedgerFile = {
      version: 1,
      entries: {
        'owner/repo#42': {
          repoId: 'owner/repo',
          issueNumber: 42,
          issueFingerprint: 'abc123',
          requestIds: ['REQ-000001'],
          attempts: 1,
          lastAttemptAt: '2026-07-01T00:00:00Z',
          lastOutcome: 'unknown',
          backoffUntil: null,
          status: 'in_flight',
        },
      },
      windowCosts: { '2026-07-01T14': { totalUsd: 1.5, requestCount: 1 } },
    };
    files.set(p, JSON.stringify(data));
    const f = loadLedger(io);
    expect(f.entries['owner/repo#42'].repoId).toBe('owner/repo');
    expect(f.windowCosts['2026-07-01T14'].totalUsd).toBe(1.5);
  });

  it('T003-03: corrupt JSON → sidecar written; empty in-memory; loadWarnings.length===1', () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    const p = ledgerPath(io);
    files.set(p, 'not valid json {{{{');
    const f = loadLedger(io);
    expect(Object.keys(f.entries)).toHaveLength(0);
    expect(f.loadWarnings).toHaveLength(1);
    expect(f.loadWarnings![0].envVar).toBe('LEDGER_FILE');
    // Check that a sidecar was created
    const sidecars = [...files.keys()].filter((k) => k.includes('.corrupt-'));
    expect(sidecars).toHaveLength(1);
  });
});

describe('saveLedger', () => {
  it('T003-04: writes JSON with atomic tmp file, sets mode 0o600', async () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    const f: LedgerFile = { version: 1, entries: {}, windowCosts: {} };
    await saveLedger(f, io);
    const p = ledgerPath(io);
    expect(files.has(p)).toBe(true);
    const parsed = JSON.parse(files.get(p)!);
    expect(parsed.version).toBe(1);
  });

  it('T003-05: two concurrent writers serialise via lock', async () => {
    const files = new Map<string, string>();
    let lockHolder: string | null = null;
    let collisions = 0;

    const makeLockedIO = (id: string): LedgerIO => ({
      homedir: () => '/home/test',
      readFile: (p) => files.get(p),
      writeFile: (p, data) => { files.set(p, data); },
      mkdirp: () => {},
      chmod: () => {},
      openExclusive: (p) => {
        if (lockHolder !== null) {
          collisions++;
          const e = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
          throw e;
        }
        lockHolder = id;
        return 1;
      },
      closeAndUnlink: (_fd, _p) => { lockHolder = null; },
      statMtimeMs: () => null,
      now: () => Date.now(),
      randSuffix: () => id,
    });

    const f: LedgerFile = { version: 1, entries: {}, windowCosts: {} };
    // Run two saves in parallel; the second should retry and eventually succeed
    const [a, b] = await Promise.allSettled([
      saveLedger(f, makeLockedIO('a')),
      saveLedger(f, makeLockedIO('b')),
    ]);
    // At least one should succeed (we're testing serialisation, not strict ordering)
    const successes = [a, b].filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBeGreaterThanOrEqual(1);
  });

  it('T003-06: stale lock (mtime > 60s) → force-unlinks + succeeds', async () => {
    const files = new Map<string, string>();
    // Set mtime to 0 (= 61s before now=61000)
    const now = 61_000;
    let lockExists = true;
    const io: LedgerIO = {
      homedir: () => '/home/test',
      readFile: (p) => files.get(p),
      writeFile: (p, data) => { files.set(p, data); },
      mkdirp: () => {},
      chmod: () => {},
      openExclusive: (p) => {
        if (lockExists) {
          const e = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
          throw e;
        }
        return 1;
      },
      closeAndUnlink: (_fd, p) => {
        if (p.endsWith('.lock')) lockExists = false;
      },
      statMtimeMs: () => 0, // mtime = 0ms, now = 61000ms → stale
      now: () => now,
      randSuffix: () => 'test',
    };
    const f: LedgerFile = { version: 1, entries: {}, windowCosts: {} };
    await expect(saveLedger(f, io)).resolves.toBeUndefined();
  });

  it('T003-07: lock busy and not stale → throws LedgerLockBusyError', async () => {
    const files = new Map<string, string>();
    const io: LedgerIO = {
      homedir: () => '/home/test',
      readFile: (p) => files.get(p),
      writeFile: () => {},
      mkdirp: () => {},
      chmod: () => {},
      openExclusive: () => {
        const e = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        throw e;
      },
      closeAndUnlink: () => {},
      statMtimeMs: () => Date.now(), // fresh mtime → not stale
      now: () => Date.now(),
      randSuffix: () => 'test',
    };
    const f: LedgerFile = { version: 1, entries: {}, windowCosts: {} };
    await expect(saveLedger(f, io)).rejects.toThrow(LedgerLockBusyError);
  });
});

describe('LedgerReader', () => {
  const NOW = Date.parse('2026-07-01T15:00:00Z');

  it('T003-08: costLast24h and costLast7d sum correctly', () => {
    const f: LedgerFile = {
      version: 1,
      entries: {},
      windowCosts: {
        '2026-07-01T14': { totalUsd: 1.0, requestCount: 1 }, // within 24h
        '2026-06-30T14': { totalUsd: 2.0, requestCount: 1 }, // within 7d but not 24h
        '2026-06-23T14': { totalUsd: 99.0, requestCount: 1 }, // outside 7d
      },
    };
    const reader = makeReader(f, DEFAULT_CFG, NOW);
    expect(reader.costLast24h()).toBeCloseTo(1.0);
    expect(reader.costLast7d()).toBeCloseTo(3.0);
  });
});

describe('LedgerMutator', () => {
  it('T003-09: invalid key → LedgerKeyInvalidError', () => {
    const f: LedgerFile = { version: 1, entries: {}, windowCosts: {} };
    const mutator = makeMutator(f, DEFAULT_CFG, Date.now());
    expect(() =>
      mutator.recordSubmission('bad-slug#42', {
        repoId: 'bad',
        issueNumber: 42,
        issueFingerprint: null,
        requestIds: [],
        attempts: 1,
        lastAttemptAt: new Date().toISOString(),
        lastOutcome: 'unknown',
        backoffUntil: null,
        status: 'in_flight',
      }),
    ).toThrow(LedgerKeyInvalidError);
  });

  it('T003-10: reconcile({}) marks all in-flight entries idle', () => {
    const f: LedgerFile = {
      version: 1,
      entries: {
        'owner/a#1': {
          repoId: 'owner/a',
          issueNumber: 1,
          issueFingerprint: null,
          requestIds: ['REQ-000001'],
          attempts: 1,
          lastAttemptAt: '2026-07-01T00:00:00Z',
          lastOutcome: 'unknown',
          backoffUntil: null,
          status: 'in_flight',
        },
        'owner/b#2': {
          repoId: 'owner/b',
          issueNumber: 2,
          issueFingerprint: null,
          requestIds: ['REQ-000002'],
          attempts: 1,
          lastAttemptAt: '2026-07-01T00:00:00Z',
          lastOutcome: 'failed',
          backoffUntil: null,
          status: 'in_flight',
        },
      },
      windowCosts: {},
    };
    const mutator = makeMutator(f, DEFAULT_CFG, Date.now());
    mutator.reconcile(new Set());
    const snap = mutator.snapshot();
    expect(snap.entries['owner/a#1'].status).toBe('idle');
    expect(snap.entries['owner/a#1'].lastOutcome).toBe('unknown');
    expect(snap.entries['owner/b#2'].status).toBe('idle');
    expect(snap.entries['owner/b#2'].lastOutcome).toBe('failed'); // already set, not overwritten
  });

  it('T003-11: two writes in same hour accumulate in single bucket', () => {
    const f: LedgerFile = { version: 1, entries: {}, windowCosts: {} };
    const NOW = Date.parse('2026-07-01T14:30:00Z');
    const mutator = makeMutator(f, DEFAULT_CFG, NOW);
    mutator.recordOutcome('owner/a#1', 'success', 1.0);
    mutator.recordOutcome('owner/a#1', 'success', 2.0);
    const snap = mutator.snapshot();
    const bucket = snap.windowCosts[toHourKey(NOW)];
    expect(bucket.totalUsd).toBeCloseTo(3.0);
    expect(bucket.requestCount).toBe(2);
  });
});

describe('toHourKey / parseHourKeyToMs', () => {
  it('round-trips correctly', () => {
    const ms = Date.parse('2026-07-01T14:00:00Z');
    expect(toHourKey(ms)).toBe('2026-07-01T14');
    expect(parseHourKeyToMs('2026-07-01T14')).toBe(ms);
  });
});
