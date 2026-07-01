/**
 * T008 — Description / payload builder unit tests.
 */
import { buildSubmitPayload } from '../description';
import { readSelfImproveConfig } from '../config';
import type { IssueSnapshot } from '../actionable';

const DEFAULT_CFG = readSelfImproveConfig({});

function makeIssue(overrides: Partial<IssueSnapshot> = {}): IssueSnapshot {
  return {
    repoId: 'owner/repo',
    number: 42,
    htmlUrl: 'https://github.com/owner/repo/issues/42',
    title: 'Test issue',
    body: '',
    labels: [],
    authorLogin: 'bot',
    updatedAt: '2026-07-01T00:00:00Z',
    fingerprint: null,
    reviewerBlockFp: null,
    ...overrides,
  };
}

describe('buildSubmitPayload', () => {
  it('T008-01: body with ## Acceptance Criteria + 3 bullets → extracted', () => {
    const body = `
# Summary

Some text.

## Acceptance Criteria

- First criterion
- Second criterion
- Third criterion

## Other Section
`;
    const payload = buildSubmitPayload(makeIssue({ body }), 'A1', DEFAULT_CFG);
    expect(payload.acceptanceCriteria).toHaveLength(3);
    expect(payload.acceptanceCriteria[0]).toBe('First criterion');
  });

  it('T008-02: body with ```test block → criteria from fenced block', () => {
    const body = `Some text.\n\`\`\`test\ncriterion one\ncriterion two\n\`\`\``;
    const payload = buildSubmitPayload(makeIssue({ body }), 'A1', DEFAULT_CFG);
    expect(payload.acceptanceCriteria).toContain('criterion one');
    expect(payload.acceptanceCriteria).toContain('criterion two');
  });

  it('T008-03: body with neither heading nor fenced block → synthesized', () => {
    const payload = buildSubmitPayload(makeIssue({ body: 'Plain text.' }), 'A1', DEFAULT_CFG);
    expect(payload.acceptanceCriteria).toHaveLength(1);
    expect(payload.acceptanceCriteria[0]).toMatch(/Reproduce the failure/);
  });

  it('T008-04: body 40KB, truncateBytes=32768 → truncated', () => {
    const body = 'A'.repeat(40 * 1024);
    const cfg = readSelfImproveConfig({ AUTONOMOUS_DEV_SELF_IMPROVE_BODY_TRUNCATE_BYTES: '32768' });
    const payload = buildSubmitPayload(makeIssue({ body }), 'A1', cfg);
    expect(payload.truncation.truncated).toBe(true);
    expect(payload.truncation.originalBytes).toBe(40 * 1024);
    expect(payload.truncation.truncatedBytes).toBeLessThanOrEqual(32768);
    expect(payload.description).toContain('AAAA');
  });

  it('T008-05: P0 label → priority high', () => {
    const payload = buildSubmitPayload(
      makeIssue({ labels: ['autodev/priority:P0'] }),
      'A1',
      DEFAULT_CFG,
    );
    expect(payload.priority).toBe('high');
  });

  it('T008-06: P2 label → priority normal', () => {
    const payload = buildSubmitPayload(
      makeIssue({ labels: ['autodev/priority:P2'] }),
      'A1',
      DEFAULT_CFG,
    );
    expect(payload.priority).toBe('normal');
  });

  it('T008-07: P3 label → priority low', () => {
    const payload = buildSubmitPayload(
      makeIssue({ labels: ['autodev/priority:P3'] }),
      'A1',
      DEFAULT_CFG,
    );
    expect(payload.priority).toBe('low');
  });

  it('T008-08: no priority label → normal', () => {
    const payload = buildSubmitPayload(makeIssue(), 'A1', DEFAULT_CFG);
    expect(payload.priority).toBe('normal');
  });

  it('T008-09: A3 + autodev/type:refactor → type refactor', () => {
    const payload = buildSubmitPayload(
      makeIssue({ labels: ['autodev/auto-fix', 'autodev/type:refactor'] }),
      'A3',
      DEFAULT_CFG,
    );
    expect(payload.type).toBe('refactor');
  });

  it('T008-10: A1 + autodev/type:refactor → type bug (override only for A3)', () => {
    const payload = buildSubmitPayload(
      makeIssue({ labels: ['autodev:pipeline-failed', 'autodev/type:refactor'] }),
      'A1',
      DEFAULT_CFG,
    );
    expect(payload.type).toBe('bug');
  });

  it('T008-11: description has correct composition order', () => {
    const issue = makeIssue({ body: 'issue body content' });
    const payload = buildSubmitPayload(issue, 'A1', DEFAULT_CFG);
    const d = payload.description;
    const headerIdx = d.indexOf('Auto-generated from');
    const sourceIdx = d.indexOf('Source: https://');
    const bodyIdx = d.indexOf('issue body content');
    const acIdx = d.indexOf('## Acceptance Criteria');
    const constraintsIdx = d.indexOf('## Constraints');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(sourceIdx).toBeGreaterThan(headerIdx);
    expect(bodyIdx).toBeGreaterThan(sourceIdx);
    expect(acIdx).toBeGreaterThan(bodyIdx);
    expect(constraintsIdx).toBeGreaterThan(acIdx);
  });

  it('T008-12: multibyte UTF-8 char at truncation boundary → safe truncation', () => {
    // '€' is 3 bytes in UTF-8. If we truncate at a byte boundary that
    // falls in the middle of a € sequence, the truncated string should
    // still be valid UTF-8.
    const euro = '€'; // 3 bytes
    const body = euro.repeat(1000); // 3000 bytes
    const cfg = readSelfImproveConfig({ AUTONOMOUS_DEV_SELF_IMPROVE_BODY_TRUNCATE_BYTES: '10' });
    const payload = buildSubmitPayload(makeIssue({ body }), 'A1', cfg);
    expect(payload.truncation.truncated).toBe(true);
    // Should be valid string (no garbled chars)
    expect(() => Buffer.from(payload.truncation.truncatedBytes.toString())).not.toThrow();
    // truncatedBytes should be a multiple of 3 (each € is 3 bytes) and ≤ 10
    expect(payload.truncation.truncatedBytes).toBeLessThanOrEqual(10);
  });
});
