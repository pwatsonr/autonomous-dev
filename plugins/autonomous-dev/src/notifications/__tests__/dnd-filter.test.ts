/**
 * Unit tests for DndFilter (SPEC-009-5-7, Task 22).
 *
 * Tests cover:
 *   1.  In DND window: non-immediate suppressed
 *   2.  In DND window: immediate breaks through
 *   3.  Outside DND: not suppressed
 *   4.  Overnight window: 23:30 is in DND
 *   5.  Overnight window: 06:59 is in DND
 *   6.  Overnight window: 07:00 is NOT in DND
 *   7.  Same-day window: 12:30 in DND 12:00-13:00
 *   8.  Post-DND flush returns queued notifications
 *   9.  DND disabled never suppresses
 *   10. Timezone conversion
 */

import { DndFilter } from '../dnd-filter';
import type { Clock } from '../dnd-filter';
import type { DndConfig, NotificationPayload } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClock(dateString: string): Clock {
  return { now: () => new Date(dateString) };
}

function makePayload(
  overrides: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    notification_id: 'notif-001',
    event_type: 'pipeline_completed',
    urgency: 'informational',
    timestamp: new Date().toISOString(),
    request_id: 'req-001',
    repository: 'test-repo',
    title: 'Test notification',
    body: 'Test body',
    ...overrides,
  };
}

function makeOvernightDndConfig(
  overrides: Partial<DndConfig> = {},
): DndConfig {
  return {
    enabled: true,
    startTime: '22:00',
    endTime: '07:00',
    timezone: 'UTC',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DndFilter', () => {
  // Test Case 1: In DND window: non-immediate suppressed
  test('non-immediate notification suppressed during DND', () => {
    // 23:00 UTC is within 22:00-07:00 DND
    const clock = makeClock('2024-01-15T23:00:00.000Z');
    const filter = new DndFilter(makeOvernightDndConfig(), clock);

    const payload = makePayload({ urgency: 'informational' });

    expect(filter.shouldSuppress(payload)).toBe(true);
  });

  // Test Case 2: In DND window: immediate breaks through
  test('immediate notification NOT suppressed during DND', () => {
    const clock = makeClock('2024-01-15T23:00:00.000Z');
    const filter = new DndFilter(makeOvernightDndConfig(), clock);

    const payload = makePayload({ urgency: 'immediate' });

    expect(filter.shouldSuppress(payload)).toBe(false);
  });

  // Test Case 3: Outside DND: not suppressed
  test('notification not suppressed outside DND window', () => {
    // 10:00 UTC is outside 22:00-07:00 DND
    const clock = makeClock('2024-01-15T10:00:00.000Z');
    const filter = new DndFilter(makeOvernightDndConfig(), clock);

    const payload = makePayload({ urgency: 'informational' });

    expect(filter.shouldSuppress(payload)).toBe(false);
  });

  // Test Case 4: Overnight window: 23:30 is in DND
  test('23:30 is within overnight DND 22:00-07:00', () => {
    const clock = makeClock('2024-01-15T23:30:00.000Z');
    const filter = new DndFilter(makeOvernightDndConfig(), clock);

    expect(filter.isInDndWindow()).toBe(true);
  });

  // Test Case 5: Overnight window: 06:59 is in DND
  test('06:59 is within overnight DND 22:00-07:00', () => {
    const clock = makeClock('2024-01-15T06:59:00.000Z');
    const filter = new DndFilter(makeOvernightDndConfig(), clock);

    expect(filter.isInDndWindow()).toBe(true);
  });

  // Test Case 6: Overnight window: 07:00 is NOT in DND
  test('07:00 is outside overnight DND 22:00-07:00 (end-exclusive)', () => {
    const clock = makeClock('2024-01-15T07:00:00.000Z');
    const filter = new DndFilter(makeOvernightDndConfig(), clock);

    expect(filter.isInDndWindow()).toBe(false);
  });

  // Test Case 7: Same-day window: 12:30 in DND 12:00-13:00
  test('12:30 is within same-day DND 12:00-13:00', () => {
    const clock = makeClock('2024-01-15T12:30:00.000Z');
    const config: DndConfig = {
      enabled: true,
      startTime: '12:00',
      endTime: '13:00',
      timezone: 'UTC',
    };
    const filter = new DndFilter(config, clock);

    expect(filter.isInDndWindow()).toBe(true);
  });

  // Test Case 8: Post-DND flush returns queued notifications
  test('flush returns all queued notifications and clears queue', () => {
    const clock = makeClock('2024-01-15T23:00:00.000Z');
    const filter = new DndFilter(makeOvernightDndConfig(), clock);

    const p1 = makePayload({ notification_id: 'n1' });
    const p2 = makePayload({ notification_id: 'n2' });
    const p3 = makePayload({ notification_id: 'n3' });

    filter.queue(p1);
    filter.queue(p2);
    filter.queue(p3);

    expect(filter.getQueueSize()).toBe(3);

    const flushed = filter.flush();

    expect(flushed).toHaveLength(3);
    expect(flushed[0].notification_id).toBe('n1');
    expect(flushed[1].notification_id).toBe('n2');
    expect(flushed[2].notification_id).toBe('n3');
    expect(filter.getQueueSize()).toBe(0);
  });

  // Test Case 9: DND disabled never suppresses
  test('DND disabled never suppresses any notification', () => {
    const clock = makeClock('2024-01-15T23:00:00.000Z');
    const config: DndConfig = {
      enabled: false,
      startTime: '22:00',
      endTime: '07:00',
      timezone: 'UTC',
    };
    const filter = new DndFilter(config, clock);

    const payload = makePayload({ urgency: 'informational' });

    expect(filter.shouldSuppress(payload)).toBe(false);
    expect(filter.isInDndWindow()).toBe(false);
  });

  // Test Case 10: Timezone conversion
  test('timezone conversion: UTC clock with America/New_York DND', () => {
    // 03:00 UTC = 22:00 EST (previous day)
    // DND 22:00-07:00 in America/New_York
    // So 03:00 UTC should be in DND for ET timezone
    const clock = makeClock('2024-01-15T03:00:00.000Z');
    const config: DndConfig = {
      enabled: true,
      startTime: '22:00',
      endTime: '07:00',
      timezone: 'America/New_York',
    };
    const filter = new DndFilter(config, clock);

    // 03:00 UTC = 22:00 EST = within DND
    expect(filter.isInDndWindow()).toBe(true);
  });

  // soon urgency also suppressed during DND
  test('soon urgency suppressed during DND', () => {
    const clock = makeClock('2024-01-15T23:00:00.000Z');
    const filter = new DndFilter(makeOvernightDndConfig(), clock);

    const payload = makePayload({ urgency: 'soon' });

    expect(filter.shouldSuppress(payload)).toBe(true);
  });
});
