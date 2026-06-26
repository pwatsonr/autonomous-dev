/**
 * Unit tests for the file-backed trigger store (ONBOARD Phase 4, #596).
 * In-memory IO + a fake clock; "restart" = a fresh IO over the same file map.
 *
 * @module intake/triggers/trigger_store.test
 */

import {
  SEEN_TTL_MS,
  commitTrigger,
  getRecord,
  hasSeen,
  listRecords,
  triggerStatePath,
  updateRecordStatus,
  type TriggerRecord,
  type TriggerStoreIO,
} from '../trigger_store';

function memIO(files: Map<string, string>, startMs = 1_000_000): {
  io: TriggerStoreIO;
  setNow: (ms: number) => void;
} {
  let nowMs = startMs;
  const io: TriggerStoreIO = {
    homedir: () => '/home/test',
    readFile: (p) => files.get(p),
    writeFile: (p, d) => {
      files.set(p, d);
    },
    now: () => nowMs,
  };
  return { io, setNow: (ms) => { nowMs = ms; } };
}

function rec(requestId: string, messageId?: string): TriggerRecord {
  return {
    requestId,
    scope: 'repo:acme/orders',
    scopeId: 'acme/orders',
    scopeType: 'repo',
    targetRepo: 'acme/orders',
    origin: { platform: 'discord', channelId: 'c1', userId: 'u1', messageId },
    createdAtMs: 1_000_000,
    status: 'enqueued',
  };
}

describe('trigger_store', () => {
  it('round-trips a trigger record', () => {
    const files = new Map<string, string>();
    const { io } = memIO(files);
    commitTrigger(rec('REQ-1', 'm1'), io);
    const got = getRecord('REQ-1', io);
    expect(got?.requestId).toBe('REQ-1');
    expect(got?.targetRepo).toBe('acme/orders');
    expect(listRecords(io)).toHaveLength(1);
  });

  it('hasSeen is false before commit and true after (with a message id)', () => {
    const files = new Map<string, string>();
    const { io } = memIO(files);
    expect(hasSeen('m1', io)).toBe(false);
    commitTrigger(rec('REQ-1', 'm1'), io);
    expect(hasSeen('m1', io)).toBe(true);
  });

  it('dedupe survives a restart (seen-set loaded from disk)', () => {
    const files = new Map<string, string>();
    const a = memIO(files);
    commitTrigger(rec('REQ-1', 'm1'), a.io);
    // Fresh IO over the same backing files = a process restart.
    const b = memIO(files);
    expect(hasSeen('m1', b.io)).toBe(true);
  });

  it('upserts by requestId (a re-commit does not duplicate the record)', () => {
    const files = new Map<string, string>();
    const { io } = memIO(files);
    commitTrigger(rec('REQ-1', 'm1'), io);
    commitTrigger({ ...rec('REQ-1', 'm1'), status: 'watching' }, io);
    expect(listRecords(io)).toHaveLength(1);
    expect(getRecord('REQ-1', io)?.status).toBe('watching');
  });

  it('expires a seen id past the TTL', () => {
    const files = new Map<string, string>();
    const { io, setNow } = memIO(files, 1_000_000);
    commitTrigger(rec('REQ-1', 'm1'), io);
    expect(hasSeen('m1', io)).toBe(true);
    setNow(1_000_000 + SEEN_TTL_MS + 1);
    expect(hasSeen('m1', io)).toBe(false);
  });

  it('evicts expired seen ids on the next commit (no unbounded growth)', () => {
    const files = new Map<string, string>();
    const { io, setNow } = memIO(files, 1_000_000);
    commitTrigger(rec('REQ-1', 'm1'), io);
    setNow(1_000_000 + SEEN_TTL_MS + 1);
    commitTrigger(rec('REQ-2', 'm2'), io); // triggers eviction of m1
    const persisted = JSON.parse(files.get(triggerStatePath(io)) as string) as {
      seen: Record<string, number>;
    };
    expect(persisted.seen['m1']).toBeUndefined();
    expect(persisted.seen['m2']).toBeDefined();
  });

  it('records a trigger with no message id (no seen entry, record stored)', () => {
    const files = new Map<string, string>();
    const { io } = memIO(files);
    commitTrigger(rec('REQ-1'), io);
    expect(getRecord('REQ-1', io)).toBeDefined();
    expect(hasSeen('', io)).toBe(false);
  });

  it('a corrupt store file → safe default + preserved in a sidecar', () => {
    const files = new Map<string, string>();
    const { io } = memIO(files);
    files.set(triggerStatePath(io), '{ not valid json');
    expect(listRecords(io)).toEqual([]);
    const sidecar = [...files.keys()].find((k) => k.includes('.corrupt-'));
    expect(sidecar).toBeDefined();
    expect(files.get(sidecar as string)).toBe('{ not valid json');
  });

  it('drops individually-corrupt records on load (keeps the valid ones)', () => {
    const files = new Map<string, string>();
    const { io } = memIO(files);
    files.set(
      triggerStatePath(io),
      JSON.stringify({
        seen: {},
        records: [
          {
            requestId: 'R-good',
            scope: 'repo:a/b',
            scopeId: 'a/b',
            scopeType: 'repo',
            targetRepo: 'a/b',
            origin: { platform: 'discord' },
            createdAtMs: 1,
            status: 'enqueued',
          },
          { requestId: 42 }, // wrong type
          'nope',
          null,
        ],
      }),
    );
    expect(listRecords(io)).toHaveLength(1);
    expect(getRecord('R-good', io)).toBeDefined();
  });

  it('drops a record whose requestId is not path-safe (traversal guard)', () => {
    const files = new Map<string, string>();
    const { io } = memIO(files);
    files.set(
      triggerStatePath(io),
      JSON.stringify({
        seen: {},
        records: [
          {
            requestId: '../../../etc/passwd',
            scope: 'repo:a/b',
            scopeId: 'a/b',
            scopeType: 'repo',
            targetRepo: 'a/b',
            origin: { platform: 'discord' },
            createdAtMs: 1,
            status: 'enqueued',
          },
          {
            requestId: 'REQ-000001',
            scope: 'repo:a/b',
            scopeId: 'a/b',
            scopeType: 'repo',
            targetRepo: 'a/b',
            origin: { platform: 'discord' },
            createdAtMs: 1,
            status: 'enqueued',
          },
        ],
      }),
    );
    expect(listRecords(io).map((r) => r.requestId)).toEqual(['REQ-000001']);
  });

  it('updateRecordStatus patches an existing record (no-op when absent)', () => {
    const files = new Map<string, string>();
    const { io } = memIO(files);
    commitTrigger(rec('REQ-1', 'm1'), io);
    updateRecordStatus('REQ-1', 'stable', io);
    expect(getRecord('REQ-1', io)?.status).toBe('stable');
    updateRecordStatus('REQ-missing', 'expired', io); // no throw
    expect(getRecord('REQ-missing', io)).toBeUndefined();
  });
});
