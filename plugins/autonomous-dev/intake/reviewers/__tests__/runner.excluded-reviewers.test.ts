/**
 * Tests for runReviewers excludedReviewers policy (REQ-000056 TC-040).
 *
 * Verifies that excluded reviewers are never invoked and produce no result.
 */

import { runReviewers } from '../runner';
import type { ReviewerEntry, ChangeSetContext } from '../types';

const fakeEntry = (name: string, blocking = true): ReviewerEntry => ({
  name,
  type: 'built-in',
  blocking,
  threshold: 70,
  timeout_ms: 30_000,
});

const fakeCtx: ChangeSetContext = {
  repoPath: '/repo',
  changedFiles: [],
  requestId: 'REQ-000001',
  gate: 'code_review',
  requestType: 'feature',
  isFrontendChange: false,
};

const approveInvoke = jest.fn(async () => ({
  score: 85,
  verdict: 'APPROVE' as const,
}));

beforeEach(() => {
  approveInvoke.mockClear();
});

describe('runReviewers — excludedReviewers (TC-040)', () => {
  test('Test 1: excludedReviewers:["A"], chain [A,B] → 1 result for B; invoke never called for A', async () => {
    const invokeCalls: string[] = [];
    const invoke = jest.fn(async (entry: ReviewerEntry) => {
      invokeCalls.push(entry.name);
      return { score: 85, verdict: 'APPROVE' as const };
    });

    const results = await runReviewers(
      [fakeEntry('A'), fakeEntry('B')],
      fakeCtx,
      { excludedReviewers: ['A'] },
      { invoke },
    );

    expect(results).toHaveLength(1);
    expect(results[0].reviewer_name).toBe('B');
    expect(invokeCalls).not.toContain('A');
    expect(invokeCalls).toContain('B');
  });

  test('Test 2: excludedReviewers:[] → all reviewers invoked', async () => {
    const invokeCalls: string[] = [];
    const invoke = jest.fn(async (entry: ReviewerEntry) => {
      invokeCalls.push(entry.name);
      return { score: 85, verdict: 'APPROVE' as const };
    });

    const results = await runReviewers(
      [fakeEntry('A'), fakeEntry('B')],
      fakeCtx,
      { excludedReviewers: [] },
      { invoke },
    );

    expect(results).toHaveLength(2);
    expect(invokeCalls).toContain('A');
    expect(invokeCalls).toContain('B');
  });

  test('Test 3: excludedReviewers:["NONEXISTENT"] → no error; all chain reviewers invoked', async () => {
    const invokeCalls: string[] = [];
    const invoke = jest.fn(async (entry: ReviewerEntry) => {
      invokeCalls.push(entry.name);
      return { score: 85, verdict: 'APPROVE' as const };
    });

    const results = await runReviewers(
      [fakeEntry('A'), fakeEntry('B')],
      fakeCtx,
      { excludedReviewers: ['NONEXISTENT'] },
      { invoke },
    );

    expect(results).toHaveLength(2);
    expect(invokeCalls).toContain('A');
    expect(invokeCalls).toContain('B');
  });
});
