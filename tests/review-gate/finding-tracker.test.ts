/**
 * Unit tests for FindingTracker (SPEC-004-3-2, Task 5).
 *
 * Covers all 9 test cases from the spec (numbered 19-27):
 * 19. Iteration 1 -- all open
 * 20. Finding resolved
 * 21. Finding persists
 * 22. Finding recurred
 * 23. New finding in iteration 2
 * 24. Multiple resolutions
 * 25. Tracking result categories
 * 26. No previous findings (first iteration)
 * 27. All findings resolved
 */

import type { MergedFinding } from '../../src/review-gate/types';
import { FindingTracker } from '../../src/review-gate/finding-tracker';
import type { FindingTrackingResult } from '../../src/review-gate/finding-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let findingCounter = 0;

/** Build a minimal MergedFinding for testing. */
function makeMergedFinding(overrides: Partial<MergedFinding> = {}): MergedFinding {
  findingCounter++;
  return {
    id: overrides.id ?? `mf-${findingCounter}`,
    section_id: overrides.section_id ?? 'section-default',
    category_id: overrides.category_id ?? 'category-default',
    severity: overrides.severity ?? 'minor',
    critical_sub: overrides.critical_sub ?? null,
    upstream_defect: overrides.upstream_defect ?? false,
    description: overrides.description ?? `Description ${findingCounter}`,
    evidence: overrides.evidence ?? `Evidence ${findingCounter}`,
    suggested_resolution: overrides.suggested_resolution ?? `Resolution ${findingCounter}`,
    reported_by: overrides.reported_by ?? ['reviewer-a'],
    resolution_status: overrides.resolution_status ?? 'open',
    prior_finding_id: overrides.prior_finding_id ?? null,
  };
}

beforeEach(() => {
  findingCounter = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FindingTracker', () => {
  let tracker: FindingTracker;

  beforeEach(() => {
    tracker = new FindingTracker();
  });

  // -----------------------------------------------------------------------
  // Test 19: Iteration 1 -- all open
  // -----------------------------------------------------------------------
  test('19. Iteration 1 -- all open: no previous findings', () => {
    const current = [
      makeMergedFinding({ section_id: 'goals', category_id: 'measurability' }),
      makeMergedFinding({ section_id: 'risks', category_id: 'risk_identification' }),
      makeMergedFinding({ section_id: 'scope', category_id: 'scope_clarity' }),
    ];

    const result = tracker.trackFindings(current, null);

    expect(result.tracked_findings).toHaveLength(3);
    for (const f of result.tracked_findings) {
      expect(f.resolution_status).toBe('open');
      expect(f.prior_finding_id).toBeNull();
    }
    expect(result.resolved_findings).toHaveLength(0);
    expect(result.recurred_findings).toHaveLength(0);
    expect(result.new_findings).toHaveLength(3);
    expect(result.persistent_findings).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 20: Finding resolved
  // -----------------------------------------------------------------------
  test('20. Finding resolved: present in iteration 1, absent in iteration 2', () => {
    const prevFinding = makeMergedFinding({
      id: 'prev-1',
      section_id: 'goals',
      category_id: 'measurability',
    });
    const currentFindings: MergedFinding[] = []; // Finding gone

    const result = tracker.trackFindings(currentFindings, [prevFinding]);

    expect(result.tracked_findings).toHaveLength(0);
    expect(result.resolved_findings).toHaveLength(1);
    expect(result.resolved_findings[0].resolution_status).toBe('resolved');
    expect(result.resolved_findings[0].id).toBe('prev-1');
  });

  // -----------------------------------------------------------------------
  // Test 21: Finding persists
  // -----------------------------------------------------------------------
  test('21. Finding persists: present in both iterations', () => {
    const prevFinding = makeMergedFinding({
      id: 'prev-1',
      section_id: 'goals',
      category_id: 'measurability',
    });
    const currentFinding = makeMergedFinding({
      id: 'curr-1',
      section_id: 'goals',
      category_id: 'measurability',
    });

    const result = tracker.trackFindings([currentFinding], [prevFinding]);

    expect(result.tracked_findings).toHaveLength(1);
    expect(result.tracked_findings[0].resolution_status).toBe('open');
    expect(result.tracked_findings[0].prior_finding_id).toBe('prev-1');
    expect(result.persistent_findings).toHaveLength(1);
    expect(result.resolved_findings).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 22: Finding recurred
  // -----------------------------------------------------------------------
  test('22. Finding recurred: resolved in iteration 2, reappears in iteration 3', () => {
    // The original finding from iteration 1, now marked resolved
    const resolvedFinding = makeMergedFinding({
      id: 'orig-1',
      section_id: 'goals',
      category_id: 'measurability',
      resolution_status: 'resolved',
    });

    // Iteration 3: no match in immediate previous iteration
    const previousIteration: MergedFinding[] = []; // Empty (iteration 2 had none at this key)
    const allPrevious = [resolvedFinding]; // But it existed and was resolved historically

    const currentFinding = makeMergedFinding({
      id: 'curr-3',
      section_id: 'goals',
      category_id: 'measurability',
    });

    const result = tracker.trackFindings([currentFinding], previousIteration, allPrevious);

    expect(result.tracked_findings).toHaveLength(1);
    expect(result.tracked_findings[0].resolution_status).toBe('recurred');
    expect(result.tracked_findings[0].prior_finding_id).toBe('orig-1');
    expect(result.recurred_findings).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // Test 23: New finding in iteration 2
  // -----------------------------------------------------------------------
  test('23. New finding in iteration 2: no match in iteration 1', () => {
    const prevFinding = makeMergedFinding({
      id: 'prev-1',
      section_id: 'goals',
      category_id: 'measurability',
    });
    const newFinding = makeMergedFinding({
      id: 'new-1',
      section_id: 'architecture',
      category_id: 'architecture_soundness',
    });

    const result = tracker.trackFindings([newFinding], [prevFinding]);

    // The new finding should be "open" with no prior
    const tracked = result.tracked_findings.find((f) => f.id === 'new-1');
    expect(tracked).toBeDefined();
    expect(tracked!.resolution_status).toBe('open');
    expect(tracked!.prior_finding_id).toBeNull();
    expect(result.new_findings).toHaveLength(1);
    expect(result.new_findings[0].id).toBe('new-1');

    // The previous finding should be resolved
    expect(result.resolved_findings).toHaveLength(1);
    expect(result.resolved_findings[0].id).toBe('prev-1');
  });

  // -----------------------------------------------------------------------
  // Test 24: Multiple resolutions
  // -----------------------------------------------------------------------
  test('24. Multiple resolutions: 3 resolved, 2 persist, 1 new', () => {
    const prevFindings = [
      makeMergedFinding({ id: 'p1', section_id: 'goals', category_id: 'measurability' }),
      makeMergedFinding({ id: 'p2', section_id: 'risks', category_id: 'risk_identification' }),
      makeMergedFinding({ id: 'p3', section_id: 'scope', category_id: 'scope_clarity' }),
      makeMergedFinding({ id: 'p4', section_id: 'arch', category_id: 'architecture' }),
      makeMergedFinding({ id: 'p5', section_id: 'security', category_id: 'security_depth' }),
    ];

    const currentFindings = [
      // p1 persists (same section/category)
      makeMergedFinding({ id: 'c1', section_id: 'goals', category_id: 'measurability' }),
      // p2 persists (same section/category)
      makeMergedFinding({ id: 'c2', section_id: 'risks', category_id: 'risk_identification' }),
      // New finding (no match)
      makeMergedFinding({ id: 'c3', section_id: 'testing', category_id: 'test_coverage' }),
      // p3, p4, p5 are resolved (not present in current)
    ];

    const result = tracker.trackFindings(currentFindings, prevFindings);

    expect(result.tracked_findings).toHaveLength(3);
    expect(result.resolved_findings).toHaveLength(3);
    expect(result.persistent_findings).toHaveLength(2);
    expect(result.new_findings).toHaveLength(1);
    expect(result.recurred_findings).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 25: Tracking result categories are correct subsets
  // -----------------------------------------------------------------------
  test('25. Tracking result categories: recurred, new, persistent are correct subsets', () => {
    // Iteration 1 findings (now in allPrevious as resolved)
    const resolvedFromIter1 = makeMergedFinding({
      id: 'iter1-1',
      section_id: 'data',
      category_id: 'data_integrity',
      resolution_status: 'resolved',
    });

    // Iteration 2 findings (previous iteration)
    const prevFindings = [
      makeMergedFinding({ id: 'iter2-1', section_id: 'goals', category_id: 'measurability' }),
      makeMergedFinding({ id: 'iter2-2', section_id: 'risks', category_id: 'risk_identification' }),
    ];

    // Iteration 3 findings (current)
    const currentFindings = [
      // Persists from iter2
      makeMergedFinding({ id: 'iter3-1', section_id: 'goals', category_id: 'measurability' }),
      // New
      makeMergedFinding({ id: 'iter3-2', section_id: 'security', category_id: 'security_depth' }),
      // Recurred from iter1
      makeMergedFinding({ id: 'iter3-3', section_id: 'data', category_id: 'data_integrity' }),
    ];

    const allPrevious = [resolvedFromIter1, ...prevFindings];

    const result = tracker.trackFindings(currentFindings, prevFindings, allPrevious);

    // tracked_findings = all 3 current
    expect(result.tracked_findings).toHaveLength(3);

    // persistent: goals/measurability persists from iter2
    expect(result.persistent_findings).toHaveLength(1);
    expect(result.persistent_findings[0].prior_finding_id).toBe('iter2-1');

    // new: security/security_depth is new
    expect(result.new_findings).toHaveLength(1);
    expect(result.new_findings[0].section_id).toBe('security');

    // recurred: data/data_integrity was resolved, now reappeared
    expect(result.recurred_findings).toHaveLength(1);
    expect(result.recurred_findings[0].resolution_status).toBe('recurred');
    expect(result.recurred_findings[0].prior_finding_id).toBe('iter1-1');

    // resolved: risks/risk_identification from iter2 is gone
    expect(result.resolved_findings).toHaveLength(1);
    expect(result.resolved_findings[0].id).toBe('iter2-2');

    // Subsets: recurred + new + persistent = tracked
    expect(
      result.recurred_findings.length +
      result.new_findings.length +
      result.persistent_findings.length,
    ).toBe(result.tracked_findings.length);
  });

  // -----------------------------------------------------------------------
  // Test 26: No previous findings (first iteration) -- alias of test 19
  // -----------------------------------------------------------------------
  test('26. No previous findings (first iteration): previousIterationFindings is null', () => {
    const current = [
      makeMergedFinding({ section_id: 'goals', category_id: 'measurability' }),
    ];

    const result = tracker.trackFindings(current, null);

    expect(result.tracked_findings).toHaveLength(1);
    expect(result.tracked_findings[0].resolution_status).toBe('open');
    expect(result.tracked_findings[0].prior_finding_id).toBeNull();
    expect(result.new_findings).toHaveLength(1);
    expect(result.resolved_findings).toHaveLength(0);
    expect(result.recurred_findings).toHaveLength(0);
    expect(result.persistent_findings).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 27: All findings resolved
  // -----------------------------------------------------------------------
  test('27. All findings resolved: every finding from iteration 1 gone in iteration 2', () => {
    const prevFindings = [
      makeMergedFinding({ id: 'p1', section_id: 'goals', category_id: 'measurability' }),
      makeMergedFinding({ id: 'p2', section_id: 'risks', category_id: 'risk_identification' }),
      makeMergedFinding({ id: 'p3', section_id: 'scope', category_id: 'scope_clarity' }),
    ];

    const result = tracker.trackFindings([], prevFindings);

    expect(result.tracked_findings).toHaveLength(0);
    expect(result.resolved_findings).toHaveLength(3);
    for (const f of result.resolved_findings) {
      expect(f.resolution_status).toBe('resolved');
    }
    expect(result.new_findings).toHaveLength(0);
    expect(result.persistent_findings).toHaveLength(0);
    expect(result.recurred_findings).toHaveLength(0);
  });
});
