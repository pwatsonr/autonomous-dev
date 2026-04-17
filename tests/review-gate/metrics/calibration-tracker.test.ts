/**
 * Unit tests for CalibrationTracker (SPEC-004-4-3, Task 8).
 *
 * Covers all 14 test cases from the spec (numbered 1-14):
 *  1. No events -- score 0, action remove_from_pool
 *  2. All confirmed -- score 1.0, action no_action
 *  3. All misses -- score -1.0, action remove_from_pool
 *  4. Mixed events -- score 0.6, action monitor
 *  5. Score at 0.7 boundary -- action no_action
 *  6. Score at 0.4 boundary -- action monitor
 *  7. Score at 0.1 boundary -- action review_prompt
 *  8. Score below 0.1 -- action remove_from_pool
 *  9. Rolling window: 60 events, window 50, only last 50 used
 * 10. Rolling window slides: event 51 drops event 1
 * 11. Multiple reviewers tracked independently
 * 12. Record confirmed finding: event added, score increases
 * 13. Record miss: event added, score decreases
 * 14. Custom thresholds: score 0.75 gets monitor with no_action_min 0.8
 */

import {
  CalibrationTracker,
  InMemoryMetricsStore,
  computeCalibrationScore,
  determineAction,
} from '../../../src/review-gate/metrics/calibration-tracker';
import type {
  CalibrationEvent,
  CalibrationTrackerConfig,
  MetricsStore,
} from '../../../src/review-gate/metrics/calibration-tracker';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a CalibrationEvent for testing. */
function makeEvent(
  reviewerId: string,
  eventType: 'confirmed_finding' | 'miss',
  index: number = 0,
): CalibrationEvent {
  return {
    reviewer_id: reviewerId,
    event_type: eventType,
    gate_id: `gate-${index}`,
    timestamp: new Date(Date.now() + index * 1000).toISOString(),
    details: `Test event ${index}`,
  };
}

/** Seed a store with N events of a specific type for a reviewer. */
function seedEvents(
  store: MetricsStore,
  reviewerId: string,
  confirmedCount: number,
  missCount: number,
): void {
  let index = 0;
  for (let i = 0; i < confirmedCount; i++) {
    store.appendEvent(reviewerId, makeEvent(reviewerId, 'confirmed_finding', index++));
  }
  for (let i = 0; i < missCount; i++) {
    store.appendEvent(reviewerId, makeEvent(reviewerId, 'miss', index++));
  }
}

/** Seed a store with interleaved events in a specific order. */
function seedEventsOrdered(
  store: MetricsStore,
  reviewerId: string,
  pattern: ('confirmed_finding' | 'miss')[],
): void {
  pattern.forEach((eventType, index) => {
    store.appendEvent(reviewerId, makeEvent(reviewerId, eventType, index));
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CalibrationTracker', () => {
  let store: InMemoryMetricsStore;
  let tracker: CalibrationTracker;

  beforeEach(() => {
    store = new InMemoryMetricsStore();
    tracker = new CalibrationTracker(store);
  });

  // -----------------------------------------------------------------------
  // Test 1: No events -- score 0
  // -----------------------------------------------------------------------
  test('1. No events -- score 0: new reviewer gets score 0 and remove_from_pool', () => {
    const record = tracker.getCalibrationRecord('reviewer-new');

    expect(record.calibration_score).toBe(0);
    expect(record.action).toBe('remove_from_pool');
    expect(record.total_reviews).toBe(0);
    expect(record.confirmed_findings).toBe(0);
    expect(record.misses).toBe(0);
    expect(record.window_size).toBe(0);
    expect(record.events).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // Test 2: All confirmed -- score 1.0
  // -----------------------------------------------------------------------
  test('2. All confirmed -- score 1.0: 10 events all confirmed_finding', () => {
    seedEvents(store, 'reviewer-a', 10, 0);

    const record = tracker.getCalibrationRecord('reviewer-a');

    expect(record.calibration_score).toBe(1.0);
    expect(record.action).toBe('no_action');
    expect(record.total_reviews).toBe(10);
    expect(record.confirmed_findings).toBe(10);
    expect(record.misses).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Test 3: All misses -- score -1.0
  // -----------------------------------------------------------------------
  test('3. All misses -- score -1.0: 10 events all miss', () => {
    seedEvents(store, 'reviewer-a', 0, 10);

    const record = tracker.getCalibrationRecord('reviewer-a');

    expect(record.calibration_score).toBe(-1.0);
    expect(record.action).toBe('remove_from_pool');
    expect(record.total_reviews).toBe(10);
    expect(record.confirmed_findings).toBe(0);
    expect(record.misses).toBe(10);
  });

  // -----------------------------------------------------------------------
  // Test 4: Mixed events -- score 0.6
  // -----------------------------------------------------------------------
  test('4. Mixed events -- score 0.6: 10 events (8 confirmed, 2 misses)', () => {
    seedEvents(store, 'reviewer-a', 8, 2);

    const record = tracker.getCalibrationRecord('reviewer-a');

    // (8 - 2) / 10 = 0.6
    expect(record.calibration_score).toBe(0.6);
    expect(record.action).toBe('monitor');
  });

  // -----------------------------------------------------------------------
  // Test 5: Score at 0.7 boundary
  // -----------------------------------------------------------------------
  test('5. Score at 0.7 boundary: (17-3)/20 = 0.7 => no_action', () => {
    seedEvents(store, 'reviewer-a', 17, 3);

    const record = tracker.getCalibrationRecord('reviewer-a');

    // (17 - 3) / 20 = 0.7
    expect(record.calibration_score).toBe(0.7);
    expect(record.action).toBe('no_action');
  });

  // -----------------------------------------------------------------------
  // Test 6: Score at 0.4 boundary
  // -----------------------------------------------------------------------
  test('6. Score at 0.4 boundary: (14-6)/20 = 0.4 => monitor', () => {
    seedEvents(store, 'reviewer-a', 14, 6);

    const record = tracker.getCalibrationRecord('reviewer-a');

    // (14 - 6) / 20 = 0.4
    expect(record.calibration_score).toBe(0.4);
    expect(record.action).toBe('monitor');
  });

  // -----------------------------------------------------------------------
  // Test 7: Score at 0.1 boundary
  // -----------------------------------------------------------------------
  test('7. Score at 0.1 boundary: (11-9)/20 = 0.1 => review_prompt', () => {
    seedEvents(store, 'reviewer-a', 11, 9);

    const record = tracker.getCalibrationRecord('reviewer-a');

    // (11 - 9) / 20 = 0.1
    expect(record.calibration_score).toBe(0.1);
    expect(record.action).toBe('review_prompt');
  });

  // -----------------------------------------------------------------------
  // Test 8: Score below 0.1
  // -----------------------------------------------------------------------
  test('8. Score below 0.1: (10-10)/20 = 0.0 => remove_from_pool', () => {
    seedEvents(store, 'reviewer-a', 10, 10);

    const record = tracker.getCalibrationRecord('reviewer-a');

    // (10 - 10) / 20 = 0.0
    expect(record.calibration_score).toBe(0);
    expect(record.action).toBe('remove_from_pool');
  });

  // -----------------------------------------------------------------------
  // Test 9: Rolling window -- 60 events, window 50
  // -----------------------------------------------------------------------
  test('9. Rolling window: 60 events, window 50, only last 50 used', () => {
    // First 10 events are all misses
    seedEventsOrdered(store, 'reviewer-a', [
      ...Array(10).fill('miss' as const),
      ...Array(50).fill('confirmed_finding' as const),
    ]);

    const record = tracker.getCalibrationRecord('reviewer-a');

    // Window = last 50 events = all confirmed_finding
    // Score = (50 - 0) / 50 = 1.0
    expect(record.calibration_score).toBe(1.0);
    expect(record.total_reviews).toBe(60);
    expect(record.window_size).toBe(50);
    expect(record.action).toBe('no_action');
  });

  // -----------------------------------------------------------------------
  // Test 10: Rolling window slides
  // -----------------------------------------------------------------------
  test('10. Rolling window slides: adding event 51 drops event 1', () => {
    // Seed 50 events: first event is a miss, rest are confirmed
    seedEventsOrdered(store, 'reviewer-b', [
      'miss' as const,
      ...Array(49).fill('confirmed_finding' as const),
    ]);

    // Window = all 50 events: 49 confirmed, 1 miss
    // Score = (49 - 1) / 50 = 0.96
    const recordWith50 = tracker.getCalibrationRecord('reviewer-b');
    expect(recordWith50.calibration_score).toBe(0.96);

    // Add event 51 (confirmed). The miss (event 1) drops out.
    store.appendEvent('reviewer-b', makeEvent('reviewer-b', 'confirmed_finding', 50));

    // New window = events 2-51: 50 confirmed, 0 misses
    // Score = (50 - 0) / 50 = 1.0
    const recordWith51 = tracker.getCalibrationRecord('reviewer-b');
    expect(recordWith51.calibration_score).toBe(1.0);
    expect(recordWith51.total_reviews).toBe(51);
    expect(recordWith51.window_size).toBe(50);
  });

  // -----------------------------------------------------------------------
  // Test 11: Multiple reviewers tracked independently
  // -----------------------------------------------------------------------
  test('11. Multiple reviewers tracked independently', () => {
    // Reviewer A: 9 confirmed + 1 miss = (9-1)/10 = 0.8
    seedEvents(store, 'reviewer-a', 9, 1);
    // Reviewer B: 13 confirmed + 7 misses in 20 => (13-7)/20 = 0.3
    seedEvents(store, 'reviewer-b', 13, 7);

    const recordA = tracker.getCalibrationRecord('reviewer-a');
    const recordB = tracker.getCalibrationRecord('reviewer-b');

    expect(recordA.calibration_score).toBe(0.8);
    expect(recordA.action).toBe('no_action');

    expect(recordB.calibration_score).toBe(0.3);
    expect(recordB.action).toBe('review_prompt');

    // Verify they are independent
    expect(recordA.total_reviews).toBe(10);
    expect(recordB.total_reviews).toBe(20);
  });

  // -----------------------------------------------------------------------
  // Test 12: Record confirmed finding
  // -----------------------------------------------------------------------
  test('12. Record confirmed finding: event added, score increases', () => {
    // Start with 5 confirmed + 5 misses => score = 0
    seedEvents(store, 'reviewer-a', 5, 5);
    const scoreBefore = tracker.getCalibrationRecord('reviewer-a').calibration_score;
    expect(scoreBefore).toBe(0);

    // Record a confirmed finding
    tracker.recordConfirmedFinding('reviewer-a', 'gate-new', 'Finding confirmed by downstream');

    const recordAfter = tracker.getCalibrationRecord('reviewer-a');
    // Now 6 confirmed + 5 misses = (6-5)/11 = 0.091 (rounded to 0.091)
    expect(recordAfter.calibration_score).toBeGreaterThan(scoreBefore);
    expect(recordAfter.total_reviews).toBe(11);
    expect(recordAfter.confirmed_findings).toBe(6);
  });

  // -----------------------------------------------------------------------
  // Test 13: Record miss
  // -----------------------------------------------------------------------
  test('13. Record miss: event added, score decreases', () => {
    // Start with 5 confirmed + 5 misses => score = 0
    seedEvents(store, 'reviewer-a', 5, 5);
    const scoreBefore = tracker.getCalibrationRecord('reviewer-a').calibration_score;
    expect(scoreBefore).toBe(0);

    // Record a miss
    tracker.recordMiss('reviewer-a', 'gate-new', 'Approved document triggered backward cascade');

    const recordAfter = tracker.getCalibrationRecord('reviewer-a');
    // Now 5 confirmed + 6 misses = (5-6)/11 = -0.091
    expect(recordAfter.calibration_score).toBeLessThan(scoreBefore);
    expect(recordAfter.total_reviews).toBe(11);
    expect(recordAfter.misses).toBe(6);
  });

  // -----------------------------------------------------------------------
  // Test 14: Custom thresholds
  // -----------------------------------------------------------------------
  test('14. Custom thresholds: score 0.75 gets monitor with no_action_min 0.8', () => {
    const customConfig: CalibrationTrackerConfig = {
      window_size: 50,
      action_thresholds: {
        no_action_min: 0.8,
        monitor_min: 0.4,
        review_prompt_min: 0.1,
      },
    };

    const customTracker = new CalibrationTracker(store, customConfig);

    // With 8 events: (7-1)/8 = 0.75
    seedEvents(store, 'reviewer-a', 7, 1);

    const record = customTracker.getCalibrationRecord('reviewer-a');

    expect(record.calibration_score).toBe(0.75);
    // With default thresholds, 0.75 >= 0.7 => no_action
    // With custom thresholds, 0.75 < 0.8 => monitor
    expect(record.action).toBe('monitor');
  });
});

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('computeCalibrationScore', () => {
  test('returns 0 for empty events', () => {
    expect(computeCalibrationScore([], 50)).toBe(0);
  });

  test('computes score correctly with fewer events than window', () => {
    const events: CalibrationEvent[] = [
      makeEvent('r', 'confirmed_finding', 0),
      makeEvent('r', 'confirmed_finding', 1),
      makeEvent('r', 'miss', 2),
    ];
    // (2 - 1) / 3 = 0.333
    expect(computeCalibrationScore(events, 50)).toBe(0.333);
  });

  test('clamps score to -1.0 minimum', () => {
    // All misses can only produce -1.0 at most
    const events = Array.from({ length: 5 }, (_, i) => makeEvent('r', 'miss', i));
    expect(computeCalibrationScore(events, 50)).toBe(-1.0);
  });

  test('clamps score to +1.0 maximum', () => {
    const events = Array.from({ length: 5 }, (_, i) => makeEvent('r', 'confirmed_finding', i));
    expect(computeCalibrationScore(events, 50)).toBe(1.0);
  });
});

describe('determineAction', () => {
  const thresholds = {
    no_action_min: 0.7,
    monitor_min: 0.4,
    review_prompt_min: 0.1,
  };

  test.each([
    [1.0, 'no_action'],
    [0.7, 'no_action'],
    [0.69, 'monitor'],
    [0.4, 'monitor'],
    [0.39, 'review_prompt'],
    [0.1, 'review_prompt'],
    [0.09, 'remove_from_pool'],
    [0.0, 'remove_from_pool'],
    [-0.5, 'remove_from_pool'],
    [-1.0, 'remove_from_pool'],
  ])('score %s => action %s', (score, expectedAction) => {
    expect(determineAction(score, thresholds)).toBe(expectedAction);
  });
});
