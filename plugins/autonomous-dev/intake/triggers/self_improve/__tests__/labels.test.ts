/**
 * T002 — Labels unit tests.
 */
import {
  parsePriorityLabel,
  parseTypeLabel,
  LABEL_PIPELINE_FAILED,
  LABEL_REVIEWER_FINDING,
  LABEL_AUTO_FIX,
  LABEL_SELF_FIX_PR,
  LABEL_IN_PROGRESS,
  DETECTED_LABELS,
} from '../labels';

describe('parsePriorityLabel', () => {
  it('T002-01: single P0 label → P0', () => {
    expect(parsePriorityLabel(['autodev/priority:P0'])).toBe('P0');
  });

  it('T002-02: multiple priority labels → highest severity (P0)', () => {
    expect(parsePriorityLabel(['autodev/priority:P2', 'autodev/priority:P0'])).toBe('P0');
  });

  it('T002-03: invalid priority label → null', () => {
    expect(parsePriorityLabel(['autodev/priority:Px'])).toBeNull();
  });

  it('T002-04: empty labels array → null', () => {
    expect(parsePriorityLabel([])).toBeNull();
  });

  it('returns P1 when highest', () => {
    expect(parsePriorityLabel(['autodev/priority:P1', 'autodev/priority:P3'])).toBe('P1');
  });
});

describe('parseTypeLabel', () => {
  it('T002-05: refactor type label → refactor', () => {
    expect(parseTypeLabel(['autodev/type:refactor'])).toBe('refactor');
  });

  it('T002-06: bug and refactor labels → bug (first-wins)', () => {
    expect(parseTypeLabel(['autodev/type:bug', 'autodev/type:refactor'])).toBe('bug');
  });

  it('T002-07: no type label → null', () => {
    expect(parseTypeLabel(['some-other-label'])).toBeNull();
  });
});

describe('label constants', () => {
  it('T002-07: constants match expected strings', () => {
    expect(LABEL_PIPELINE_FAILED).toBe('autodev:pipeline-failed');
    expect(LABEL_REVIEWER_FINDING).toBe('autodev:reviewer-finding');
    expect(LABEL_AUTO_FIX).toBe('autodev/auto-fix');
    expect(LABEL_SELF_FIX_PR).toBe('autodev:self-fix');
    expect(LABEL_IN_PROGRESS).toBe('autodev:in-progress');
    expect(DETECTED_LABELS).toContain(LABEL_PIPELINE_FAILED);
    expect(DETECTED_LABELS).toContain(LABEL_REVIEWER_FINDING);
    expect(DETECTED_LABELS).toContain(LABEL_AUTO_FIX);
  });
});
