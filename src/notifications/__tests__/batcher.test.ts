/**
 * Unit tests for NotificationBatcher (SPEC-009-5-7, Task 22).
 *
 * Tests cover:
 *   8.  Exempt type delivered immediately
 *   9.  Immediate urgency delivered immediately
 *   10. Non-exempt buffered
 *   11. Buffer flushed at interval
 *   12. Buffer flushed at max size
 *   13. Grouping by request_id:event_type
 *   14. Timer starts on first buffer entry
 *   15. Timer resets on flush
 *   16. Destroy cancels timer
 *   17. Destroy flushes remaining
 *   18. pipeline_failed exempt
 */

import { NotificationBatcher } from '../batcher';
import type { Timer, TimerHandle } from '../batcher';
import type { DeliveryManager } from '../delivery-manager';
import type { NotificationPayload, BatchingConfig } from '../types';

// ---------------------------------------------------------------------------
// Mock Timer
// ---------------------------------------------------------------------------

class MockTimer implements Timer {
  private callbacks: Map<number, () => void> = new Map();
  private nextId = 1;

  setTimeout(callback: () => void, _ms: number): TimerHandle {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.callbacks.delete(handle as number);
  }

  /** Fire the timer with the given handle. */
  fire(handle: number): void {
    const cb = this.callbacks.get(handle);
    if (cb) {
      this.callbacks.delete(handle);
      cb();
    }
  }

  /** Fire all pending timers. */
  fireAll(): void {
    const entries = [...this.callbacks.entries()];
    for (const [id, cb] of entries) {
      this.callbacks.delete(id);
      cb();
    }
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(
  overrides: Partial<NotificationPayload> = {},
): NotificationPayload {
  return {
    notification_id: `notif-${Math.random().toString(36).slice(2, 8)}`,
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

function makeConfig(overrides: Partial<BatchingConfig> = {}): BatchingConfig {
  return {
    flushIntervalMinutes: 60,
    maxBufferSize: 50,
    exemptTypes: ['escalation'],
    ...overrides,
  };
}

function makeMockDeliveryManager(): DeliveryManager & {
  deliverCalls: NotificationPayload[];
  deliverBatchCalls: NotificationPayload[][];
} {
  const deliverCalls: NotificationPayload[] = [];
  const deliverBatchCalls: NotificationPayload[][] = [];

  return {
    deliverCalls,
    deliverBatchCalls,
    deliver(payload: NotificationPayload) {
      deliverCalls.push(payload);
      return { success: true, method: 'cli' as const, formattedOutput: '' };
    },
    deliverBatch(payloads: NotificationPayload[]) {
      deliverBatchCalls.push(payloads);
      return { success: true, method: 'cli' as const, formattedOutput: '' };
    },
  } as unknown as DeliveryManager & {
    deliverCalls: NotificationPayload[];
    deliverBatchCalls: NotificationPayload[][];
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationBatcher', () => {
  let timer: MockTimer;
  let dm: ReturnType<typeof makeMockDeliveryManager>;

  beforeEach(() => {
    timer = new MockTimer();
    dm = makeMockDeliveryManager();
  });

  // Test Case 8: Exempt type delivered immediately
  test('exempt type (escalation) delivered immediately, not buffered', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);
    const payload = makePayload({ event_type: 'escalation' });

    batcher.submit(payload);

    expect(dm.deliverCalls).toHaveLength(1);
    expect(dm.deliverCalls[0]).toBe(payload);
    expect(batcher.getBufferSize()).toBe(0);
  });

  // Test Case 18: pipeline_failed exempt
  test('pipeline_failed delivered immediately (exempt)', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);
    const payload = makePayload({ event_type: 'pipeline_failed' });

    batcher.submit(payload);

    expect(dm.deliverCalls).toHaveLength(1);
    expect(batcher.getBufferSize()).toBe(0);
  });

  // Test Case 9: Immediate urgency delivered immediately
  test('immediate urgency delivered immediately regardless of type', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);
    const payload = makePayload({
      event_type: 'trust_level_changed',
      urgency: 'immediate',
    });

    batcher.submit(payload);

    expect(dm.deliverCalls).toHaveLength(1);
    expect(batcher.getBufferSize()).toBe(0);
  });

  // Test Case 10: Non-exempt buffered
  test('non-exempt, non-immediate notification buffered', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);
    const payload = makePayload({
      event_type: 'pipeline_completed',
      urgency: 'informational',
    });

    batcher.submit(payload);

    expect(dm.deliverCalls).toHaveLength(0);
    expect(batcher.getBufferSize()).toBe(1);
  });

  // Test Case 11: Buffer flushed at interval
  test('buffer flushed when timer fires', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);

    batcher.submit(makePayload({ urgency: 'informational' }));
    batcher.submit(makePayload({ urgency: 'informational' }));
    batcher.submit(makePayload({ urgency: 'informational' }));

    expect(batcher.getBufferSize()).toBe(3);

    // Fire the flush timer
    timer.fireAll();

    expect(batcher.getBufferSize()).toBe(0);
    expect(dm.deliverBatchCalls.length).toBeGreaterThan(0);
  });

  // Test Case 12: Buffer flushed at max size
  test('buffer flushed when max size reached', () => {
    const batcher = new NotificationBatcher(
      makeConfig({ maxBufferSize: 5 }),
      dm,
      timer,
    );

    for (let i = 0; i < 5; i++) {
      batcher.submit(makePayload({ urgency: 'informational' }));
    }

    // Buffer should have been flushed at the 5th notification
    expect(batcher.getBufferSize()).toBe(0);
    expect(dm.deliverBatchCalls.length).toBeGreaterThan(0);
  });

  // Test Case 13: Grouping by request_id:event_type
  test('flush groups notifications by request_id:event_type', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);

    batcher.submit(
      makePayload({
        request_id: 'req-1',
        event_type: 'pipeline_completed',
        urgency: 'informational',
      }),
    );
    batcher.submit(
      makePayload({
        request_id: 'req-1',
        event_type: 'pipeline_completed',
        urgency: 'informational',
      }),
    );
    batcher.submit(
      makePayload({
        request_id: 'req-2',
        event_type: 'trust_level_changed',
        urgency: 'informational',
      }),
    );
    batcher.submit(
      makePayload({
        request_id: 'req-2',
        event_type: 'trust_level_changed',
        urgency: 'informational',
      }),
    );

    batcher.flush();

    // Should produce 2 batch calls (one per group)
    expect(dm.deliverBatchCalls).toHaveLength(2);
    expect(dm.deliverBatchCalls[0]).toHaveLength(2);
    expect(dm.deliverBatchCalls[1]).toHaveLength(2);
  });

  // Test Case 14: Timer starts on first buffer entry
  test('timer starts on first buffered notification', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);

    expect(timer.pendingCount).toBe(0);

    batcher.submit(makePayload({ urgency: 'informational' }));

    expect(timer.pendingCount).toBe(1);
  });

  // Test Case 15: Timer resets on flush
  test('timer cancelled on flush, restarts on next buffered entry', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);

    batcher.submit(makePayload({ urgency: 'informational' }));
    expect(timer.pendingCount).toBe(1);

    batcher.flush();
    expect(timer.pendingCount).toBe(0);

    batcher.submit(makePayload({ urgency: 'informational' }));
    expect(timer.pendingCount).toBe(1);
  });

  // Test Case 16: Destroy cancels timer
  test('destroy cancels active timer', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);

    batcher.submit(makePayload({ urgency: 'informational' }));
    expect(timer.pendingCount).toBe(1);

    batcher.destroy();
    expect(timer.pendingCount).toBe(0);
  });

  // Test Case 17: Destroy flushes remaining
  test('destroy flushes remaining buffered notifications', () => {
    const batcher = new NotificationBatcher(makeConfig(), dm, timer);

    batcher.submit(makePayload({ urgency: 'informational' }));
    batcher.submit(makePayload({ urgency: 'informational' }));
    batcher.submit(makePayload({ urgency: 'informational' }));

    batcher.destroy();

    expect(batcher.getBufferSize()).toBe(0);
    expect(dm.deliverBatchCalls.length).toBeGreaterThan(0);
  });
});
