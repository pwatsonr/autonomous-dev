/**
 * Unit tests for the reviewer scheduler (SPEC-020-2-05, Task 10).
 *
 * Locks the grouping algorithm from intake/reviewers/scheduler.ts:
 *   - Feature chain on a frontend change → 5 groups, UX+a11y co-located.
 *   - Same chain on non-frontend change → 4 groups, UX+a11y group omitted.
 *   - Built-ins-only chain → all sequential.
 *   - rule-set-enforcement-reviewer always emitted last.
 *   - UX + a11y always co-located when both present and triggered.
 *   - Empty chain → empty groups.
 *   - Pure: deeply equal outputs across calls; input not mutated.
 */

import { ReviewerScheduler } from '../../intake/reviewers/scheduler';
import type {
  ChangeSetContext,
  ReviewerEntry,
} from '../../intake/reviewers/types';

function context(over: Partial<ChangeSetContext> = {}): ChangeSetContext {
  return {
    repoPath: '/tmp/repo',
    changedFiles: [],
    requestId: 'REQ-test',
    gate: 'code_review',
    requestType: 'feature',
    isFrontendChange: false,
    ...over,
  };
}

const featureChain: ReviewerEntry[] = [
  { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 80 },
  { name: 'security-reviewer', type: 'built-in', blocking: true, threshold: 85 },
  { name: 'qa-edge-case-reviewer', type: 'specialist', blocking: true, threshold: 80 },
  { name: 'ux-ui-reviewer', type: 'specialist', blocking: false, threshold: 75, trigger: 'frontend' },
  { name: 'accessibility-reviewer', type: 'specialist', blocking: false, threshold: 75, trigger: 'frontend' },
  { name: 'rule-set-enforcement-reviewer', type: 'specialist', blocking: true, threshold: 90 },
];

const hotfixChain: ReviewerEntry[] = [
  { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 75 },
  { name: 'security-reviewer', type: 'built-in', blocking: true, threshold: 80 },
];

function names(groups: ReturnType<ReviewerScheduler['schedule']>['groups']): string[][] {
  return groups.map((g) => g.map((inv) => inv.entry.name));
}

describe('ReviewerScheduler', () => {
  it('feature chain on a frontend change produces 5 groups in canonical order', () => {
    const sched = new ReviewerScheduler();
    const out = sched.schedule(featureChain, context({ isFrontendChange: true }));
    expect(names(out.groups)).toEqual([
      ['code-reviewer'],
      ['security-reviewer'],
      ['qa-edge-case-reviewer'],
      ['ux-ui-reviewer', 'accessibility-reviewer'],
      ['rule-set-enforcement-reviewer'],
    ]);
  });

  it('feature chain on a non-frontend change omits the [ux, a11y] group entirely', () => {
    const sched = new ReviewerScheduler();
    const out = sched.schedule(featureChain, context({ isFrontendChange: false }));
    expect(names(out.groups)).toEqual([
      ['code-reviewer'],
      ['security-reviewer'],
      ['qa-edge-case-reviewer'],
      ['rule-set-enforcement-reviewer'],
    ]);
    // Verify no empty group leaked through.
    expect(out.groups.every((g) => g.length > 0)).toBe(true);
  });

  it('hotfix chain (built-ins only) emits one group per built-in, sequential', () => {
    const sched = new ReviewerScheduler();
    const out = sched.schedule(hotfixChain, context({ isFrontendChange: false }));
    expect(names(out.groups)).toEqual([['code-reviewer'], ['security-reviewer']]);
  });

  it('rule-set-enforcement-reviewer always emitted as the last group, even if declared first', () => {
    const sched = new ReviewerScheduler();
    const reordered: ReviewerEntry[] = [
      { name: 'rule-set-enforcement-reviewer', type: 'specialist', blocking: true, threshold: 90 },
      { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 80 },
      { name: 'qa-edge-case-reviewer', type: 'specialist', blocking: true, threshold: 80 },
    ];
    const out = sched.schedule(reordered, context({ isFrontendChange: false }));
    expect(names(out.groups)).toEqual([
      ['code-reviewer'],
      ['qa-edge-case-reviewer'],
      ['rule-set-enforcement-reviewer'],
    ]);
  });

  it('UX + a11y co-located even when not adjacent in the declared order', () => {
    const sched = new ReviewerScheduler();
    const split: ReviewerEntry[] = [
      { name: 'code-reviewer', type: 'built-in', blocking: true, threshold: 80 },
      { name: 'ux-ui-reviewer', type: 'specialist', blocking: false, threshold: 75, trigger: 'frontend' },
      { name: 'qa-edge-case-reviewer', type: 'specialist', blocking: true, threshold: 80 },
      { name: 'accessibility-reviewer', type: 'specialist', blocking: false, threshold: 75, trigger: 'frontend' },
    ];
    const out = sched.schedule(split, context({ isFrontendChange: true }));
    // Must contain a single group with both ux + a11y.
    const frontendGroup = out.groups.find(
      (g) => g.some((inv) => inv.entry.name === 'ux-ui-reviewer'),
    );
    expect(frontendGroup).toBeDefined();
    expect(frontendGroup!.map((inv) => inv.entry.name).sort()).toEqual([
      'accessibility-reviewer',
      'ux-ui-reviewer',
    ]);
  });

  it('empty chain produces empty groups', () => {
    const sched = new ReviewerScheduler();
    const out = sched.schedule([], context());
    expect(out.groups).toEqual([]);
  });

  it('is pure: two calls with structurally equal inputs return deeply equal outputs; input not mutated', () => {
    const sched = new ReviewerScheduler();
    const ctx = context({ isFrontendChange: true });
    const snapshot = JSON.parse(JSON.stringify(featureChain));
    const a = sched.schedule(featureChain, ctx);
    const b = sched.schedule(featureChain, ctx);
    expect(names(a.groups)).toEqual(names(b.groups));
    // Input chain unchanged.
    expect(featureChain).toEqual(snapshot);
  });
});
