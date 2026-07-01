/**
 * T004 — Actionable classifier unit tests.
 */
import { classify, type IssueSnapshot } from '../actionable';

const BASE_ISSUE: IssueSnapshot = {
  repoId: 'owner/repo',
  number: 42,
  htmlUrl: 'https://github.com/owner/repo/issues/42',
  title: 'Test issue',
  body: '',
  labels: [],
  authorLogin: 'human',
  updatedAt: '2026-07-01T00:00:00Z',
  fingerprint: null,
  reviewerBlockFp: null,
};

const BOT_LOGIN = 'autodev-bot';

function issue(overrides: Partial<IssueSnapshot>): IssueSnapshot {
  return { ...BASE_ISSUE, ...overrides };
}

describe('classify', () => {
  it('T004-01: A1 label + marker + bot author → matched A1', () => {
    const i = issue({
      labels: ['autodev:pipeline-failed'],
      authorLogin: BOT_LOGIN,
      body: '<!-- autodev-failure: abc12345 -->',
      fingerprint: 'abc12345',
    });
    const { matched } = classify(i, { botLogin: BOT_LOGIN });
    expect(matched?.id).toBe('A1');
  });

  it('T004-02: A1 label present but no marker → null', () => {
    const i = issue({ labels: ['autodev:pipeline-failed'], authorLogin: BOT_LOGIN });
    const { matched } = classify(i, { botLogin: BOT_LOGIN });
    expect(matched).toBeNull();
  });

  it('T004-03: A1 label + marker + human author + no fingerprint → null', () => {
    const i = issue({
      labels: ['autodev:pipeline-failed'],
      authorLogin: 'human',
      body: '<!-- autodev-failure: abc12345 -->',
      fingerprint: null,
    });
    const { matched } = classify(i, { botLogin: BOT_LOGIN });
    expect(matched).toBeNull();
  });

  it('T004-04: A1 label + marker + human author + fingerprint → matched A1', () => {
    const i = issue({
      labels: ['autodev:pipeline-failed'],
      authorLogin: 'human',
      body: '<!-- autodev-failure: abc12345 -->',
      fingerprint: 'abc12345',
    });
    const { matched } = classify(i, { botLogin: BOT_LOGIN });
    expect(matched?.id).toBe('A1');
  });

  it('T004-05: A2 label + reviewer marker → matched A2', () => {
    const i = issue({
      labels: ['autodev:reviewer-finding'],
      body: '<!-- autodev-reviewer: review-fp-42 -->',
      reviewerBlockFp: 'review-fp-42',
    });
    const { matched } = classify(i, { botLogin: BOT_LOGIN });
    expect(matched?.id).toBe('A2');
  });

  it('T004-06: A3 label only → matched A3', () => {
    const i = issue({ labels: ['autodev/auto-fix'] });
    const { matched } = classify(i, { botLogin: BOT_LOGIN });
    expect(matched?.id).toBe('A3');
  });

  it('T004-07: both A1 and A3 labels + A1 satisfied → A1 (catalog order)', () => {
    const i = issue({
      labels: ['autodev:pipeline-failed', 'autodev/auto-fix'],
      authorLogin: BOT_LOGIN,
      body: '<!-- autodev-failure: abc12345 -->',
      fingerprint: 'abc12345',
    });
    const { matched } = classify(i, { botLogin: BOT_LOGIN });
    expect(matched?.id).toBe('A1');
  });

  it('T004-08: no matching labels → null', () => {
    const i = issue({ labels: ['some:other-label'] });
    const { matched } = classify(i, { botLogin: BOT_LOGIN });
    expect(matched).toBeNull();
  });
});
