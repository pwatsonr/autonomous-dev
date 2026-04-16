import type { FatigueConfig, NotificationPayload } from './types';
import type { Clock } from './dnd-filter';

// Re-export Clock so consumers can import from either module
export type { Clock } from './dnd-filter';

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Per-recipient fatigue state.
 */
export interface FatigueState {
  recipientId: string;
  deliveryTimestamps: Date[];     // Sliding window entries
  fatigued: boolean;
  fatiguedSince?: Date;
  cooldownEndsAt?: Date;
}

/**
 * Result returned from `record()` when fatigue is first detected.
 */
export interface FatigueRecordResult {
  fatigued: boolean;
  metaNotification?: NotificationPayload;
}

/**
 * Monitors per-recipient notification volume using a sliding window.
 *
 * When a recipient exceeds `thresholdPerHour` notifications within a rolling
 * 1-hour window, the detector enters fatigue mode for that recipient and
 * emits a one-time meta-notification. During the subsequent cooldown period,
 * callers should buffer non-immediate notifications and deliver them as a
 * digest when the cooldown expires.
 *
 * `immediate` urgency notifications are never suppressed by fatigue --
 * the caller is responsible for checking urgency before consulting this
 * detector.
 */
export class FatigueDetector {
  private states: Map<string, FatigueState> = new Map();

  constructor(
    private config: FatigueConfig,
    private clock: Clock,
  ) {}

  /**
   * Record a notification delivery to a recipient.
   *
   * Returns a result indicating whether fatigue was just triggered and,
   * if so, includes the meta-notification payload to send.
   */
  record(recipientId: string): FatigueRecordResult {
    const state = this.getFatigueState(recipientId);
    const now = this.clock.now();

    // Add timestamp
    state.deliveryTimestamps.push(now);

    // Prune entries older than 1 hour
    const cutoff = new Date(now.getTime() - ONE_HOUR_MS);
    state.deliveryTimestamps = state.deliveryTimestamps.filter(t => t >= cutoff);

    // Check if this record call crosses the fatigue threshold
    if (
      !state.fatigued &&
      this.config.enabled &&
      state.deliveryTimestamps.length >= this.config.thresholdPerHour
    ) {
      state.fatigued = true;
      state.fatiguedSince = now;
      state.cooldownEndsAt = new Date(
        now.getTime() + this.config.cooldownMinutes * 60 * 1000,
      );

      const metaNotification = createFatigueMetaNotification(
        recipientId,
        state.deliveryTimestamps.length,
        this.config.cooldownMinutes,
        now,
      );

      return { fatigued: true, metaNotification };
    }

    return { fatigued: state.fatigued };
  }

  /**
   * Check if a recipient is currently fatigued.
   *
   * Evaluates cooldown expiration and sliding-window threshold.
   */
  isFatigued(recipientId: string): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const state = this.getFatigueState(recipientId);
    const now = this.clock.now();

    // Check if in cooldown
    if (state.fatigued && state.cooldownEndsAt && now < state.cooldownEndsAt) {
      return true;
    }

    // Check if cooldown expired
    if (state.fatigued && state.cooldownEndsAt && now >= state.cooldownEndsAt) {
      state.fatigued = false;
      state.cooldownEndsAt = undefined;
      return false;
    }

    // Check threshold against sliding window
    const cutoff = new Date(now.getTime() - ONE_HOUR_MS);
    const recentCount = state.deliveryTimestamps.filter(
      t => t >= cutoff,
    ).length;

    if (recentCount >= this.config.thresholdPerHour) {
      state.fatigued = true;
      state.fatiguedSince = now;
      state.cooldownEndsAt = new Date(
        now.getTime() + this.config.cooldownMinutes * 60 * 1000,
      );
      return true;
    }

    return false;
  }

  /**
   * Get or create fatigue state for a recipient.
   */
  getFatigueState(recipientId: string): FatigueState {
    let state = this.states.get(recipientId);
    if (!state) {
      state = {
        recipientId,
        deliveryTimestamps: [],
        fatigued: false,
      };
      this.states.set(recipientId, state);
    }
    return state;
  }
}

/**
 * Create the one-time meta-notification emitted when fatigue is first detected.
 */
function createFatigueMetaNotification(
  recipientId: string,
  count: number,
  cooldownMinutes: number,
  now: Date,
): NotificationPayload {
  return {
    notification_id: generateId(),
    event_type: 'escalation',
    urgency: 'immediate',
    timestamp: now.toISOString(),
    request_id: `fatigue-${recipientId}`,
    repository: '',
    title: 'Notification fatigue detected',
    body: `Notification fatigue detected. ${count} notifications in the last hour. Switching to digest mode for ${cooldownMinutes} minutes.`,
    metadata: {
      fatigue_recipient: recipientId,
      notification_count: count,
      cooldown_minutes: cooldownMinutes,
    },
  };
}

/**
 * Generate a simple unique ID. In production this would be a UUID v4;
 * here we use a timestamp + random suffix for simplicity without
 * adding a dependency.
 */
function generateId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}-${rand}`;
}
