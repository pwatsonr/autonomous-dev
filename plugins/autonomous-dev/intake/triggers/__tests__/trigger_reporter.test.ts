/**
 * Unit tests for the scoped trigger reporter (ONBOARD Phase 4, #596).
 *
 * @module intake/triggers/trigger_reporter.test
 */

import {
  formatAccepted,
  formatTerminal,
  reportAccepted,
  reportTerminal,
  type ReporterDeps,
  type TriggerAuditSink,
  type TriggerMessage,
  type TriggerNotifier,
} from '../trigger_reporter';
import type { TriggerOrigin, TriggerRecord } from '../trigger_store';

function rec(channelId: string | undefined = 'c1'): TriggerRecord {
  return {
    requestId: 'REQ-1',
    scope: 'repo:acme/orders',
    scopeId: 'acme/orders',
    scopeType: 'repo',
    targetRepo: 'acme/orders',
    origin: { platform: 'discord', channelId, userId: 'u1', messageId: 'm1' },
    createdAtMs: 1,
    status: 'enqueued',
  };
}

interface Fakes {
  deps: ReporterDeps;
  sent: Array<{ origin: TriggerOrigin; message: TriggerMessage }>;
  audits: Array<{ event: string; [k: string]: unknown }>;
}

function fakes(opts?: { sendResult?: { ok: boolean; error?: string }; throwOnSend?: boolean }): Fakes {
  const sent: Array<{ origin: TriggerOrigin; message: TriggerMessage }> = [];
  const audits: Array<{ event: string; [k: string]: unknown }> = [];
  const notifier: TriggerNotifier = {
    send: async (origin, message) => {
      if (opts?.throwOnSend) throw new Error('boom');
      sent.push({ origin, message });
      return opts?.sendResult ?? { ok: true };
    },
  };
  const audit: TriggerAuditSink = { append: (e) => { audits.push(e); } };
  return { deps: { notifier, audit }, sent, audits };
}

const events = (f: Fakes): string[] => f.audits.map((a) => a.event);

describe('trigger_reporter formatting', () => {
  it('formatAccepted names the request, scope, repo, and cost', () => {
    const m = formatAccepted(rec(), { costUsd: 3, eta: '20m' });
    expect(m.title).toContain('REQ-1');
    expect(m.body).toContain('acme/orders');
    expect(m.body).toContain('~$3.00');
    expect(m.body).toContain('ETA 20m');
  });

  it('formatTerminal done includes the PR url', () => {
    const m = formatTerminal(rec(), { status: 'done', prUrl: 'https://gh/pr/1' });
    expect(m.title).toContain('Done');
    expect(m.body).toContain('https://gh/pr/1');
  });

  it('formatTerminal failed includes the reason', () => {
    const m = formatTerminal(rec(), { status: 'failed', reason: 'tests red' });
    expect(m.title).toContain('Failed');
    expect(m.body).toContain('tests red');
  });
});

describe('trigger_reporter delivery', () => {
  it('reportAccepted audits + delivers to the origin', async () => {
    const f = fakes();
    await reportAccepted(rec(), { costUsd: 3 }, f.deps);
    expect(events(f)).toContain('trigger_accepted');
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].origin.channelId).toBe('c1');
  });

  it('reportTerminal done audits trigger_done + delivers', async () => {
    const f = fakes();
    await reportTerminal(rec(), { status: 'done', prUrl: 'https://gh/pr/1' }, f.deps);
    expect(events(f)).toContain('trigger_done');
    expect(f.audits.find((a) => a.event === 'trigger_done')?.pr).toBe('https://gh/pr/1');
    expect(f.sent).toHaveLength(1);
  });

  it('reportTerminal failed audits trigger_failed with the reason', async () => {
    const f = fakes();
    await reportTerminal(rec(), { status: 'failed', reason: 'tests red' }, f.deps);
    expect(f.audits.find((a) => a.event === 'trigger_failed')?.reason).toBe('tests red');
  });

  it('a delivery failure still records the terminal audit + a report_failed entry', async () => {
    const f = fakes({ sendResult: { ok: false, error: 'discord 500' } });
    await reportTerminal(rec(), { status: 'done' }, f.deps);
    expect(events(f)).toContain('trigger_done'); // the fallback outcome is recorded
    expect(events(f)).toContain('trigger_report_failed');
  });

  it('a notifier that throws is caught (never blocks) + audited', async () => {
    const f = fakes({ throwOnSend: true });
    await reportTerminal(rec(), { status: 'done' }, f.deps); // must not throw
    expect(events(f)).toContain('trigger_done');
    expect(events(f)).toContain('trigger_report_failed');
  });

  it('no origin channel → skips delivery but still audits the outcome', async () => {
    const f = fakes();
    const base = rec();
    const noChannel: TriggerRecord = { ...base, origin: { ...base.origin, channelId: undefined } };
    await reportTerminal(noChannel, { status: 'done' }, f.deps);
    expect(events(f)).toContain('trigger_done');
    expect(events(f)).toContain('trigger_report_skipped');
    expect(f.sent).toHaveLength(0);
  });
});
