/**
 * T011 — Merge-gate unit tests.
 */
import { isSelfImproveRequest, checkAutoMergeAllowed } from '../merge_gate';

describe('isSelfImproveRequest', () => {
  it('returns true when source === self-improve', () => {
    expect(isSelfImproveRequest({ source: 'self-improve' })).toBe(true);
  });

  it('returns true when self_improve.sourceIssue.issueNumber is positive int', () => {
    expect(
      isSelfImproveRequest({ self_improve: { sourceIssue: { issueNumber: 42 } } }),
    ).toBe(true);
  });

  it('returns false when source is user', () => {
    expect(isSelfImproveRequest({ source: 'user' })).toBe(false);
  });

  it('returns false when issueNumber is 0', () => {
    expect(
      isSelfImproveRequest({ self_improve: { sourceIssue: { issueNumber: 0 } } }),
    ).toBe(false);
  });
});

describe('checkAutoMergeAllowed', () => {
  it('T011-01: self-improve source → { allow: false, reason includes never auto-merges }', () => {
    const result = checkAutoMergeAllowed({ source: 'self-improve' }, []);
    expect(result.allow).toBe(false);
    expect(result.reason).toMatch(/never auto-merges/);
  });

  it('T011-02: self-improve source + label → still { allow: false } (state-based)', () => {
    const result = checkAutoMergeAllowed({ source: 'self-improve' }, ['autodev:self-fix']);
    expect(result.allow).toBe(false);
  });

  it('T011-03: source=user → { allow: true }', () => {
    const result = checkAutoMergeAllowed({ source: 'user' }, []);
    expect(result.allow).toBe(true);
  });

  it('T011-04: null state → { allow: true }', () => {
    const result = checkAutoMergeAllowed(null, []);
    expect(result.allow).toBe(true);
  });

  it('T011-05: self_improve.sourceIssue.issueNumber=42 → { allow: false }', () => {
    const state = { self_improve: { sourceIssue: { issueNumber: 42 } } };
    const result = checkAutoMergeAllowed(state, []);
    expect(result.allow).toBe(false);
  });
});
