/**
 * Extended iteration controller tests (SPEC-004-3-4).
 *
 * Supplements the existing iteration-controller.test.ts with additional
 * tests for the ReviewGateService integration context: multi-gate tracking,
 * checkpoint ordering, and complex stagnation/regression interplay.
 */

import {
  IterationController,
  IterationState,
  computeContentHash,
} from '../../src/review-gate/iteration-controller';
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

describe('IterationController - Extended tests', () => {
  // -----------------------------------------------------------------------
  // Multi-gate tracking
  // -----------------------------------------------------------------------
  it('tracks multiple gates independently', () => {
    const controller = new IterationController();

    const stateA = controller.initializeGate('gate-A', 'doc-A');
    const stateB = controller.initializeGate('gate-B', 'doc-B');

    const updatedA = controller.startIteration(stateA);
    const updatedB = controller.startIteration(stateB);

    expect(updatedA.current_iteration).toBe(1);
    expect(updatedB.current_iteration).toBe(1);
    expect(updatedA.gate_id).toBe('gate-A');
    expect(updatedB.gate_id).toBe('gate-B');

    // Checkpoint A
    controller.checkpoint(updatedA, 'review_started');
    // Checkpoint B
    controller.checkpoint(updatedB, 'review_completed');

    // Restore independently
    const restoredA = controller.restoreFromCheckpoint('gate-A');
    const restoredB = controller.restoreFromCheckpoint('gate-B');

    expect(restoredA).not.toBeNull();
    expect(restoredB).not.toBeNull();
    expect(restoredA!.gate_id).toBe('gate-A');
    expect(restoredB!.gate_id).toBe('gate-B');
    expect(restoredA!.checkpoints[0].stage).toBe('review_started');
    expect(restoredB!.checkpoints[0].stage).toBe('review_completed');
  });

  // -----------------------------------------------------------------------
  // Checkpoint ordering
  // -----------------------------------------------------------------------
  it('preserves checkpoint order within a gate', () => {
    const controller = new IterationController();
    let state = controller.initializeGate('gate-order', 'doc-order');
    state = controller.startIteration(state);

    controller.checkpoint(state, 'review_started');
    controller.checkpoint(state, 'review_completed');
    controller.checkpoint(state, 'decision');

    expect(state.checkpoints.length).toBe(3);
    expect(state.checkpoints[0].stage).toBe('review_started');
    expect(state.checkpoints[1].stage).toBe('review_completed');
    expect(state.checkpoints[2].stage).toBe('decision');

    // Timestamps should be monotonically increasing
    for (let i = 1; i < state.checkpoints.length; i++) {
      const prev = new Date(state.checkpoints[i - 1].timestamp).getTime();
      const curr = new Date(state.checkpoints[i].timestamp).getTime();
      expect(curr).toBeGreaterThanOrEqual(prev);
    }
  });

  // -----------------------------------------------------------------------
  // Stagnation resets on improvement then re-triggers
  // -----------------------------------------------------------------------
  it('stagnation resets on improvement then re-triggers on subsequent decline', () => {
    const controller = new IterationController({ max_iterations: 6 });
    let state = controller.initializeGate('gate-stag-reset', 'doc-stag-reset');

    // Iteration 1: baseline
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      80,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('v1'),
      'changes_requested'
    );

    // Iteration 2: decline (stagnation count 1)
    state = controller.startIteration(state);
    const d2 = controller.recordReviewOutcome(
      state,
      75,
      [makeFinding('f2', 's2', 'c2')],
      computeContentHash('v2'),
      'changes_requested'
    );
    expect(d2.stagnation_warning).toBe(true);
    expect(state.stagnation_count).toBe(1);

    // Iteration 3: improvement (resets count)
    state = controller.startIteration(state);
    const d3 = controller.recordReviewOutcome(
      state,
      82,
      [],
      computeContentHash('v3'),
      'changes_requested'
    );
    expect(d3.stagnation_warning).toBe(false);
    expect(state.stagnation_count).toBe(0);

    // Iteration 4: decline again (stagnation count 1)
    state = controller.startIteration(state);
    const d4 = controller.recordReviewOutcome(
      state,
      78,
      [makeFinding('f4', 's4', 'c4')],
      computeContentHash('v4'),
      'changes_requested'
    );
    expect(d4.stagnation_warning).toBe(true);
    expect(state.stagnation_count).toBe(1);

    // Iteration 5: decline again (stagnation count 2 -> forced rejection)
    state = controller.startIteration(state);
    const d5 = controller.recordReviewOutcome(
      state,
      73,
      [makeFinding('f5', 's5', 'c5')],
      computeContentHash('v5'),
      'changes_requested'
    );
    expect(d5.should_continue).toBe(false);
    expect(d5.outcome).toBe('rejected');
  });

  // -----------------------------------------------------------------------
  // Regression and stagnation interplay
  // -----------------------------------------------------------------------
  it('quality regression detected alongside stagnation', () => {
    const controller = new IterationController({ max_iterations: 5 });
    let state = controller.initializeGate('gate-interplay', 'doc-interplay');

    // Iteration 1
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      85,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('interplay-v1'),
      'changes_requested'
    );

    // Iteration 2: large score drop (regression + stagnation)
    state = controller.startIteration(state);
    const d2 = controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f2', 's2', 'c2')],
      computeContentHash('interplay-v2'),
      'changes_requested'
    );

    // Both should be flagged
    expect(d2.stagnation_warning).toBe(true);
    expect(d2.quality_regression).not.toBeNull();
    expect(d2.quality_regression!.delta).toBe(-15);
  });

  // -----------------------------------------------------------------------
  // Content hash: identical after whitespace normalization
  // -----------------------------------------------------------------------
  it('detects identical revision after whitespace normalization', () => {
    const hash1 = computeContentHash('  hello  world  \n\n  foo  bar  ');
    const hash2 = computeContentHash('hello world foo bar');
    expect(hash1).toBe(hash2);
  });

  // -----------------------------------------------------------------------
  // Multiple checkpoints across iterations
  // -----------------------------------------------------------------------
  it('supports multiple checkpoints across multiple iterations', () => {
    const controller = new IterationController({ max_iterations: 3 });
    let state = controller.initializeGate('gate-multi-cp', 'doc-multi-cp');

    // Iteration 1
    state = controller.startIteration(state);
    controller.checkpoint(state, 'review_started');
    controller.recordReviewOutcome(
      state, 70, [], computeContentHash('cp-v1'), 'changes_requested'
    );
    controller.checkpoint(state, 'review_completed');
    controller.checkpoint(state, 'decision');

    // Iteration 2
    state = controller.startIteration(state);
    controller.checkpoint(state, 'review_started');

    expect(state.checkpoints.length).toBe(4);

    const restored = controller.restoreFromCheckpoint('gate-multi-cp');
    expect(restored).not.toBeNull();
    expect(restored!.checkpoints.length).toBe(4);
  });

  // -----------------------------------------------------------------------
  // Approved immediately terminates without further checks
  // -----------------------------------------------------------------------
  it('approved outcome terminates immediately without stagnation check', () => {
    const controller = new IterationController();
    let state = controller.initializeGate('gate-approved-fast', 'doc-approved-fast');

    state = controller.startIteration(state);
    const decision = controller.recordReviewOutcome(
      state,
      95,
      [],
      computeContentHash('excellent-doc'),
      'approved'
    );

    expect(decision.should_continue).toBe(false);
    expect(decision.outcome).toBe('approved');
    expect(decision.stagnation_warning).toBe(false);
    expect(decision.quality_regression).toBeNull();
    expect(decision.identical_revision).toBe(false);
  });
});
