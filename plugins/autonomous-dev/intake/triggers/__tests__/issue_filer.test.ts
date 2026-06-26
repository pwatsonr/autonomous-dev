/**
 * Unit tests for the gh-backed auto-issue filer (ONBOARD Phase 6, #583).
 * Fake `ExecFn` routes by gh subcommand; no network, no real gh.
 *
 * @module intake/triggers/issue_filer.test
 */

import type { ExecFn } from '../checks_client';
import {
  failureFingerprint,
  fingerprintMarker,
  ghIssueFiler,
  type FailureIssue,
} from '../issue_filer';

type GhResult = { stdout: string; ok: boolean };

/** Route a fake gh by subcommand (`issue <verb>`), recording every call. */
function execFor(routes: {
  list?: GhResult;
  create?: GhResult;
  comment?: GhResult;
}): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (_cmd, args) => {
    calls.push(args);
    const verb = args[1];
    if (verb === 'list') return routes.list ?? { stdout: '[]', ok: true };
    if (verb === 'create') return routes.create ?? { stdout: 'https://gh/issues/1', ok: true };
    if (verb === 'comment') return routes.comment ?? { stdout: '', ok: true };
    return { stdout: '', ok: true };
  };
  return { exec, calls };
}

function issue(over: Partial<FailureIssue> = {}): FailureIssue {
  return {
    repo: 'acme/orders',
    title: 'pipeline failed in phase code',
    body: 'Request REQ-000001 failed.',
    fingerprint: 'abc123def4567890',
    ...over,
  };
}

describe('failureFingerprint', () => {
  it('is stable for the same identity and differs across identities', () => {
    const a = failureFingerprint({ repo: 'acme/orders', requestId: 'REQ-1', failureClass: 'pipeline', phase: 'code' });
    const b = failureFingerprint({ repo: 'acme/orders', requestId: 'REQ-1', failureClass: 'pipeline', phase: 'code' });
    const c = failureFingerprint({ repo: 'acme/orders', requestId: 'REQ-2', failureClass: 'pipeline', phase: 'code' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('ghIssueFiler.file', () => {
  it('creates a new issue when none exists, embedding the dedup marker', async () => {
    const { exec, calls } = execFor({
      list: { stdout: '[]', ok: true },
      create: { stdout: 'https://gh/issues/7\n', ok: true },
    });
    const r = await ghIssueFiler(exec).file(issue());
    expect(r.ok).toBe(true);
    expect(r.deduped).toBeFalsy();
    expect(r.url).toBe('https://gh/issues/7');
    const create = calls.find((c) => c[1] === 'create');
    expect(create).toBeDefined();
    const body = create![create!.indexOf('--body') + 1];
    expect(body).toContain(fingerprintMarker('abc123def4567890'));
  });

  it('comments instead of duplicating when an open issue carries the fingerprint', async () => {
    const { exec, calls } = execFor({
      list: { stdout: JSON.stringify([{ number: 42, url: 'https://gh/issues/42' }]), ok: true },
      comment: { stdout: '', ok: true },
    });
    const r = await ghIssueFiler(exec).file(issue());
    expect(r.ok).toBe(true);
    expect(r.deduped).toBe(true);
    expect(r.url).toBe('https://gh/issues/42');
    expect(calls.some((c) => c[1] === 'comment')).toBe(true);
    expect(calls.some((c) => c[1] === 'create')).toBe(false); // no duplicate
  });

  it('rejects an unsafe repo slug before any gh call', async () => {
    const { exec, calls } = execFor({});
    const r = await ghIssueFiler(exec).file(issue({ repo: '../../etc/passwd' }));
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('reports failure (never throws) when gh issue create fails', async () => {
    const { exec } = execFor({ list: { stdout: '[]', ok: true }, create: { stdout: '', ok: false } });
    const r = await ghIssueFiler(exec).file(issue());
    expect(r.ok).toBe(false);
  });

  it('falls back to create when the dedup list call fails (gh transient) — no throw', async () => {
    const { exec, calls } = execFor({
      list: { stdout: '', ok: false },
      create: { stdout: 'https://gh/issues/9', ok: true },
    });
    const r = await ghIssueFiler(exec).file(issue());
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c[1] === 'create')).toBe(true);
  });

  it('never throws when exec itself throws', async () => {
    const exec: ExecFn = async () => {
      throw new Error('gh missing');
    };
    const r = await ghIssueFiler(exec).file(issue());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gh missing');
  });
});
