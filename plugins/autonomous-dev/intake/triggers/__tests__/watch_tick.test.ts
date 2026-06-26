/**
 * Unit tests for the watch tick orchestration (ONBOARD Phase 4, #596).
 *
 * @module intake/triggers/watch_tick.test
 */

import type { FailureIssue, IssueFiler } from '../issue_filer';
import type { TriggerMessage, TriggerNotifier } from '../trigger_reporter';
import {
  commitTrigger,
  getRecord,
  patchRecord,
  type TriggerOrigin,
  type TriggerRecord,
  type TriggerStoreIO,
} from '../trigger_store';
import { startWatch } from '../trigger_watch';
import {
  outcomeFromState,
  runWatchTick,
  type RequestOutcome,
  type WatchTickDeps,
} from '../watch_tick';

const DAY = 86_400_000;

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

interface Harness {
  sent: Array<{ origin: TriggerOrigin; message: TriggerMessage }>;
  audits: string[];
  deps: (over?: Partial<WatchTickDeps>) => WatchTickDeps;
  io: TriggerStoreIO;
}

function harness(files: Map<string, string>, outcomes: Record<string, RequestOutcome>): Harness {
  const io = memIO(files);
  const sent: Array<{ origin: TriggerOrigin; message: TriggerMessage }> = [];
  const audits: string[] = [];
  const notifier: TriggerNotifier = {
    send: async (origin, message) => {
      sent.push({ origin, message });
      return { ok: true };
    },
  };
  const append = (e: { event: string }): void => {
    audits.push(e.event);
  };
  const deps = (over: Partial<WatchTickDeps> = {}): WatchTickDeps => ({
    storeIO: io,
    readOutcome: (r) => outcomes[r.requestId] ?? { status: 'unknown' },
    branchFor: () => 'main',
    checks: { getStatus: async () => ({ state: 'green' }) },
    now: () => 3 * DAY,
    audit: { append },
    reporter: { notifier, audit: { append } },
    ...over,
  });
  return { sent, audits, deps, io };
}

describe('outcomeFromState', () => {
  it('maps done (case-insensitive, trimmed) to done + prUrl', () => {
    expect(outcomeFromState({ status: 'done', pr_url: 'https://gh/pr/1' })).toEqual({
      status: 'done',
      prUrl: 'https://gh/pr/1',
    });
    expect(outcomeFromState({ status: 'DONE' }).status).toBe('done');
    expect(outcomeFromState({ status: ' done\n' }).status).toBe('done'); // trimmed
  });

  it('maps failed/cancelled to failed (+ reason from blocker)', () => {
    expect(outcomeFromState({ status: 'failed', blocker: 'tests red' })).toEqual({
      status: 'failed',
      reason: 'tests red',
    });
    expect(outcomeFromState({ status: 'cancelled' }).status).toBe('failed');
  });

  it('maps in-flight statuses to running, and absent/null/non-status to unknown', () => {
    expect(outcomeFromState({ status: 'active' }).status).toBe('running');
    expect(outcomeFromState({ status: 'queued' }).status).toBe('running');
    expect(outcomeFromState({}).status).toBe('unknown');
    expect(outcomeFromState(null).status).toBe('unknown');
  });
});

describe('runWatchTick', () => {
  it('a done request starts the watch + reports done', async () => {
    const files = new Map<string, string>();
    const h = harness(files, { 'R-1': { status: 'done', prUrl: 'https://gh/pr/1' } });
    commitTrigger(rec('R-1'), h.io);
    const res = await runWatchTick(h.deps());
    expect(res.started).toBe(1);
    expect(res.reportedDone).toBe(1);
    const got = getRecord('R-1', h.io);
    expect(got?.status).toBe('watching');
    expect(got?.watchPrBranch).toBe('main');
    expect(h.audits).toContain('trigger_done');
    expect(h.sent.some((s) => s.message.title.includes('Done'))).toBe(true);
  });

  it('a failed request reports failed + marks the record failed (no watch)', async () => {
    const files = new Map<string, string>();
    const h = harness(files, { 'R-2': { status: 'failed', reason: 'tests red' } });
    commitTrigger(rec('R-2'), h.io);
    const res = await runWatchTick(h.deps());
    expect(res.reportedFailed).toBe(1);
    expect(getRecord('R-2', h.io)?.status).toBe('failed');
    expect(h.audits).toContain('trigger_failed');
  });

  it('a still-running request is left enqueued, nothing reported', async () => {
    const files = new Map<string, string>();
    const h = harness(files, { 'R-3': { status: 'running' } });
    commitTrigger(rec('R-3'), h.io);
    const res = await runWatchTick(h.deps());
    expect(res).toEqual({ started: 0, reportedDone: 0, reportedFailed: 0, issuesFiled: 0 });
    expect(getRecord('R-3', h.io)?.status).toBe('enqueued');
    expect(h.sent).toHaveLength(0);
  });

  it('a readOutcome that throws leaves the record enqueued (best-effort)', async () => {
    const files = new Map<string, string>();
    const h = harness(files, {});
    commitTrigger(rec('R-4'), h.io);
    await runWatchTick(
      h.deps({
        readOutcome: () => {
          throw new Error('state.json unreadable');
        },
      }),
    );
    expect(getRecord('R-4', h.io)?.status).toBe('enqueued');
  });

  it('advances an active watch to stable + reports it', async () => {
    const files = new Map<string, string>();
    const h = harness(files, {});
    commitTrigger(rec('R-5'), h.io);
    startWatch('R-5', 'main', 0, h.io);
    patchRecord('R-5', { greenSinceMs: 0, lastGreenMs: 2.5 * DAY }, h.io); // ready to graduate
    await runWatchTick(h.deps()); // now=3d, checks green
    expect(getRecord('R-5', h.io)?.status).toBe('stable');
    expect(h.audits).toContain('watch_stable');
    expect(h.sent.some((s) => s.message.title.includes('Stabilized'))).toBe(true);
  });

  function captureFiler(): { filer: IssueFiler; filed: FailureIssue[] } {
    const filed: FailureIssue[] = [];
    return {
      filed,
      filer: {
        file: async (i) => {
          filed.push(i);
          return { ok: true };
        },
      },
    };
  }

  it('files a failure issue when a triggered request fails', async () => {
    const files = new Map<string, string>();
    const h = harness(files, { 'R-6': { status: 'failed', reason: 'tests red' } });
    commitTrigger(rec('R-6'), h.io);
    const { filer, filed } = captureFiler();
    const res = await runWatchTick(h.deps({ issueFiler: filer }));
    expect(res.issuesFiled).toBe(1);
    expect(filed).toHaveLength(1);
    expect(filed[0].repo).toBe('acme/orders');
    expect(filed[0].title).toContain('pipeline-failed');
    expect(filed[0].fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('files a failure issue when a watch regresses', async () => {
    const files = new Map<string, string>();
    const h = harness(files, {});
    commitTrigger(rec('R-7'), h.io);
    startWatch('R-7', 'main', 0, h.io);
    patchRecord('R-7', { greenSinceMs: DAY }, h.io);
    const { filer, filed } = captureFiler();
    const res = await runWatchTick(
      h.deps({ issueFiler: filer, checks: { getStatus: async () => ({ state: 'green', hasRevert: true }) } }),
    );
    expect(getRecord('R-7', h.io)?.status).toBe('regressed');
    expect(res.issuesFiled).toBe(1);
    expect(filed[0].title).toContain('regressed');
  });

  it('files a failure issue when a watch expires', async () => {
    const files = new Map<string, string>();
    const h = harness(files, {});
    commitTrigger(rec('R-9'), h.io);
    startWatch('R-9', 'main', 0, h.io);
    const { filer, filed } = captureFiler();
    const res = await runWatchTick(
      h.deps({ issueFiler: filer, now: () => 15 * DAY, checks: { getStatus: async () => ({ state: 'pending' }) } }),
    );
    expect(getRecord('R-9', h.io)?.status).toBe('expired');
    expect(res.issuesFiled).toBe(1);
    expect(filed[0].title).toContain('expired');
  });

  it('does NOT file an issue on a successful stabilization', async () => {
    const files = new Map<string, string>();
    const h = harness(files, {});
    commitTrigger(rec('R-8'), h.io);
    startWatch('R-8', 'main', 0, h.io);
    patchRecord('R-8', { greenSinceMs: 0, lastGreenMs: 2.5 * DAY }, h.io);
    const { filer, filed } = captureFiler();
    const res = await runWatchTick(h.deps({ issueFiler: filer }));
    expect(getRecord('R-8', h.io)?.status).toBe('stable');
    expect(res.issuesFiled).toBe(0);
    expect(filed).toHaveLength(0);
  });
});
