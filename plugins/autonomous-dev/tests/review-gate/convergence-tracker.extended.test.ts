/**
 * Extended convergence tracker tests (SPEC-004-3-4).
 *
 * Supplements existing convergence-tracker.test.ts with additional
 * test scenarios for the ReviewGateService integration context.
 */

import { ConvergenceTracker, ConvergenceState } from '../../src/review-gate/convergence-tracker';
import type { MergedFinding } from '../../src/review-gate/types';

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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConvergenceTracker - Extended tests', () => {
  const tracker = new ConvergenceTracker();

  // -----------------------------------------------------------------------
  // Iteration 1 is always neutral
  // -----------------------------------------------------------------------
  it('iteration 1 returns neutral analysis', () => {
    const state: ConvergenceState = {
      current_iteration: 1,
      score_history: [{ iteration: 1, aggregate_score: 75 }],
      finding_history: [
        { iteration: 1, findings: [makeFinding('f1', 's1', 'c1')] },
      ],
    };

    const result = tracker.analyze(state);

    expect(result.stagnation_detected).toBe(false);
    expect(result.score_trend).toBe('flat');
    expect(result.score_delta).toBeNull();
    expect(result.resolved_findings).toHaveLength(0);
    expect(result.recurred_findings).toHaveLength(0);
    expect(result.finding_count_trend).toBe('flat');
  });

  // -----------------------------------------------------------------------
  // Score improving with finding reduction
  // -----------------------------------------------------------------------
  it('improving score and decreasing findings: no stagnation', () => {
    const state: ConvergenceState = {
      current_iteration: 2,
      score_history: [
        { iteration: 1, aggregate_score: 70 },
        { iteration: 2, aggregate_score: 82 },
      ],
      finding_history: [
        {
          iteration: 1,
          findings: [
            makeFinding('f1', 's1', 'c1'),
            makeFinding('f2', 's2', 'c2'),
          ],
        },
        {
          iteration: 2,
          findings: [makeFinding('f1', 's1', 'c1')],
        },
      ],
    };

    const result = tracker.analyze(state);

    expect(result.stagnation_detected).toBe(false);
    expect(result.score_trend).toBe('improving');
    expect(result.score_delta).toBe(12);
    expect(result.finding_count_trend).toBe('decreasing');
  });

  // -----------------------------------------------------------------------
  // Score declining triggers stagnation
  // -----------------------------------------------------------------------
  it('declining score triggers stagnation', () => {
    const state: ConvergenceState = {
      current_iteration: 2,
      score_history: [
        { iteration: 1, aggregate_score: 80 },
        { iteration: 2, aggregate_score: 75 },
      ],
      finding_history: [
        { iteration: 1, findings: [makeFinding('f1', 's1', 'c1')] },
        { iteration: 2, findings: [] },
      ],
    };

    const result = tracker.analyze(state);

    expect(result.stagnation_detected).toBe(true);
    expect(result.score_trend).toBe('declining');
    expect(result.stagnation_reasons).toContain(
      expect.stringContaining('declined')
    );
  });

  // -----------------------------------------------------------------------
  // Finding recurrence across 3 iterations
  // -----------------------------------------------------------------------
  it('finding recurrence detected across 3 iterations', () => {
    const state: ConvergenceState = {
      current_iteration: 3,
      score_history: [
        { iteration: 1, aggregate_score: 70 },
        { iteration: 2, aggregate_score: 78 },
        { iteration: 3, aggregate_score: 80 },
      ],
      finding_history: [
        {
          iteration: 1,
          findings: [makeFinding('f1', 's1', 'c1')],
        },
        {
          iteration: 2,
          findings: [], // f1 resolved
        },
        {
          iteration: 3,
          findings: [makeFinding('f1-v3', 's1', 'c1')], // f1 recurred
        },
      ],
    };

    const result = tracker.analyze(state);

    expect(result.recurred_findings.length).toBeGreaterThan(0);
    expect(result.stagnation_detected).toBe(true);
    expect(result.stagnation_reasons).toContain(
      expect.stringContaining('recurred')
    );
  });

  // -----------------------------------------------------------------------
  // Flat score with same finding count
  // -----------------------------------------------------------------------
  it('flat score with same finding count triggers stagnation', () => {
    const state: ConvergenceState = {
      current_iteration: 2,
      score_history: [
        { iteration: 1, aggregate_score: 75 },
        { iteration: 2, aggregate_score: 75 },
      ],
      finding_history: [
        {
          iteration: 1,
          findings: [makeFinding('f1', 's1', 'c1')],
        },
        {
          iteration: 2,
          findings: [makeFinding('f2', 's2', 'c2')],
        },
      ],
    };

    const result = tracker.analyze(state);

    // Finding count is flat (1 -> 1), so stagnation detected
    expect(result.stagnation_detected).toBe(true);
    expect(result.finding_count_trend).toBe('flat');
  });

  // -----------------------------------------------------------------------
  // Finding count increase
  // -----------------------------------------------------------------------
  it('increasing finding count triggers stagnation', () => {
    const state: ConvergenceState = {
      current_iteration: 2,
      score_history: [
        { iteration: 1, aggregate_score: 75 },
        { iteration: 2, aggregate_score: 76 },
      ],
      finding_history: [
        {
          iteration: 1,
          findings: [makeFinding('f1', 's1', 'c1')],
        },
        {
          iteration: 2,
          findings: [
            makeFinding('f2', 's2', 'c2'),
            makeFinding('f3', 's3', 'c3'),
          ],
        },
      ],
    };

    const result = tracker.analyze(state);

    expect(result.stagnation_detected).toBe(true);
    expect(result.finding_count_trend).toBe('increasing');
  });

  // -----------------------------------------------------------------------
  // Insufficient data
  // -----------------------------------------------------------------------
  it('empty score history returns neutral', () => {
    const state: ConvergenceState = {
      current_iteration: 2,
      score_history: [],
      finding_history: [],
    };

    const result = tracker.analyze(state);

    expect(result.stagnation_detected).toBe(false);
    expect(result.score_delta).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Resolved findings detection
  // -----------------------------------------------------------------------
  it('correctly identifies resolved findings', () => {
    const state: ConvergenceState = {
      current_iteration: 2,
      score_history: [
        { iteration: 1, aggregate_score: 70 },
        { iteration: 2, aggregate_score: 85 },
      ],
      finding_history: [
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
          findings: [makeFinding('f1-v2', 's1', 'c1')], // Only f1 persists
        },
      ],
    };

    const result = tracker.analyze(state);

    // f2 and f3 resolved
    expect(result.resolved_findings.length).toBe(2);
    expect(result.finding_count_trend).toBe('decreasing');
  });
});
