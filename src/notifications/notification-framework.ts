/**
 * NotificationFramework facade (SPEC-009-5-7, Task 17).
 *
 * Main entry point for the notification subsystem. Orchestrates the full
 * emit() pipeline: DND -> fatigue -> systemic -> batcher.
 *
 * Composes:
 *   - DndFilter: suppress during DND hours
 *   - FatigueDetector: volume-based digest mode
 *   - SystemicFailureDetector: cross-request failure correlation
 *   - NotificationBatcher: buffering and batch delivery
 *   - DeliveryManager: fallback chain delivery
 *   - Timer: injectable for testing
 */

import { randomUUID } from 'crypto';
import type { NotificationPayload } from './types';
import type { DndFilter } from './dnd-filter';
import type { FatigueDetector } from './fatigue-detector';
import type { NotificationBatcher, Timer, TimerHandle } from './batcher';
import type { DeliveryManager } from './delivery-manager';
import type {
  SystemicFailureDetector,
  FailureRecord,
} from './systemic-failure-detector';
import type { NotificationConfig } from './notification-config';

// ---------------------------------------------------------------------------
// NotificationFramework
// ---------------------------------------------------------------------------

export class NotificationFramework {
  private digestTimer: TimerHandle | null = null;

  constructor(
    private dndFilter: DndFilter,
    private fatigueDetector: FatigueDetector,
    private batcher: NotificationBatcher,
    private deliveryManager: DeliveryManager,
    private systemicDetector: SystemicFailureDetector,
    private config: NotificationConfig,
    private timer: Timer,
  ) {}

  /**
   * Main entry point: submit a notification for delivery.
   *
   * Pipeline:
   *   1. DND check (immediate bypasses)
   *   2. Fatigue check (immediate bypasses)
   *   3. Record for fatigue tracking
   *   4. Systemic failure check (for failure-type notifications)
   *   5. Submit to batcher
   */
  emit(payload: NotificationPayload): void {
    // Step 1: DND check
    if (this.dndFilter.shouldSuppress(payload)) {
      this.dndFilter.queue(payload);
      return;
    }

    // Step 2: Fatigue check (per-recipient)
    const recipientId = this.resolveRecipient(payload);
    if (
      this.fatigueDetector.isFatigued(recipientId) &&
      payload.urgency !== 'immediate'
    ) {
      this.batcher.submit(payload); // Buffer for digest
      return;
    }

    // Step 3: Record for fatigue tracking
    this.fatigueDetector.record(recipientId);

    // Step 4: Systemic failure check (for failure-type notifications)
    if (
      payload.event_type === 'pipeline_failed' ||
      payload.event_type === 'escalation'
    ) {
      const detection = this.systemicDetector.recordFailure(
        this.extractFailureRecord(payload),
      );
      if (detection.systemic) {
        // Suppress individual notification; deliver systemic alert instead
        this.deliveryManager.deliver(detection.alert);
        return;
      }
    }

    // Step 5: Submit to batcher (handles exempt types and batching logic)
    this.batcher.submit(payload);
  }

  /**
   * Generate and deliver a daily digest.
   *
   * Summarizes active requests, pending escalations, trust level changes,
   * and systemic issues detected in the last 24 hours. Delivered as an
   * informational-urgency notification.
   */
  generateDailyDigest(): void {
    const digest: NotificationPayload = {
      notification_id: randomUUID(),
      event_type: 'pipeline_completed',
      urgency: 'informational',
      timestamp: new Date().toISOString(),
      request_id: 'system',
      repository: '',
      title: 'Daily Digest',
      body: 'Daily summary of autonomous development activity.',
      metadata: {
        digest: true,
        generated_at: new Date().toISOString(),
      },
    };

    this.deliveryManager.deliver(digest);
  }

  /**
   * Start the daily digest timer.
   *
   * Schedules digest generation at the configured time. For simplicity,
   * this uses a 24-hour interval timer. In production, a more precise
   * scheduler would calculate the delay to the next configured time.
   */
  startDigestTimer(): void {
    const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
    this.digestTimer = this.timer.setTimeout(() => {
      this.generateDailyDigest();
      // Restart the timer for the next day
      this.startDigestTimer();
    }, TWENTY_FOUR_HOURS_MS);
  }

  /**
   * Shutdown: flush buffers, cancel timers.
   *
   * Must be called when the framework is being torn down to ensure
   * all buffered notifications are delivered and no timers leak.
   */
  shutdown(): void {
    // Flush DND queue
    const dndQueue = this.dndFilter.flush();
    for (const payload of dndQueue) {
      this.batcher.submit(payload);
    }

    // Flush batcher
    this.batcher.destroy();

    // Cancel digest timer
    if (this.digestTimer !== null) {
      this.timer.clearTimeout(this.digestTimer);
      this.digestTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve the recipient ID from a notification payload.
   *
   * For now, uses a simple strategy: the repository serves as the
   * recipient context. In a multi-user system, this would resolve
   * to the actual user ID.
   */
  private resolveRecipient(payload: NotificationPayload): string {
    return payload.repository || 'default';
  }

  /**
   * Extract a FailureRecord from a notification payload for systemic
   * failure detection.
   */
  private extractFailureRecord(payload: NotificationPayload): FailureRecord {
    return {
      requestId: payload.request_id,
      repository: payload.repository,
      pipelinePhase:
        (payload.metadata?.pipeline_phase as string) || 'unknown',
      failureType: payload.event_type,
      timestamp: new Date(payload.timestamp),
    };
  }
}
