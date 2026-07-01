/**
 * Tests for runReviewers retry-once policy (REQ-000056 TC-041).
 *
 * Verifies that runReviewers with retryOnce:true re-invokes an ERROR reviewer
 * exactly once per gate, and that the second call's result is returned.
 */

import { runReviewers } from '../runner';
import type { ReviewerEntry, ChangeSetContext, ReviewerResult } from '../types';

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

const makeApprove = (name: string): ReviewerResult => ({
  reviewer_name: name,
  reviewer_type: 'built-in',
  blocking: true,
  threshold: 70,
  score: 85,
  verdict: 'APPROVE',
  duration_ms: 100,
});

const makeError = (name: string): ReviewerResult => ({
  reviewer_name: name,
  reviewer_type: 'built-in',
  blocking: true,
  threshold: 70,
  score: null,
  verdict: 'ERROR',
  duration_ms: 50,
  error_message: 'timeout',
  error_kind: 'reviewer_timeout',
});

describe('runReviewers — retry-once policy (TC-041)', () => {
  test('Test 1: ERROR on call 1, APPROVE on retry → returns A=APPROVE, B=APPROVE; invoke called 3×', async () => {
    const callCounts: Record<string, number> = { A: 0, B: 0 };
    const invoke = jest.fn(async (entry: ReviewerEntry) => {
      callCounts[entry.name] = (callCounts[entry.name] ?? 0) + 1;
      if (entry.name === 'A' && callCounts['A'] === 1) {
        // First call → ERROR (simulate by throwing)
        throw new Error('cli nonzero exit');
      }
      return { score: 85, verdict: 'APPROVE' as const };
    });

    const results = await runReviewers(
      [fakeEntry('A'), fakeEntry('B')],
      fakeCtx,
      { retryOnce: true },
      { invoke },
    );

    expect(results).toHaveLength(2);
    expect(results[0].reviewer_name).toBe('A');
    expect(results[0].verdict).toBe('APPROVE');
    expect(results[1].reviewer_name).toBe('B');
    expect(results[1].verdict).toBe('APPROVE');
    // A invoked twice (initial + retry), B invoked once
    expect(callCounts['A']).toBe(2);
    expect(callCounts['B']).toBe(1);
  });

  test('Test 2: ERROR twice for A → returns A=ERROR (second call); invoke called 2× for A', async () => {
    const callCounts: Record<string, number> = { A: 0, B: 0 };
    const invoke = jest.fn(async (entry: ReviewerEntry) => {
      callCounts[entry.name] = (callCounts[entry.name] ?? 0) + 1;
      if (entry.name === 'A') {
        throw new Error('persistent error');
      }
      return { score: 85, verdict: 'APPROVE' as const };
    });

    const results = await runReviewers(
      [fakeEntry('A'), fakeEntry('B')],
      fakeCtx,
      { retryOnce: true },
      { invoke },
    );

    expect(results).toHaveLength(2);
    expect(results[0].reviewer_name).toBe('A');
    expect(results[0].verdict).toBe('ERROR');
    // invoke called exactly 2× for A (initial + retry)
    expect(callCounts['A']).toBe(2);
  });

  test('Test 3: retryOnce:false → no retry; A returns ERROR after 1 call', async () => {
    const callCounts: Record<string, number> = { A: 0 };
    const invoke = jest.fn(async (entry: ReviewerEntry) => {
      callCounts[entry.name] = (callCounts[entry.name] ?? 0) + 1;
      if (entry.name === 'A') {
        throw new Error('error');
      }
      return { score: 85, verdict: 'APPROVE' as const };
    });

    const results = await runReviewers(
      [fakeEntry('A')],
      fakeCtx,
      { retryOnce: false },
      { invoke },
    );

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('ERROR');
    expect(callCounts['A']).toBe(1); // no retry
  });
});
