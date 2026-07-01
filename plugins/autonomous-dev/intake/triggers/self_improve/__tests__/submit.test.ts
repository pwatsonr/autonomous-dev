/**
 * T010 — Submit adapter unit tests.
 */
import { submitFromIssue } from '../submit';
import type { SubmitDeps } from '../submit';
import type { IssueSnapshot } from '../actionable';
import type { LedgerMutator, LedgerFile } from '../ledger';
import { makeMutator } from '../ledger';
import { readSelfImproveConfig } from '../config';
import type { EventEmitter, SelfImproveEvent } from '../events';

const DEFAULT_CFG = readSelfImproveConfig({});

const BASE_ISSUE: IssueSnapshot = {
  repoId: 'owner/repo',
  number: 42,
  htmlUrl: 'https://github.com/owner/repo/issues/42',
  title: 'Test issue',
  body: 'Some pipeline failure.',
  labels: [],
  authorLogin: 'autodev-bot',
  updatedAt: '2026-07-01T00:00:00Z',
  fingerprint: 'abc12345',
  reviewerBlockFp: null,
};

function makeDeps(
  overrides: Partial<SubmitDeps> & {
    ledgerFile?: LedgerFile;
    events?: SelfImproveEvent[];
  } = {},
): SubmitDeps & { events: SelfImproveEvent[]; ledgerFile: LedgerFile } {
  const events: SelfImproveEvent[] = overrides.events ?? [];
  const ledgerFile: LedgerFile = overrides.ledgerFile ?? {
    version: 1,
    entries: {},
    windowCosts: {},
  };
  const ledger: LedgerMutator = makeMutator(ledgerFile, DEFAULT_CFG, Date.now());
  const emit: EventEmitter = (ev) => {
    events.push(ev);
  };

  return {
    requestSubmit: overrides.requestSubmit ?? (async () => ({ requestId: 'REQ-000001' })),
    postGithubComment: overrides.postGithubComment ?? (async () => {}),
    ledger,
    emit,
    now: () => 1_000_000,
    resolveRepoPath: (repoId) => `/repos/${repoId}`,
    events,
    ledgerFile,
  };
}

describe('submitFromIssue', () => {
  it('T010-01: happy path → correct sequence and return {ok:true}', async () => {
    const calls: string[] = [];
    const deps = makeDeps({
      requestSubmit: async () => {
        calls.push('requestSubmit');
        return { requestId: 'REQ-000001' };
      },
      postGithubComment: async () => {
        calls.push('postGithubComment');
      },
    });
    // Spy on recordSubmission
    const origRecord = deps.ledger.recordSubmission.bind(deps.ledger);
    deps.ledger.recordSubmission = (key, entry) => {
      calls.push('recordSubmission');
      origRecord(key, entry);
    };
    const origEmit = deps.emit;
    deps.emit = (ev) => {
      if (ev.type === 'self_improve_request_submitted') calls.push('emit_submitted');
      origEmit(ev);
    };

    const result = await submitFromIssue(BASE_ISSUE, 'A1', DEFAULT_CFG, deps);
    expect(result.ok).toBe(true);
    expect(result.requestId).toBe('REQ-000001');
    // Order: requestSubmit → recordSubmission → postGithubComment → emit_submitted
    expect(calls.indexOf('requestSubmit')).toBeLessThan(calls.indexOf('recordSubmission'));
    expect(calls.indexOf('recordSubmission')).toBeLessThan(calls.indexOf('postGithubComment'));
    expect(calls.indexOf('postGithubComment')).toBeLessThan(calls.indexOf('emit_submitted'));
  });

  it('T010-02: requestSubmit throws → no ledger write, no comment, SUBMIT_FAILED event', async () => {
    const ledgerWrites: string[] = [];
    const deps = makeDeps({
      requestSubmit: async () => {
        throw new Error('network error');
      },
    });
    const origRecord = deps.ledger.recordSubmission.bind(deps.ledger);
    deps.ledger.recordSubmission = (key, entry) => {
      ledgerWrites.push(key);
      origRecord(key, entry);
    };
    const commentCalls: string[] = [];
    deps.postGithubComment = async () => {
      commentCalls.push('comment');
    };

    const result = await submitFromIssue(BASE_ISSUE, 'A1', DEFAULT_CFG, deps);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('SUBMIT_FAILED');
    expect(ledgerWrites).toHaveLength(0);
    expect(commentCalls).toHaveLength(0);
    expect(deps.events.some((e) => e.type === 'self_improve_error')).toBe(true);
  });

  it('T010-03: comment throws → ledger committed, GH_COMMENT_FAILED emitted', async () => {
    const deps = makeDeps({
      postGithubComment: async () => {
        throw new Error('comment failed');
      },
    });

    const result = await submitFromIssue(BASE_ISSUE, 'A1', DEFAULT_CFG, deps);
    expect(result.ok).toBe(true); // Overall success
    // Ledger should have entry
    const snap = deps.ledger.snapshot();
    expect(snap.entries['owner/repo#42']).toBeDefined();
    // Error event for comment failure
    const errEv = deps.events.find(
      (e) => e.type === 'self_improve_error',
    ) as { type: 'self_improve_error'; code?: string } | undefined;
    expect(errEv?.code).toBe('GH_COMMENT_FAILED');
  });

  it('T010-04: prev entry has attempts=1 → new attempts=2, requestIds appended', async () => {
    const ledgerFile: LedgerFile = {
      version: 1,
      entries: {
        'owner/repo#42': {
          repoId: 'owner/repo',
          issueNumber: 42,
          issueFingerprint: null,
          requestIds: ['REQ-000099'],
          attempts: 1,
          lastAttemptAt: '2026-06-01T00:00:00Z',
          lastOutcome: 'failed',
          backoffUntil: null,
          status: 'idle',
        },
      },
      windowCosts: {},
    };
    const deps = makeDeps({ ledgerFile });
    await submitFromIssue(BASE_ISSUE, 'A1', DEFAULT_CFG, deps);
    const snap = deps.ledger.snapshot();
    expect(snap.entries['owner/repo#42'].attempts).toBe(2);
    expect(snap.entries['owner/repo#42'].requestIds).toContain('REQ-000001');
    expect(snap.entries['owner/repo#42'].requestIds).toContain('REQ-000099');
  });

  it('T010-05: truncated body → self_improve_body_truncated emitted BEFORE submission', async () => {
    const calls: string[] = [];
    const bigBody = 'X'.repeat(40 * 1024);
    const issue: IssueSnapshot = { ...BASE_ISSUE, body: bigBody };
    const deps = makeDeps({
      requestSubmit: async () => {
        calls.push('requestSubmit');
        return { requestId: 'REQ-000001' };
      },
    });
    const origEmit = deps.emit;
    deps.emit = (ev) => {
      if (ev.type === 'self_improve_body_truncated') calls.push('truncated');
      origEmit(ev);
    };

    await submitFromIssue(issue, 'A1', DEFAULT_CFG, deps);
    expect(calls.indexOf('truncated')).toBeLessThan(calls.indexOf('requestSubmit'));
  });

  it('T010-06: RequestSubmitInput has source=self-improve + selfImproveContext', async () => {
    const inputs: object[] = [];
    const deps = makeDeps({
      requestSubmit: async (input) => {
        inputs.push(input);
        return { requestId: 'REQ-000001' };
      },
    });
    await submitFromIssue(BASE_ISSUE, 'A1', DEFAULT_CFG, deps);
    expect(inputs).toHaveLength(1);
    const inp = inputs[0] as {
      source: string;
      selfImproveContext: { sourceIssue: { repoId: string } };
    };
    expect(inp.source).toBe('self-improve');
    expect(inp.selfImproveContext.sourceIssue.repoId).toBe('owner/repo');
  });
});
