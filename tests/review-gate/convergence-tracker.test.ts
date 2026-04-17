import { ConvergenceTracker, ConvergenceState } from '../../src/review-gate/convergence-tracker';
import { MergedFinding } from '../../src/review-gate/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFinding(
  id: string,
  sectionId: string,
  categoryId: string,
  overrides?: Partial<MergedFinding>
): MergedFinding {
  return {
    id,
    section_id: sectionId,
    category_id: categoryId,
    severity: 'major',
    critical_sub: null,
    upstream_defect: false,
    description: `Finding ${id}`,
    evidence: 'Evidence',
    suggested_resolution: 'Fix it',
    reported_by: ['r1'],
    resolution_status: null,
    prior_finding_id: null,
    ...overrides,
  };
}

function makeState(
  currentIteration: number,
  scores: { iteration: number; aggregate_score: number }[],
  findings: { iteration: number; findings: MergedFinding[] }[]
): ConvergenceState {
  return {
    current_iteration: currentIteration,
    score_history: scores,
    finding_history: findings,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConvergenceTracker', () => {
  const tracker = new ConvergenceTracker();

  // -----------------------------------------------------------------------
  // Test 12: Iteration 1 -- no analysis
  // -----------------------------------------------------------------------
  test('Iteration 1 returns neutral analysis with no stagnation', () => {
    const state = makeState(
      1,
      [{ iteration: 1, aggregate_score: 75 }],
      [{ iteration: 1, findings: [makeFinding('f1', 'goals', 'goals_measurability')] }]
    );

    const result = tracker.analyze(state);

    expect(result.stagnation_detected).toBe(false);
    expect(result.score_trend).toBe('flat');
    expect(result.score_delta).toBeNull();
    expect(result.resolved_findings).toEqual([]);
    expect(result.recurred_findings).toEqual([]);
    expect(result.finding_count_trend).toBe('flat');
  });

  // -----------------------------------------------------------------------
  // Test 13: Score improving
  // -----------------------------------------------------------------------
  test('Score improving: 75 -> 82', () => {
    const state = makeState(
      2,
      [
        { iteration: 1, aggregate_score: 75 },
        { iteration: 2, aggregate_score: 82 },
      ],
      [
        { iteration: 1, findings: [makeFinding('f1', 'goals', 'completeness')] },
        { iteration: 2, findings: [] },
      ]
    );

    const result = tracker.analyze(state);

    expect(result.score_trend).toBe('improving');
    expect(result.score_delta).toBe(7);
  });

  // -----------------------------------------------------------------------
  // Test 14: Score declining
  // -----------------------------------------------------------------------
  test('Score declining: 80 -> 72 triggers stagnation', () => {
    const state = makeState(
      2,
      [
        { iteration: 1, aggregate_score: 80 },
        { iteration: 2, aggregate_score: 72 },
      ],
      [
        { iteration: 1, findings: [makeFinding('f1', 'a', 'b')] },
        { iteration: 2, findings: [] },
      ]
    );

    const result = tracker.analyze(state);

    expect(result.score_trend).toBe('declining');
    expect(result.score_delta).toBe(-8);
    expect(result.stagnation_detected).toBe(true);
    expect(result.stagnation_reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('declined')])
    );
  });

  // -----------------------------------------------------------------------
  // Test 15: Score flat
  // -----------------------------------------------------------------------
  test('Score flat: 80 -> 80', () => {
    const state = makeState(
      2,
      [
        { iteration: 1, aggregate_score: 80 },
        { iteration: 2, aggregate_score: 80 },
      ],
      [
        { iteration: 1, findings: [makeFinding('f1', 'a', 'b')] },
        { iteration: 2, findings: [] },
      ]
    );

    const result = tracker.analyze(state);

    expect(result.score_trend).toBe('flat');
    expect(result.score_delta).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 16: Finding resolved
  // -----------------------------------------------------------------------
  test('Finding resolved: finding in iteration 1 absent in iteration 2', () => {
    const f1 = makeFinding('f1', 'goals', 'goals_measurability');
    const state = makeState(
      2,
      [
        { iteration: 1, aggregate_score: 75 },
        { iteration: 2, aggregate_score: 82 },
      ],
      [
        { iteration: 1, findings: [f1] },
        { iteration: 2, findings: [] },
      ]
    );

    const result = tracker.analyze(state);

    expect(result.resolved_findings).toContain('f1');
  });

  // -----------------------------------------------------------------------
  // Test 17: Finding recurred
  // -----------------------------------------------------------------------
  test('Finding recurred: resolved in iteration 2, reappears in iteration 3', () => {
    const f1 = makeFinding('f1', 'goals', 'goals_measurability');
    const f1Recurred = makeFinding('f1-r', 'goals', 'goals_measurability');

    const state = makeState(
      3,
      [
        { iteration: 1, aggregate_score: 70 },
        { iteration: 2, aggregate_score: 78 },
        { iteration: 3, aggregate_score: 80 },
      ],
      [
        { iteration: 1, findings: [f1] },
        { iteration: 2, findings: [] }, // f1 resolved here
        { iteration: 3, findings: [f1Recurred] }, // f1 recurred
      ]
    );

    const result = tracker.analyze(state);

    expect(result.recurred_findings).toContain('f1-r');
    expect(result.stagnation_detected).toBe(true);
    expect(result.stagnation_reasons).toEqual(
      expect.arrayContaining([expect.stringContaining('recurred')])
    );
  });

  // -----------------------------------------------------------------------
  // Test 18: Finding count decreasing
  // -----------------------------------------------------------------------
  test('Finding count decreasing: 5 -> 3, not a stagnation trigger by itself', () => {
    const findings1 = Array.from({ length: 5 }, (_, i) =>
      makeFinding(`f${i}`, `s${i}`, `c${i}`)
    );
    const findings2 = Array.from({ length: 3 }, (_, i) =>
      makeFinding(`f2-${i}`, `s2-${i}`, `c2-${i}`)
    );

    const state = makeState(
      2,
      [
        { iteration: 1, aggregate_score: 70 },
        { iteration: 2, aggregate_score: 78 },
      ],
      [
        { iteration: 1, findings: findings1 },
        { iteration: 2, findings: findings2 },
      ]
    );

    const result = tracker.analyze(state);

    expect(result.finding_count_trend).toBe('decreasing');
    // Score improving + finding count decreasing + no recurrence => no stagnation
    expect(result.stagnation_detected).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 19: Finding count flat -- stagnation
  // -----------------------------------------------------------------------
  test('Finding count flat: 5 -> 5 triggers stagnation', () => {
    // Use different section/category keys so there are no "resolved" findings
    const findings1 = Array.from({ length: 5 }, (_, i) =>
      makeFinding(`f1-${i}`, `s${i}`, `c${i}`)
    );
    const findings2 = Array.from({ length: 5 }, (_, i) =>
      makeFinding(`f2-${i}`, `s${i}`, `c${i}`)
    );

    const state = makeState(
      2,
      [
        { iteration: 1, aggregate_score: 75 },
        { iteration: 2, aggregate_score: 78 },
      ],
      [
        { iteration: 1, findings: findings1 },
        { iteration: 2, findings: findings2 },
      ]
    );

    const result = tracker.analyze(state);

    expect(result.finding_count_trend).toBe('flat');
    expect(result.stagnation_detected).toBe(true);
    expect(result.stagnation_reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('did not decrease'),
      ])
    );
  });

  // -----------------------------------------------------------------------
  // Test 20: Finding count increasing -- stagnation
  // -----------------------------------------------------------------------
  test('Finding count increasing: 3 -> 5 triggers stagnation', () => {
    const findings1 = Array.from({ length: 3 }, (_, i) =>
      makeFinding(`f1-${i}`, `s${i}`, `c${i}`)
    );
    const findings2 = Array.from({ length: 5 }, (_, i) =>
      makeFinding(`f2-${i}`, `s${i}`, `c${i}`)
    );

    const state = makeState(
      2,
      [
        { iteration: 1, aggregate_score: 75 },
        { iteration: 2, aggregate_score: 78 },
      ],
      [
        { iteration: 1, findings: findings1 },
        { iteration: 2, findings: findings2 },
      ]
    );

    const result = tracker.analyze(state);

    expect(result.finding_count_trend).toBe('increasing');
    expect(result.stagnation_detected).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 21: Multiple stagnation reasons
  // -----------------------------------------------------------------------
  test('Multiple stagnation reasons: score declines AND findings recur', () => {
    const f1 = makeFinding('f1', 'goals', 'measurability');
    const f1Recurred = makeFinding('f1-r', 'goals', 'measurability');
    const f2 = makeFinding('f2', 'risk', 'identification');

    const state = makeState(
      3,
      [
        { iteration: 1, aggregate_score: 80 },
        { iteration: 2, aggregate_score: 82 },
        { iteration: 3, aggregate_score: 78 },
      ],
      [
        { iteration: 1, findings: [f1, f2] },
        { iteration: 2, findings: [f2] }, // f1 resolved
        { iteration: 3, findings: [f1Recurred, f2] }, // f1 recurred, count increased
      ]
    );

    const result = tracker.analyze(state);

    expect(result.stagnation_detected).toBe(true);
    // Expect at least 2 reasons: score declined + finding recurred
    expect(result.stagnation_reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.stagnation_reasons).toEqual(
      expect.arrayContaining([
        expect.stringContaining('declined'),
        expect.stringContaining('recurred'),
      ])
    );
  });

  // -----------------------------------------------------------------------
  // Test 22: No stagnation when score improves and findings decrease
  // -----------------------------------------------------------------------
  test('No stagnation when score improves and findings decrease with no recurrences', () => {
    const state = makeState(
      2,
      [
        { iteration: 1, aggregate_score: 70 },
        { iteration: 2, aggregate_score: 80 },
      ],
      [
        {
          iteration: 1,
          findings: [
            makeFinding('f1', 's1', 'c1'),
            makeFinding('f2', 's2', 'c2'),
            makeFinding('f3', 's3', 'c3'),
          ],
        },
        {
          iteration: 2,
          findings: [makeFinding('f4', 's4', 'c4')],
        },
      ]
    );

    const result = tracker.analyze(state);

    expect(result.stagnation_detected).toBe(false);
    expect(result.score_trend).toBe('improving');
    expect(result.finding_count_trend).toBe('decreasing');
    expect(result.recurred_findings).toEqual([]);
  });
});
