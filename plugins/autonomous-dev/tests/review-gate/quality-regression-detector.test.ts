import {
  QualityRegressionDetector,
  RegressionDetectorState,
} from '../../src/review-gate/quality-regression-detector';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(
  currentIteration: number,
  scores: { iteration: number; aggregate_score: number }[]
): RegressionDetectorState {
  return {
    current_iteration: currentIteration,
    score_history: scores,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QualityRegressionDetector', () => {
  const detector = new QualityRegressionDetector();

  // -----------------------------------------------------------------------
  // Test 23: First iteration -- no regression
  // -----------------------------------------------------------------------
  test('First iteration returns null (no previous score)', () => {
    const state = makeState(1, [{ iteration: 1, aggregate_score: 75 }]);
    const result = detector.detect(state);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 24: Score drop within margin
  // -----------------------------------------------------------------------
  test('Score drop within margin (4 points, margin 5) returns null', () => {
    const state = makeState(2, [
      { iteration: 1, aggregate_score: 80 },
      { iteration: 2, aggregate_score: 76 },
    ]);
    const result = detector.detect(state);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 25: Score drop exactly at margin
  // -----------------------------------------------------------------------
  test('Score drop exactly at margin (5 points, margin 5) returns null', () => {
    const state = makeState(2, [
      { iteration: 1, aggregate_score: 80 },
      { iteration: 2, aggregate_score: 75 },
    ]);
    const result = detector.detect(state);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 26: Score drop exceeding margin
  // -----------------------------------------------------------------------
  test('Score drop exceeding margin (6 points, margin 5) returns QualityRegression', () => {
    const state = makeState(2, [
      { iteration: 1, aggregate_score: 80 },
      { iteration: 2, aggregate_score: 74 },
    ]);
    const result = detector.detect(state);
    expect(result).not.toBeNull();
    expect(result!.previous_score).toBe(80);
    expect(result!.current_score).toBe(74);
    expect(result!.delta).toBe(-6);
    expect(result!.rollback_recommended).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Test 27: Score improves -- no regression
  // -----------------------------------------------------------------------
  test('Score improvement returns null', () => {
    const state = makeState(2, [
      { iteration: 1, aggregate_score: 75 },
      { iteration: 2, aggregate_score: 82 },
    ]);
    const result = detector.detect(state);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 28: Custom margin
  // -----------------------------------------------------------------------
  test('Custom margin 10: drop of 11 flagged, drop of 9 not flagged', () => {
    const detectorCustom = new QualityRegressionDetector({ margin: 10 });

    // Drop of 11 -- should be flagged
    const stateDropped = makeState(2, [
      { iteration: 1, aggregate_score: 80 },
      { iteration: 2, aggregate_score: 69 },
    ]);
    const resultDropped = detectorCustom.detect(stateDropped);
    expect(resultDropped).not.toBeNull();
    expect(resultDropped!.delta).toBe(-11);

    // Drop of 9 -- should NOT be flagged
    const stateOk = makeState(2, [
      { iteration: 1, aggregate_score: 80 },
      { iteration: 2, aggregate_score: 71 },
    ]);
    const resultOk = detectorCustom.detect(stateOk);
    expect(resultOk).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Test 28b: Custom margin via detect parameter override
  // -----------------------------------------------------------------------
  test('Custom margin passed to detect() overrides constructor config', () => {
    const defaultDetector = new QualityRegressionDetector(); // margin: 5

    // Drop of 8, default margin 5 would flag it, but override margin 10 should not
    const state = makeState(2, [
      { iteration: 1, aggregate_score: 80 },
      { iteration: 2, aggregate_score: 72 },
    ]);
    const result = defaultDetector.detect(state, { margin: 10 });
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Edge: Empty score history
  // -----------------------------------------------------------------------
  test('Empty score history returns null', () => {
    const state = makeState(2, []);
    const result = detector.detect(state);
    expect(result).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Edge: Score flat (no drop)
  // -----------------------------------------------------------------------
  test('Score flat (80 -> 80) returns null', () => {
    const state = makeState(2, [
      { iteration: 1, aggregate_score: 80 },
      { iteration: 2, aggregate_score: 80 },
    ]);
    const result = detector.detect(state);
    expect(result).toBeNull();
  });
});
