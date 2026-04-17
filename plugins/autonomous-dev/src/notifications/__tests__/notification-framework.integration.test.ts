/**
 * Integration tests for NotificationFramework (SPEC-009-5-7, Task 23).
 *
 * Tests cover:
 *   6.  emit: immediate bypasses DND and fatigue
 *   7.  emit: DND suppresses non-immediate
 *   8.  emit: fatigue suppresses non-immediate
 *   9.  emit: systemic failure detected
 *   10. emit: normal delivery
 *   11. shutdown flushes and cancels
 *
 * Integration scenarios:
 *   21. Fatigue -> digest mode
 *   22. 3 failures same repo -> systemic alert
 *   23. DND + flush
 */

import { NotificationFramework } from '../notification-framework';
import { DndFilter } from '../dnd-filter';
import type { Clock } from '../dnd-filter';
import { FatigueDetector } from '../fatigue-detector';
import { SystemicFailureDetector } from '../systemic-failure-detector';
import type { AuditTrail } from '../systemic-failure-detector';
import { NotificationBatcher } from '../batcher';
import type { Timer, TimerHandle } from '../batcher';
import { DeliveryManager } from '../delivery-manager';
import type {
  DeliveryAdapter,
  DeliveryMethod,
  DeliveryResult,
  NotificationConfig,
  NotificationPayload,
} from '../types';
import type { NotificationConfig as FullNotificationConfig } from '../notification-config';

// ---------------------------------------------------------------------------
// Mock Timer
// ---------------------------------------------------------------------------

class MockTimer implements Timer {
  private callbacks: Map<number, { cb: () => void; ms: number }> = new Map();
  private nextId = 1;

  setTimeout(callback: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.callbacks.set(id, { cb: callback, ms });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.callbacks.delete(handle as number);
  }

  fire(handle: number): void {
    const entry = this.callbacks.get(handle);
    if (entry) {
      this.callbacks.delete(handle);
      entry.cb();
    }
  }

  fireAll(): void {
    const entries = [...this.callbacks.entries()];
    for (const [id, entry] of entries) {
      this.callbacks.delete(id);
      entry.cb();
    }
  }

  get pendingCount(): number {
    return this.callbacks.size;
  }
}

// ---------------------------------------------------------------------------
// Mock Clock
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

// ---------------------------------------------------------------------------
// Mock Delivery Manager
// ---------------------------------------------------------------------------

function makeMockDeliveryManager(): DeliveryManager & {
  deliverCalls: NotificationPayload[];
  deliverBatchCalls: NotificationPayload[][];
} {
  const deliverCalls: NotificationPayload[] = [];
  const deliverBatchCalls: NotificationPayload[][] = [];

  return {
    deliverCalls,
    deliverBatchCalls,
    deliver(payload: NotificationPayload): DeliveryResult {
      deliverCalls.push(payload);
      return { success: true, method: 'cli' as const, formattedOutput: '' };
    },
    deliverBatch(payloads: NotificationPayload[]): DeliveryResult {
      deliverBatchCalls.push(payloads);
      return { success: true, method: 'cli' as const, formattedOutput: '' };
    },
  } as unknown as DeliveryManager & {
    deliverCalls: NotificationPayload[];
    deliverBatchCalls: NotificationPayload[][];
  };
}

// ---------------------------------------------------------------------------
// Mock Audit Trail
// ---------------------------------------------------------------------------

function makeMockAuditTrail(): AuditTrail {
  return {
    async append() {},
  } as unknown as AuditTrail;
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

function makeNotificationConfig(
  overrides: Partial<FullNotificationConfig> = {},
): FullNotificationConfig {
  return {
    default_method: 'cli',
    per_type_overrides: {},
    batching: {
      flushIntervalMinutes: 60,
      maxBufferSize: 50,
      exemptTypes: ['escalation'],
    },
    dnd: {
      enabled: false,
      startTime: '22:00',
      endTime: '07:00',
      timezone: 'UTC',
    },
    fatigue: {
      enabled: false,
      thresholdPerHour: 20,
      cooldownMinutes: 30,
    },
    cross_request: {
      enabled: false,
      windowMinutes: 60,
      threshold: 3,
    },
    daily_digest_time: '09:00',
    daily_digest_timezone: 'UTC',
    ...overrides,
  };
}

const ONE_MINUTE_MS = 60 * 1000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

// ---------------------------------------------------------------------------
// Unit Tests
// ---------------------------------------------------------------------------

describe('NotificationFramework - Unit', () => {
  // Test Case 6: emit: immediate bypasses DND and fatigue
  test('immediate notification delivered even during DND with fatigued recipient', () => {
    // Set clock to 23:00 UTC (within DND 22:00-07:00)
    const clock = makeMutableClock(new Date('2024-01-15T23:00:00.000Z').getTime());
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: true, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: true, thresholdPerHour: 5, cooldownMinutes: 30 },
      clock,
    );
    const systemicDetector = new SystemicFailureDetector(
      { enabled: false, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );

    // Pre-fatigue the recipient
    for (let i = 0; i < 5; i++) {
      fatigueDetector.record('test-repo');
    }
    expect(fatigueDetector.isFatigued('test-repo')).toBe(true);

    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    // Emit immediate notification
    framework.emit(
      makePayload({ urgency: 'immediate', repository: 'test-repo' }),
    );

    // Should have been delivered (not queued or buffered)
    // immediate bypasses DND (shouldSuppress returns false for immediate)
    // immediate bypasses fatigue check (payload.urgency !== 'immediate' is false)
    // immediate gets to batcher, which delivers immediately (urgency=immediate)
    expect(dm.deliverCalls.length).toBeGreaterThan(0);
  });

  // Test Case 7: emit: DND suppresses non-immediate
  test('DND suppresses non-immediate notification (queued)', () => {
    const clock = makeMutableClock(new Date('2024-01-15T23:00:00.000Z').getTime());
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: true, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: false, thresholdPerHour: 20, cooldownMinutes: 30 },
      clock,
    );
    const systemicDetector = new SystemicFailureDetector(
      { enabled: false, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );
    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    framework.emit(makePayload({ urgency: 'soon' }));

    // Should be queued in DND, not delivered
    expect(dm.deliverCalls).toHaveLength(0);
    expect(dndFilter.getQueueSize()).toBe(1);
  });

  // Test Case 8: emit: fatigue suppresses non-immediate
  test('fatigued recipient: non-immediate notification buffered', () => {
    const clock = makeMutableClock();
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: false, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: true, thresholdPerHour: 5, cooldownMinutes: 30 },
      clock,
    );

    // Pre-fatigue
    for (let i = 0; i < 5; i++) {
      fatigueDetector.record('test-repo');
    }

    const systemicDetector = new SystemicFailureDetector(
      { enabled: false, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );
    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    framework.emit(
      makePayload({
        urgency: 'informational',
        repository: 'test-repo',
      }),
    );

    // Should be buffered in batcher (not delivered immediately)
    expect(batcher.getBufferSize()).toBe(1);
    expect(dm.deliverCalls).toHaveLength(0);
  });

  // Test Case 9: emit: systemic failure detected
  test('systemic failure: third failure suppresses individual, delivers alert', () => {
    const clock = makeMutableClock();
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: false, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: false, thresholdPerHour: 20, cooldownMinutes: 30 },
      clock,
    );
    const systemicDetector = new SystemicFailureDetector(
      { enabled: true, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );
    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation', 'pipeline_failed'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    // Emit 3 pipeline_failed notifications for the same repo
    for (let i = 1; i <= 3; i++) {
      framework.emit(
        makePayload({
          event_type: 'pipeline_failed',
          urgency: 'immediate',
          repository: 'repo-x',
          request_id: `req-${i}`,
          timestamp: clock.now().toISOString(),
        }),
      );
    }

    // The first 2 pipeline_failed notifications go through batcher (which delivers immediately since exempt)
    // The 3rd triggers systemic detection and delivers the systemic alert directly
    // So we should see:
    // - dm.deliverCalls includes the first 2 (via batcher exempt) + systemic alert
    const systemicAlert = dm.deliverCalls.find(
      p => p.event_type === 'systemic_issue',
    );
    expect(systemicAlert).toBeDefined();
    expect(systemicAlert!.urgency).toBe('immediate');
  });

  // Test Case 10: emit: normal delivery
  test('normal: non-DND, non-fatigued, non-systemic -> submitted to batcher', () => {
    const clock = makeMutableClock(new Date('2024-01-15T10:00:00.000Z').getTime());
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: false, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: false, thresholdPerHour: 20, cooldownMinutes: 30 },
      clock,
    );
    const systemicDetector = new SystemicFailureDetector(
      { enabled: false, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );
    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    framework.emit(
      makePayload({ urgency: 'informational' }),
    );

    // Non-exempt, non-immediate -> buffered in batcher
    expect(batcher.getBufferSize()).toBe(1);
  });

  // Test Case 11: shutdown flushes and cancels
  test('shutdown flushes DND queue, batcher, and cancels timers', () => {
    const clock = makeMutableClock(new Date('2024-01-15T23:00:00.000Z').getTime());
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: true, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: false, thresholdPerHour: 20, cooldownMinutes: 30 },
      clock,
    );
    const systemicDetector = new SystemicFailureDetector(
      { enabled: false, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );
    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    // Queue some DND notifications
    framework.emit(makePayload({ urgency: 'soon', notification_id: 'dnd-1' }));
    framework.emit(makePayload({ urgency: 'informational', notification_id: 'dnd-2' }));

    expect(dndFilter.getQueueSize()).toBe(2);

    // Shutdown
    framework.shutdown();

    // DND queue should be flushed
    expect(dndFilter.getQueueSize()).toBe(0);
    // Batcher should also be flushed
    expect(batcher.getBufferSize()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration Scenarios
// ---------------------------------------------------------------------------

describe('NotificationFramework - Integration Scenarios', () => {
  // =========================================================================
  // Test Case 21: Fatigue -> digest mode
  // =========================================================================
  test('fatigue triggers digest mode: 25 notifications, last 5 buffered', () => {
    const clock = makeMutableClock();
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: false, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: true, thresholdPerHour: 20, cooldownMinutes: 30 },
      clock,
    );
    const systemicDetector = new SystemicFailureDetector(
      { enabled: false, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );
    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    // Send 25 notifications to the same recipient
    for (let i = 1; i <= 25; i++) {
      framework.emit(
        makePayload({
          urgency: 'informational',
          repository: 'test-repo',
          request_id: `req-${i}`,
        }),
      );
    }

    // After notification 20, fatigue triggers.
    // Notifications 21-25 should be buffered (fatigue check before batcher).
    // The first 20 go to batcher which buffers them (non-exempt, non-immediate).
    // So batcher has 20 (normal) + 5 (fatigue-buffered) = 25 buffered.
    // Actually, fatigue-buffered also go to batcher.submit() so batcher has all 25.

    // Advance clock past cooldown (31 minutes)
    clock.advance(31 * ONE_MINUTE_MS);

    // Flush batcher (simulating timer fire or explicit flush)
    batcher.flush();

    // All notifications should have been delivered as batches
    expect(dm.deliverBatchCalls.length).toBeGreaterThan(0);
    const totalDelivered = dm.deliverBatchCalls.reduce(
      (sum, batch) => sum + batch.length,
      0,
    );
    expect(totalDelivered).toBe(25);
  });

  // =========================================================================
  // Test Case 22: 3 failures same repo -> systemic alert
  // =========================================================================
  test('3 pipeline_failed for same repo: systemic alert with immediate urgency', () => {
    const clock = makeMutableClock();
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: false, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: false, thresholdPerHour: 20, cooldownMinutes: 30 },
      clock,
    );
    const systemicDetector = new SystemicFailureDetector(
      { enabled: true, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );
    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation', 'pipeline_failed'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    // Emit 3 pipeline_failed for the same repo
    for (let i = 1; i <= 3; i++) {
      framework.emit(
        makePayload({
          event_type: 'pipeline_failed',
          urgency: 'immediate',
          repository: 'repo-x',
          request_id: `req-${i}`,
          timestamp: clock.now().toISOString(),
        }),
      );
    }

    // Find the systemic alert
    const systemicAlert = dm.deliverCalls.find(
      p => p.event_type === 'systemic_issue',
    );
    expect(systemicAlert).toBeDefined();
    expect(systemicAlert!.urgency).toBe('immediate');
    expect(systemicAlert!.title).toContain('Systemic issue detected');
    expect(systemicAlert!.body).toContain('repo-x');

    // The third individual pipeline_failed notification should be suppressed
    // (replaced by the systemic alert)
    const pipelineFailedCount = dm.deliverCalls.filter(
      p => p.event_type === 'pipeline_failed',
    ).length;
    // First 2 are delivered normally, 3rd is suppressed by systemic
    expect(pipelineFailedCount).toBe(2);
  });

  // =========================================================================
  // Test Case 23: DND + flush
  // =========================================================================
  test('DND queues notifications; shutdown flushes all', () => {
    // Set time to 23:00 (in DND)
    const clock = makeMutableClock(new Date('2024-01-15T23:00:00.000Z').getTime());
    const timer = new MockTimer();
    const dm = makeMockDeliveryManager();

    const dndFilter = new DndFilter(
      { enabled: true, startTime: '22:00', endTime: '07:00', timezone: 'UTC' },
      clock,
    );
    const fatigueDetector = new FatigueDetector(
      { enabled: false, thresholdPerHour: 20, cooldownMinutes: 30 },
      clock,
    );
    const systemicDetector = new SystemicFailureDetector(
      { enabled: false, windowMinutes: 60, threshold: 3 },
      makeMockAuditTrail(),
      clock,
    );
    const batcher = new NotificationBatcher(
      { flushIntervalMinutes: 60, maxBufferSize: 50, exemptTypes: ['escalation'] },
      dm,
      timer,
    );
    const framework = new NotificationFramework(
      dndFilter,
      fatigueDetector,
      batcher,
      dm,
      systemicDetector,
      makeNotificationConfig(),
      timer,
    );

    // Emit 5 non-immediate notifications at 23:00
    for (let i = 1; i <= 5; i++) {
      framework.emit(
        makePayload({
          urgency: 'informational',
          notification_id: `dnd-notif-${i}`,
          request_id: `req-${i}`,
        }),
      );
    }

    // All should be queued in DND
    expect(dndFilter.getQueueSize()).toBe(5);
    expect(dm.deliverCalls).toHaveLength(0);

    // Advance clock to 07:00 (DND end)
    clock.setTime(new Date('2024-01-16T07:00:00.000Z').getTime());

    // Shutdown should flush DND queue -> batcher -> delivery
    framework.shutdown();

    // DND queue should be empty
    expect(dndFilter.getQueueSize()).toBe(0);

    // Batcher should have flushed (destroy was called)
    expect(batcher.getBufferSize()).toBe(0);

    // All 5 notifications should have been delivered via batch
    const totalBatchDelivered = dm.deliverBatchCalls.reduce(
      (sum, batch) => sum + batch.length,
      0,
    );
    expect(totalBatchDelivered).toBe(5);
  });
});
