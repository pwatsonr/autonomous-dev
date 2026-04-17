import {
  IterationController,
  IterationState,
  computeContentHash,
} from '../../src/review-gate/iteration-controller';
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IterationController', () => {
  // -----------------------------------------------------------------------
  // Test 1: Happy path -- approved on iteration 1
  // -----------------------------------------------------------------------
  test('Happy path: approved on iteration 1', () => {
    const controller = new IterationController();
    let state = controller.initializeGate('gate-1', 'doc-1');
    state = controller.startIteration(state);

    expect(state.current_iteration).toBe(1);

    const decision = controller.recordReviewOutcome(
      state,
      90,
      [],
      computeContentHash('document content v1'),
      'approved'
    );

    expect(decision.should_continue).toBe(false);
    expect(decision.outcome).toBe('approved');
    expect(decision.identical_revision).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Test 2: Revision loop -- approved on iteration 2
  // -----------------------------------------------------------------------
  test('Revision loop: changes_requested on iteration 1, approved on iteration 2', () => {
    const controller = new IterationController();
    let state = controller.initializeGate('gate-2', 'doc-2');

    // Iteration 1: changes_requested
    state = controller.startIteration(state);
    const decision1 = controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('document content v1'),
      'changes_requested'
    );
    expect(decision1.should_continue).toBe(true);
    expect(decision1.outcome).toBe('changes_requested');

    // Iteration 2: approved
    state = controller.startIteration(state);
    const decision2 = controller.recordReviewOutcome(
      state,
      90,
      [],
      computeContentHash('document content v2 improved'),
      'approved'
    );
    expect(decision2.should_continue).toBe(false);
    expect(decision2.outcome).toBe('approved');
  });

  // -----------------------------------------------------------------------
  // Test 3: Max iterations reached
  // -----------------------------------------------------------------------
  test('Max iterations reached: 3 iterations all changes_requested => rejected', () => {
    const controller = new IterationController({ max_iterations: 3 });
    let state = controller.initializeGate('gate-3', 'doc-3');

    // Iteration 1
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      60,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('v1'),
      'changes_requested'
    );

    // Iteration 2
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      65,
      [makeFinding('f2', 's2', 'c2')],
      computeContentHash('v2'),
      'changes_requested'
    );

    // Iteration 3 (max)
    state = controller.startIteration(state);
    const decision = controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f3', 's3', 'c3')],
      computeContentHash('v3'),
      'changes_requested'
    );

    expect(decision.should_continue).toBe(false);
    expect(decision.outcome).toBe('rejected');
    expect(decision.reason).toContain('Maximum iterations');
    expect(decision.reason).toContain('3');
  });

  // -----------------------------------------------------------------------
  // Test 4: Identical revision detection
  // -----------------------------------------------------------------------
  test('Identical revision detected via content hash', () => {
    const controller = new IterationController();
    let state = controller.initializeGate('gate-4', 'doc-4');

    const hash = computeContentHash('unchanged content');

    // Iteration 1
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f1', 's1', 'c1')],
      hash,
      'changes_requested'
    );

    // Iteration 2: same hash
    state = controller.startIteration(state);
    const decision = controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f1', 's1', 'c1')],
      hash,
      'changes_requested'
    );

    expect(decision.should_continue).toBe(false);
    expect(decision.outcome).toBe('changes_requested');
    expect(decision.identical_revision).toBe(true);
    expect(decision.reason).toContain('identical');
  });

  // -----------------------------------------------------------------------
  // Test 5: Identical revision with whitespace change
  // -----------------------------------------------------------------------
  test('Identical revision with whitespace-only differences detected', () => {
    const hash1 = computeContentHash('hello   world\n\nfoo  bar');
    const hash2 = computeContentHash('hello world\nfoo bar');

    expect(hash1).toBe(hash2);

    const controller = new IterationController();
    let state = controller.initializeGate('gate-5', 'doc-5');

    // Iteration 1
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f1', 's1', 'c1')],
      hash1,
      'changes_requested'
    );

    // Iteration 2: same hash after normalization
    state = controller.startIteration(state);
    const decision = controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f1', 's1', 'c1')],
      hash2,
      'changes_requested'
    );

    expect(decision.identical_revision).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 6: Stagnation -- 1 iteration warning only
  // -----------------------------------------------------------------------
  test('Stagnation: first occurrence is a warning, should_continue is true', () => {
    const controller = new IterationController({ max_iterations: 5 });
    let state = controller.initializeGate('gate-6', 'doc-6');

    // Iteration 1: baseline
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      75,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('v1'),
      'changes_requested'
    );

    // Iteration 2: score declines => stagnation warning
    state = controller.startIteration(state);
    const decision = controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f2', 's2', 'c2')],
      computeContentHash('v2'),
      'changes_requested'
    );

    expect(decision.stagnation_warning).toBe(true);
    expect(decision.should_continue).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 7: Stagnation -- 2 consecutive forced rejection
  // -----------------------------------------------------------------------
  test('Stagnation: 2 consecutive iterations forces rejection', () => {
    const controller = new IterationController({ max_iterations: 5 });
    let state = controller.initializeGate('gate-7', 'doc-7');

    // Iteration 1
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      75,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('v1'),
      'changes_requested'
    );

    // Iteration 2: score declines (stagnation 1)
    state = controller.startIteration(state);
    const decision2 = controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f2', 's2', 'c2')],
      computeContentHash('v2'),
      'changes_requested'
    );
    expect(decision2.stagnation_warning).toBe(true);
    expect(decision2.should_continue).toBe(true);

    // Iteration 3: score declines again (stagnation 2)
    state = controller.startIteration(state);
    const decision3 = controller.recordReviewOutcome(
      state,
      65,
      [makeFinding('f3', 's3', 'c3')],
      computeContentHash('v3'),
      'changes_requested'
    );
    expect(decision3.should_continue).toBe(false);
    expect(decision3.outcome).toBe('rejected');
    expect(decision3.stagnation_warning).toBe(true);
    expect(decision3.reason).toContain('Stagnation persisted');
  });

  // -----------------------------------------------------------------------
  // Test 8: Stagnation resets if iteration improves
  // -----------------------------------------------------------------------
  test('Stagnation resets when iteration improves', () => {
    const controller = new IterationController({ max_iterations: 5 });
    let state = controller.initializeGate('gate-8', 'doc-8');

    // Iteration 1
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      75,
      [makeFinding('f1', 's1', 'c1'), makeFinding('f2', 's2', 'c2')],
      computeContentHash('v1'),
      'changes_requested'
    );

    // Iteration 2: declines (stagnation 1)
    state = controller.startIteration(state);
    const decision2 = controller.recordReviewOutcome(
      state,
      70,
      [makeFinding('f3', 's3', 'c3')],
      computeContentHash('v2'),
      'changes_requested'
    );
    expect(decision2.stagnation_warning).toBe(true);
    expect(state.stagnation_count).toBe(1);

    // Iteration 3: improves AND fewer findings => no stagnation, count resets
    state = controller.startIteration(state);
    const decision3 = controller.recordReviewOutcome(
      state,
      80,
      [],
      computeContentHash('v3'),
      'changes_requested'
    );
    expect(decision3.stagnation_warning).toBe(false);
    expect(state.stagnation_count).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 9: Checkpoint save and restore
  // -----------------------------------------------------------------------
  test('Checkpoint save and restore preserves state', () => {
    const controller = new IterationController();
    let state = controller.initializeGate('gate-9', 'doc-9');
    state = controller.startIteration(state);

    controller.recordReviewOutcome(
      state,
      78,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('v1'),
      'changes_requested'
    );

    controller.checkpoint(state, 'review_completed');

    const restored = controller.restoreFromCheckpoint('gate-9');
    expect(restored).not.toBeNull();
    expect(restored!.gate_id).toBe('gate-9');
    expect(restored!.document_id).toBe('doc-9');
    expect(restored!.current_iteration).toBe(1);
    expect(restored!.score_history).toHaveLength(1);
    expect(restored!.score_history[0].aggregate_score).toBe(78);
    expect(restored!.checkpoints).toHaveLength(1);
    expect(restored!.checkpoints[0].stage).toBe('review_completed');
  });

  // -----------------------------------------------------------------------
  // Test 10: Restore from no checkpoint
  // -----------------------------------------------------------------------
  test('restoreFromCheckpoint returns null for nonexistent gate', () => {
    const controller = new IterationController();
    const result = controller.restoreFromCheckpoint('nonexistent');
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 11: Max iterations configurable
  // -----------------------------------------------------------------------
  test('Max iterations configurable to 5', () => {
    const controller = new IterationController({ max_iterations: 5 });
    let state = controller.initializeGate('gate-11', 'doc-11');

    // Iterations 1-4: should_continue true
    for (let i = 1; i <= 4; i++) {
      state = controller.startIteration(state);
      const decision = controller.recordReviewOutcome(
        state,
        60 + i * 2, // incrementing scores to avoid stagnation
        [makeFinding(`f${i}`, `s-new-${i}`, `c-new-${i}`)],
        computeContentHash(`v${i}`),
        'changes_requested'
      );
      expect(decision.should_continue).toBe(true);
      expect(decision.outcome).toBe('changes_requested');
    }

    // Iteration 5: max reached, should_continue false
    state = controller.startIteration(state);
    const decision5 = controller.recordReviewOutcome(
      state,
      72,
      [makeFinding('f5', 's-new-5', 'c-new-5')],
      computeContentHash('v5'),
      'changes_requested'
    );
    expect(decision5.should_continue).toBe(false);
    expect(decision5.outcome).toBe('rejected');
    expect(decision5.reason).toContain('Maximum iterations');
  });

  // -----------------------------------------------------------------------
  // Test 29: Regression with auto-rollback off (from spec section 3)
  // -----------------------------------------------------------------------
  test('Regression with auto-rollback off: should_continue true, quality_regression populated', () => {
    const controller = new IterationController({
      max_iterations: 5,
      auto_rollback_on_regression: false,
    });
    let state = controller.initializeGate('gate-29', 'doc-29');

    // Iteration 1: baseline score 80
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      80,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('v1'),
      'changes_requested'
    );

    // Iteration 2: score drops to 70 (drop of 10, exceeds margin of 5)
    // Use different finding keys with fewer findings to avoid stagnation rejection
    state = controller.startIteration(state);
    const decision = controller.recordReviewOutcome(
      state,
      70,
      [],
      computeContentHash('v2'),
      'changes_requested'
    );

    expect(decision.should_continue).toBe(true);
    expect(decision.quality_regression).not.toBeNull();
    expect(decision.quality_regression!.previous_score).toBe(80);
    expect(decision.quality_regression!.current_score).toBe(70);
    expect(decision.quality_regression!.delta).toBe(-10);
    expect(decision.quality_regression!.rollback_recommended).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 30: Regression with auto-rollback on
  // -----------------------------------------------------------------------
  test('Regression with auto-rollback on: reason mentions rollback', () => {
    const controller = new IterationController({
      max_iterations: 5,
      auto_rollback_on_regression: true,
    });
    let state = controller.initializeGate('gate-30', 'doc-30');

    // Iteration 1
    state = controller.startIteration(state);
    controller.recordReviewOutcome(
      state,
      80,
      [makeFinding('f1', 's1', 'c1')],
      computeContentHash('v1'),
      'changes_requested'
    );

    // Iteration 2: regression with auto-rollback
    state = controller.startIteration(state);
    const decision = controller.recordReviewOutcome(
      state,
      70,
      [],
      computeContentHash('v2'),
      'changes_requested'
    );

    expect(decision.should_continue).toBe(true);
    expect(decision.outcome).toBe('changes_requested');
    expect(decision.reason).toContain('Rolling back');
    expect(decision.quality_regression).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Edge: startIteration throws when exceeding max
  // -----------------------------------------------------------------------
  test('startIteration throws when exceeding max_iterations', () => {
    const controller = new IterationController({ max_iterations: 2 });
    let state = controller.initializeGate('gate-edge', 'doc-edge');
    state = controller.startIteration(state); // 1
    state = controller.startIteration(state); // 2
    expect(() => controller.startIteration(state)).toThrow('exceeds max_iterations');
  });

  // -----------------------------------------------------------------------
  // Edge: initializeGate creates clean state
  // -----------------------------------------------------------------------
  test('initializeGate creates state with iteration 0 and empty histories', () => {
    const controller = new IterationController();
    const state = controller.initializeGate('gate-init', 'doc-init');

    expect(state.gate_id).toBe('gate-init');
    expect(state.document_id).toBe('doc-init');
    expect(state.current_iteration).toBe(0);
    expect(state.max_iterations).toBe(3);
    expect(state.score_history).toEqual([]);
    expect(state.finding_history).toEqual([]);
    expect(state.content_hashes).toEqual([]);
    expect(state.outcome_history).toEqual([]);
    expect(state.stagnation_count).toBe(0);
    expect(state.checkpoints).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // computeContentHash tests
  // -----------------------------------------------------------------------
  test('computeContentHash normalizes whitespace consistently', () => {
    const hash1 = computeContentHash('hello   world\n\nfoo  bar');
    const hash2 = computeContentHash('hello world\nfoo bar');
    const hash3 = computeContentHash('  hello world foo bar  ');

    expect(hash1).toBe(hash2);
    expect(hash2).toBe(hash3);
  });

  test('computeContentHash produces different hashes for different content', () => {
    const hash1 = computeContentHash('document version 1');
    const hash2 = computeContentHash('document version 2');
    expect(hash1).not.toBe(hash2);
  });
});
