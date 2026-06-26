/**
 * Unit tests for the stabilization watch (ONBOARD Phase 4, #596).
 *
 * @module intake/triggers/trigger_watch.test
 */

import {
  commitTrigger,
  getRecord,
  patchRecord,
  type TriggerRecord,
  type TriggerStoreIO,
} from '../trigger_store';
import {
  advanceWatches,
  evaluateWatch,
  startWatch,
  type WatchOpts,
} from '../trigger_watch';

const DAY = 86_400_000;
const OPTS: WatchOpts = { nDays: 3, maxWatchDays: 14, maxGapMs: DAY };

function memIO(files: Map<string, string>): TriggerStoreIO {
  return {
    homedir: () => '/home/test',
    readFile: (p) => files.get(p),
    writeFile: (p, d) => {
      files.set(p, d);
    },
    now: () => 0,
  };
}

function rec(requestId: string): TriggerRecord {
  return {
    requestId,
    scope: 'repo:acme/orders',
    scopeId: 'acme/orders',
    scopeType: 'repo',
    targetRepo: 'acme/orders',
    origin: { platform: 'discord', channelId: 'c1', userId: 'u1', messageId: requestId },
    createdAtMs: 0,
    status: 'enqueued',
  };
}

function watching(over: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    ...rec('R'),
    status: 'watching',
    watchPrBranch: 'pr-1',
    watchStartedAtMs: 0,
    ...over,
  };
}

describe('evaluateWatch', () => {
  it('green under N days keeps watching and sets the streak start', () => {
    const r = evaluateWatch(watching({ greenSinceMs: undefined }), { state: 'green' }, DAY, OPTS);
    expect(r.status).toBe('watching');
    expect(r.greenSinceMs).toBe(DAY);
    expect(r.transitioned).toBe(false);
  });

  it('green for ≥ N days (continuously observed) → stable', () => {
    // streak began at 0 AND green was observed within maxGapMs of now.
    const r = evaluateWatch(
      watching({ greenSinceMs: 0, lastGreenMs: 2.5 * DAY }),
      { state: 'green' },
      3 * DAY,
      OPTS,
    );
    expect(r.status).toBe('stable');
    expect(r.transitioned).toBe(true);
  });

  it('does NOT graduate to stable across an observation gap (blocker fix)', () => {
    // streak nominally began at 0, but green was last OBSERVED at 0; a green
    // tick at day 3 sees a 3-day gap (> maxGapMs=1d) → the streak restarts.
    const r = evaluateWatch(
      watching({ greenSinceMs: 0, lastGreenMs: 0 }),
      { state: 'green' },
      3 * DAY,
      OPTS,
    );
    expect(r.status).toBe('watching');
    expect(r.greenSinceMs).toBe(3 * DAY); // reset to now
    expect(r.transitioned).toBe(false);
  });

  it('clock skew (future lastGreenMs) does NOT count as a continuous streak', () => {
    // lastGreenMs is AHEAD of now (a clock rewind) → negative gap → not recent
    // → the streak restarts rather than graduating (round-2 fix).
    const r = evaluateWatch(
      watching({ greenSinceMs: 0, lastGreenMs: 5 * DAY }),
      { state: 'green' },
      3 * DAY,
      OPTS,
    );
    expect(r.status).toBe('watching');
    expect(r.greenSinceMs).toBe(3 * DAY); // reset to now
  });

  it('red resets the green streak but keeps watching', () => {
    const r = evaluateWatch(watching({ greenSinceMs: DAY }), { state: 'red' }, 2 * DAY, OPTS);
    expect(r.status).toBe('watching');
    expect(r.greenSinceMs).toBeUndefined();
  });

  it('a revert → regressed (terminal)', () => {
    const r = evaluateWatch(watching({ greenSinceMs: DAY }), { state: 'green', hasRevert: true }, 2 * DAY, OPTS);
    expect(r.status).toBe('regressed');
    expect(r.transitioned).toBe(true);
  });

  it('past the hard cap → expired', () => {
    const r = evaluateWatch(watching({ watchStartedAtMs: 0 }), { state: 'pending' }, 15 * DAY, OPTS);
    expect(r.status).toBe('expired');
    expect(r.transitioned).toBe(true);
  });

  it('pending holds without disturbing the streak', () => {
    const r = evaluateWatch(watching({ greenSinceMs: DAY }), { state: 'pending' }, 2 * DAY, OPTS);
    expect(r.status).toBe('watching');
    expect(r.greenSinceMs).toBe(DAY);
    expect(r.transitioned).toBe(false);
  });

  it('a non-watching record is returned unchanged', () => {
    const r = evaluateWatch(watching({ status: 'stable' }), { state: 'green' }, 99 * DAY, OPTS);
    expect(r.transitioned).toBe(false);
    expect(r.status).toBe('stable');
  });
});

describe('advanceWatches', () => {
  function setup() {
    const files = new Map<string, string>();
    const io = memIO(files);
    commitTrigger(rec('R-1'), io);
    startWatch('R-1', 'pr-1', 0, io);
    const audits: Array<{ event: string }> = [];
    const transitions: Array<{ status: string; reason: string }> = [];
    return { io, audits, transitions };
  }

  it('drives a stable transition: persists status, audits, reports', async () => {
    const { io, audits, transitions } = setup();
    patchRecord('R-1', { greenSinceMs: 0, lastGreenMs: 2.5 * DAY }, io); // green since t=0, observed recently
    await advanceWatches({
      storeIO: io,
      checks: { getStatus: async () => ({ state: 'green' }) },
      now: () => 3 * DAY,
      audit: { append: (e) => audits.push(e as { event: string }) },
      onTransition: async (_r, status, reason) => {
        transitions.push({ status, reason });
      },
      opts: OPTS,
    });
    expect(getRecord('R-1', io)?.status).toBe('stable');
    expect(audits.map((a) => a.event)).toContain('watch_stable');
    expect(transitions[0]?.status).toBe('stable');
  });

  it('persists a streak start without a terminal transition', async () => {
    const { io, transitions } = setup();
    await advanceWatches({
      storeIO: io,
      checks: { getStatus: async () => ({ state: 'green' }) },
      now: () => DAY,
      audit: { append: () => undefined },
      onTransition: async (_r, status, reason) => {
        transitions.push({ status, reason });
      },
      opts: OPTS,
    });
    expect(getRecord('R-1', io)?.status).toBe('watching');
    expect(getRecord('R-1', io)?.greenSinceMs).toBe(DAY);
    expect(transitions).toHaveLength(0);
  });

  it('a checks error skips that record (best-effort, no throw)', async () => {
    const { io } = setup();
    await advanceWatches({
      storeIO: io,
      checks: {
        getStatus: async () => {
          throw new Error('gh down');
        },
      },
      now: () => 3 * DAY,
      audit: { append: () => undefined },
      onTransition: async () => undefined,
      opts: OPTS,
    });
    expect(getRecord('R-1', io)?.status).toBe('watching'); // unchanged
  });

  it('does not tick a watching record with no watchStartedAtMs (no start → no cap)', async () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    commitTrigger(rec('R-x'), io);
    patchRecord('R-x', { status: 'watching', watchPrBranch: 'pr' }, io); // no watchStartedAtMs
    let called = false;
    await advanceWatches({
      storeIO: io,
      checks: {
        getStatus: async () => {
          called = true;
          return { state: 'green' };
        },
      },
      now: () => 99 * DAY,
      audit: { append: () => undefined },
      onTransition: async () => undefined,
      opts: OPTS,
    });
    expect(called).toBe(false);
  });

  it('serializes overlapping ticks (no concurrent store access)', async () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    commitTrigger(rec('R-a'), io);
    startWatch('R-a', 'pr-a', 0, io);
    commitTrigger(rec('R-b'), io);
    startWatch('R-b', 'pr-b', 0, io);
    let inFlight = 0;
    let maxInFlight = 0;
    const checks = {
      getStatus: async (): Promise<{ state: 'pending' }> => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 3));
        inFlight -= 1;
        return { state: 'pending' };
      },
    };
    const d = {
      storeIO: io,
      checks,
      now: () => DAY,
      audit: { append: () => undefined },
      onTransition: async () => undefined,
      opts: OPTS,
    };
    await Promise.all([advanceWatches(d), advanceWatches(d)]);
    expect(maxInFlight).toBe(1); // chained, never concurrent
  });

  it('ignores records that are not watching', async () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    commitTrigger(rec('R-2'), io); // status 'enqueued', no watch
    let called = false;
    await advanceWatches({
      storeIO: io,
      checks: {
        getStatus: async () => {
          called = true;
          return { state: 'green' };
        },
      },
      now: () => 9 * DAY,
      audit: { append: () => undefined },
      onTransition: async () => undefined,
      opts: OPTS,
    });
    expect(called).toBe(false);
  });
});

describe('startWatch', () => {
  it('moves enqueued → watching with the PR branch + start time', () => {
    const files = new Map<string, string>();
    const io = memIO(files);
    commitTrigger(rec('R-1'), io);
    startWatch('R-1', 'pr-9', 5000, io);
    const r = getRecord('R-1', io);
    expect(r?.status).toBe('watching');
    expect(r?.watchPrBranch).toBe('pr-9');
    expect(r?.watchStartedAtMs).toBe(5000);
  });
});
