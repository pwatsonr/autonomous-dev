import type {
  BatchingConfig,
  NotificationEventType,
  NotificationPayload,
} from './types';
import type { DeliveryManager } from './delivery-manager';

/** Opaque timer handle returned by Timer.setTimeout. */
export type TimerHandle = unknown;

/** Injectable timer interface for deterministic testing. */
export interface Timer {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/**
 * Event types that are NEVER batched -- always delivered immediately.
 * Matches TDD Section 3.5.2 exemption rules.
 */
const EXEMPT_TYPES: ReadonlySet<NotificationEventType> = new Set([
  'escalation',
  'pipeline_failed',
]);

/**
 * Accumulates non-urgent notifications and flushes them at configurable
 * intervals or when the buffer reaches its size limit.
 *
 * Batching rules (TDD Section 3.5.2):
 *   1. Exempt types (`escalation`, `pipeline_failed`) are NEVER batched.
 *   2. `immediate` urgency is NEVER batched regardless of type.
 *   3. All other notifications are added to the buffer.
 *   4. Flush triggers:
 *      a. Timer fires at `config.flushIntervalMinutes` interval (default 60 min).
 *      b. Buffer reaches `config.maxBufferSize` (default 50 notifications).
 *   5. Flush behavior: group by `request_id` + `event_type`, then deliver
 *      each group via `deliveryManager.deliverBatch()`.
 */
export class NotificationBatcher {
  private buffer: NotificationPayload[] = [];
  private flushTimer: TimerHandle | null = null;

  constructor(
    private config: BatchingConfig,
    private deliveryManager: DeliveryManager,
    private timer: Timer,
  ) {}

  /**
   * Submit a notification for potential batching.
   *
   * Exempt types and immediate-urgency notifications bypass the buffer
   * and are delivered immediately via `deliveryManager.deliver()`.
   */
  submit(payload: NotificationPayload): void {
    // Rule 1: Exempt types are never batched
    if (EXEMPT_TYPES.has(payload.event_type)) {
      this.deliveryManager.deliver(payload);
      return;
    }

    // Rule 2: Immediate urgency is never batched
    if (payload.urgency === 'immediate') {
      this.deliveryManager.deliver(payload);
      return;
    }

    // Rule 3: Buffer the notification
    this.buffer.push(payload);

    // Start the flush timer on first buffered entry
    if (this.flushTimer === null) {
      this.startFlushTimer();
    }

    // Rule 4b: Flush when buffer reaches max size
    if (this.buffer.length >= this.config.maxBufferSize) {
      this.flush();
    }
  }

  /**
   * Force flush the buffer (e.g., at DND end or shutdown).
   * Groups buffered notifications by `request_id:event_type` and delivers
   * each group as a batch.
   */
  flush(): void {
    if (this.buffer.length === 0) {
      this.cancelFlushTimer();
      return;
    }

    const toFlush = this.buffer;
    this.buffer = [];

    // Cancel existing timer; it will restart on next buffered notification
    this.cancelFlushTimer();

    // Group by request_id + event_type
    const groups = groupForBatch(toFlush);

    for (const group of groups) {
      this.deliveryManager.deliverBatch(group);
    }
  }

  /**
   * Get current buffer size.
   */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /**
   * Cleanup: flush remaining buffer and cancel timer.
   */
  destroy(): void {
    this.flush();
    this.cancelFlushTimer();
  }

  private startFlushTimer(): void {
    const intervalMs = this.config.flushIntervalMinutes * 60 * 1000;
    this.flushTimer = this.timer.setTimeout(() => {
      this.flushTimer = null;
      this.flush();
    }, intervalMs);
  }

  private cancelFlushTimer(): void {
    if (this.flushTimer !== null) {
      this.timer.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}

/**
 * Group notifications by `request_id:event_type` for batch delivery.
 */
function groupForBatch(notifications: NotificationPayload[]): NotificationPayload[][] {
  const groups = new Map<string, NotificationPayload[]>();
  for (const n of notifications) {
    const key = `${n.request_id}:${n.event_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  return Array.from(groups.values());
}
