import type { DndConfig, NotificationPayload } from './types';

/**
 * Injectable clock interface for testability.
 */
export interface Clock {
  now(): Date;
}

/**
 * Do Not Disturb filter.
 *
 * Suppresses non-immediate notifications during configured DND hours.
 * `immediate` urgency always breaks through regardless of DND state.
 *
 * Supports overnight windows that cross midnight (e.g., 22:00 to 07:00)
 * and timezone-aware evaluation via the configured IANA timezone.
 */
export class DndFilter {
  private pendingQueue: NotificationPayload[] = [];

  constructor(
    private config: DndConfig,
    private clock: Clock,
  ) {}

  /**
   * Check if a notification should be suppressed.
   *
   * `immediate` urgency is NEVER suppressed, regardless of DND.
   * All other urgencies are suppressed when inside the DND window.
   */
  shouldSuppress(payload: NotificationPayload): boolean {
    if (payload.urgency === 'immediate') {
      return false;
    }
    return this.isInDndWindow();
  }

  /**
   * Queue a suppressed notification for post-DND delivery.
   */
  queue(payload: NotificationPayload): void {
    this.pendingQueue.push(payload);
  }

  /**
   * Flush all queued notifications (called when DND ends).
   * Returns the queued notifications and clears the internal queue.
   */
  flush(): NotificationPayload[] {
    const flushed = [...this.pendingQueue];
    this.pendingQueue = [];
    return flushed;
  }

  /**
   * Check if the current time falls within the DND window.
   *
   * Handles two cases:
   *   - Same-day window (start < end): e.g., 12:00 to 13:00
   *   - Overnight window (start > end): e.g., 22:00 to 07:00
   *
   * Uses strict start-inclusive, end-exclusive comparison.
   */
  isInDndWindow(): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const now = this.clock.now();
    const currentTime = formatAsHHMM(now, this.config.timezone);

    const start = this.config.startTime;
    const end = this.config.endTime;

    // Overnight window (crosses midnight)
    if (start > end) {
      return currentTime >= start || currentTime < end;
    }

    // Same-day window
    return currentTime >= start && currentTime < end;
  }

  /**
   * Get count of queued notifications.
   */
  getQueueSize(): number {
    return this.pendingQueue.length;
  }
}

/**
 * Format a Date as "HH:MM" in the given IANA timezone.
 */
function formatAsHHMM(date: Date, timezone: string): string {
  // Use Intl.DateTimeFormat with the specified timezone to extract hours/minutes
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(date);
  const hour = parts.find(p => p.type === 'hour')?.value ?? '00';
  const minute = parts.find(p => p.type === 'minute')?.value ?? '00';

  return `${hour}:${minute}`;
}
