/**
 * T005 — Evidence check unit tests.
 */
import { checkEvidence } from '../evidence';
import type { EvidenceDeps, Ownership } from '../evidence';
import type { IssueSnapshot } from '../actionable';

const TIMEOUT_MS = 50;
const BOT_LOGIN = 'autodev-bot';

const OWNERSHIP: Ownership = {
  repos: [{ repoId: 'owner/repo', path: '/repos/owner/repo', enrolled: true }],
};

const BASE_ISSUE: IssueSnapshot = {
  repoId: 'owner/repo',
  number: 42,
  htmlUrl: 'https://github.com/owner/repo/issues/42',
  title: 'Test issue',
  body: '',
  labels: [],
  authorLogin: BOT_LOGIN,
  updatedAt: '2026-07-01T00:00:00Z',
  fingerprint: 'abc12345',
  reviewerBlockFp: null,
};

function makeDeps(overrides: Partial<EvidenceDeps> = {}): EvidenceDeps {
  return {
    readState: async () => null,
    fetchIssueEvents: async () => ({ labeledBy: {} }),
    timeoutMs: TIMEOUT_MS,
    botLogin: BOT_LOGIN,
    ...overrides,
  };
}

describe('checkEvidence A1', () => {
  it('T005-01: body has REQ-000123, readState returns failed → ok', async () => {
    const issue: IssueSnapshot = {
      ...BASE_ISSUE,
      body: 'See REQ-000123 for details.',
      fingerprint: 'abc12345',
    };
    const deps = makeDeps({
      readState: async () => ({ status: 'failed' }),
    });
    const result = await checkEvidence('A1', issue, OWNERSHIP, deps);
    expect(result.ok).toBe(true);
    expect((result.detail as { mode: string })?.mode).toBe('state-verified');
  });

  it('T005-02: no REQ- in body but fingerprint present → marker-only', async () => {
    const issue: IssueSnapshot = {
      ...BASE_ISSUE,
      body: 'Pipeline failed.',
      fingerprint: 'abc12345',
    };
    const result = await checkEvidence('A1', issue, OWNERSHIP, makeDeps());
    expect(result.ok).toBe(true);
    expect((result.detail as { mode: string })?.mode).toBe('marker-only');
  });

  it('T005-03: readState returns active → NA7_STATE_MISMATCH', async () => {
    const issue: IssueSnapshot = {
      ...BASE_ISSUE,
      body: 'REQ-000123 active',
    };
    const deps = makeDeps({ readState: async () => ({ status: 'active' }) });
    const result = await checkEvidence('A1', issue, OWNERSHIP, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NA7_STATE_MISMATCH');
  });

  it('T005-04: ownership missing repo path → NA7_NO_REPO_PATH', async () => {
    const issue: IssueSnapshot = { ...BASE_ISSUE, repoId: 'unknown/repo' };
    const result = await checkEvidence('A1', issue, OWNERSHIP, makeDeps());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NA7_NO_REPO_PATH');
  });

  it('T005-11: two REQ- refs in body; first fails, stops at first', async () => {
    const issue: IssueSnapshot = {
      ...BASE_ISSUE,
      body: 'REQ-000001 and REQ-000002',
    };
    const deps = makeDeps({
      readState: async (_repoPath, reqId) => {
        if (reqId === 'REQ-000001') return { status: 'active' }; // not failed
        return { status: 'failed' };
      },
    });
    const result = await checkEvidence('A1', issue, OWNERSHIP, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NA7_STATE_MISMATCH');
  });
});

describe('checkEvidence A2', () => {
  it('T005-05: reviewer block returns REQUEST_CHANGES → ok', async () => {
    const issue: IssueSnapshot = {
      ...BASE_ISSUE,
      reviewerBlockFp: 'rev-fp-123',
    };
    const deps = makeDeps({
      readReviewerBlock: async () => ({ verdict: 'REQUEST_CHANGES' }),
    });
    const result = await checkEvidence('A2', issue, OWNERSHIP, deps);
    expect(result.ok).toBe(true);
  });

  it('T005-06: reviewer block returns ERROR → NA7_REVIEWER_ERROR', async () => {
    const issue: IssueSnapshot = {
      ...BASE_ISSUE,
      reviewerBlockFp: 'rev-fp-123',
    };
    const deps = makeDeps({
      readReviewerBlock: async () => ({ verdict: 'ERROR' }),
    });
    const result = await checkEvidence('A2', issue, OWNERSHIP, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NA7_REVIEWER_ERROR');
  });

  it('T005-07: reviewerBlockFp null → NA7_NO_REVIEWER_BLOCK', async () => {
    const issue: IssueSnapshot = { ...BASE_ISSUE, reviewerBlockFp: null };
    const result = await checkEvidence('A2', issue, OWNERSHIP, makeDeps());
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NA7_NO_REVIEWER_BLOCK');
  });
});

describe('checkEvidence A3', () => {
  it('T005-08: human labeler alice → ok', async () => {
    const issue: IssueSnapshot = { ...BASE_ISSUE };
    const deps = makeDeps({
      fetchIssueEvents: async () => ({ labeledBy: { 'autodev/auto-fix': 'alice' } }),
      botLogin: BOT_LOGIN,
    });
    const result = await checkEvidence('A3', issue, OWNERSHIP, deps);
    expect(result.ok).toBe(true);
    expect((result.detail as { humanLabeler: string })?.humanLabeler).toBe('alice');
  });

  it('T005-09: bot labeler → NA7_BOT_LABELER', async () => {
    const deps = makeDeps({
      fetchIssueEvents: async () => ({ labeledBy: { 'autodev/auto-fix': BOT_LOGIN } }),
    });
    const result = await checkEvidence('A3', BASE_ISSUE, OWNERSHIP, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NA7_BOT_LABELER');
  });
});

describe('checkEvidence timeout', () => {
  it('T005-10: deps hang past timeoutMs → EVIDENCE_TIMEOUT', async () => {
    const deps = makeDeps({
      fetchIssueEvents: async () => {
        await new Promise((r) => setTimeout(r, 200));
        return { labeledBy: {} };
      },
      timeoutMs: 50,
    });
    const result = await checkEvidence('A3', BASE_ISSUE, OWNERSHIP, deps);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EVIDENCE_TIMEOUT');
  });
});
