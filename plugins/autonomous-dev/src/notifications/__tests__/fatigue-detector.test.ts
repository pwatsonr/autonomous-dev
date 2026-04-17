/**
 * Unit tests for FatigueDetector (SPEC-009-5-7, Task 22).
 *
 * Tests cover:
 *   11. Below threshold: not fatigued
 *   12. At threshold: fatigued
 *   13. Meta-notification emitted on first detection
 *   14. During cooldown: fatigued
 *   15. After cooldown: not fatigued
 *   16. Window expiration resets count
 *   17. Immediate never fatigued (caller responsibility, documented here)
 *   18. Per-recipient tracking
 */

import { FatigueDetector } from '../fatigue-detector';
import type { Clock } from '../dnd-filter';
import type { FatigueConfig } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMutableClock(initialMs: number = Date.now()): Clock & {
  advance(ms: number): void;
  setTime(ms: number): void;
} {
  let currentMs = initialMs;
  return {
    now: () => new Date(currentMs),
    advance(ms: number) {
      currentMs += ms;
    },
    setTime(ms: number) {
      currentMs = ms;
    },
  };
}

function makeConfig(
  overrides: Partial<FatigueConfig> = {},
): FatigueConfig {
  return {
    enabled: true,
    thresholdPerHour: 20,
    cooldownMinutes: 30,
    ...overrides,
  };
}

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FatigueDetector', () => {
  // Test Case 11: Below threshold: not fatigued
  test('below threshold returns not fatigued', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ thresholdPerHour: 20 }),
      clock,
    );

    // Record 10 notifications (below threshold of 20)
    for (let i = 0; i < 10; i++) {
      detector.record('user-a');
    }

    expect(detector.isFatigued('user-a')).toBe(false);
  });

  // Test Case 12: At threshold: fatigued
  test('at threshold triggers fatigue', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ thresholdPerHour: 20 }),
      clock,
    );

    // Record 20 notifications (at threshold)
    for (let i = 0; i < 20; i++) {
      detector.record('user-a');
    }

    expect(detector.isFatigued('user-a')).toBe(true);
  });

  // Test Case 13: Meta-notification emitted on first detection
  test('meta-notification emitted when fatigue first detected via record()', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ thresholdPerHour: 5, cooldownMinutes: 30 }),
      clock,
    );

    // Record up to threshold
    for (let i = 0; i < 4; i++) {
      const result = detector.record('user-a');
      expect(result.metaNotification).toBeUndefined();
    }

    // 5th record crosses threshold
    const result = detector.record('user-a');
    expect(result.fatigued).toBe(true);
    expect(result.metaNotification).toBeDefined();
    expect(result.metaNotification!.urgency).toBe('immediate');
    expect(result.metaNotification!.title).toContain('fatigue');

    // 6th record should not emit another meta-notification
    const result2 = detector.record('user-a');
    expect(result2.fatigued).toBe(true);
    expect(result2.metaNotification).toBeUndefined();
  });

  // Test Case 14: During cooldown: fatigued
  test('during cooldown period, isFatigued returns true', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ thresholdPerHour: 5, cooldownMinutes: 30 }),
      clock,
    );

    for (let i = 0; i < 5; i++) {
      detector.record('user-a');
    }

    expect(detector.isFatigued('user-a')).toBe(true);

    // Advance 15 minutes (still within 30-minute cooldown)
    clock.advance(15 * ONE_MINUTE_MS);
    expect(detector.isFatigued('user-a')).toBe(true);
  });

  // Test Case 15: After cooldown: not fatigued
  test('after cooldown expires, isFatigued returns false', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ thresholdPerHour: 5, cooldownMinutes: 30 }),
      clock,
    );

    for (let i = 0; i < 5; i++) {
      detector.record('user-a');
    }

    expect(detector.isFatigued('user-a')).toBe(true);

    // Advance past cooldown (31 minutes)
    clock.advance(31 * ONE_MINUTE_MS);
    expect(detector.isFatigued('user-a')).toBe(false);
  });

  // Test Case 16: Window expiration resets count
  test('window expiration prunes old entries, resetting count', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ thresholdPerHour: 20, cooldownMinutes: 30 }),
      clock,
    );

    // Record 20 notifications (exactly at threshold)
    for (let i = 0; i < 20; i++) {
      detector.record('user-a');
    }

    expect(detector.isFatigued('user-a')).toBe(true);

    // Advance clock by 61 minutes (past 1-hour window AND cooldown)
    clock.advance(61 * ONE_MINUTE_MS);

    // Old entries should be pruned on next record
    detector.record('user-a');
    // After cooldown expires, not fatigued anymore since we reset
    // But we need to check: isFatigued first clears cooldown
    // Actually, after advancing past cooldown, isFatigued clears the state
    // Then recording 1 entry (below threshold of 20) means not fatigued
    expect(detector.isFatigued('user-a')).toBe(false);
  });

  // Test Case 17: Immediate never fatigued (caller responsibility)
  test('isFatigued is independent of urgency (caller checks urgency)', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ thresholdPerHour: 5 }),
      clock,
    );

    for (let i = 0; i < 5; i++) {
      detector.record('user-a');
    }

    // isFatigued returns true regardless of what the caller plans to do
    // The caller (NotificationFramework) is responsible for bypassing
    // fatigue for immediate urgency notifications
    expect(detector.isFatigued('user-a')).toBe(true);
  });

  // Test Case 18: Per-recipient tracking
  test('per-recipient tracking: user A fatigued, user B not', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ thresholdPerHour: 5 }),
      clock,
    );

    // Fatigue user-a
    for (let i = 0; i < 5; i++) {
      detector.record('user-a');
    }

    // user-b has only 2 notifications
    detector.record('user-b');
    detector.record('user-b');

    expect(detector.isFatigued('user-a')).toBe(true);
    expect(detector.isFatigued('user-b')).toBe(false);
  });

  // Disabled fatigue detector never reports fatigued
  test('disabled detector never reports fatigued', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(
      makeConfig({ enabled: false, thresholdPerHour: 5 }),
      clock,
    );

    for (let i = 0; i < 10; i++) {
      detector.record('user-a');
    }

    expect(detector.isFatigued('user-a')).toBe(false);
  });

  // getFatigueState creates new state for unknown recipients
  test('getFatigueState creates state for unknown recipient', () => {
    const clock = makeMutableClock();
    const detector = new FatigueDetector(makeConfig(), clock);

    const state = detector.getFatigueState('new-user');

    expect(state.recipientId).toBe('new-user');
    expect(state.deliveryTimestamps).toHaveLength(0);
    expect(state.fatigued).toBe(false);
  });
});
