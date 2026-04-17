/**
 * DigestScheduler for daily pipeline digest generation and delivery.
 *
 * Generates and delivers summary reports at a configurable time each day.
 * Uses setTimeout-based scheduling with drift mitigation: after each
 * execution, calculateNextRun is called again to compute the exact delay
 * for the next day, preventing accumulated drift.
 *
 * Implements SPEC-008-5-02, Task 5.
 *
 * @module digest_scheduler
 */

import type { Repository } from '../db/repository';
import type {
  ChannelType,
  FormattedMessage,
  IntakeAdapter,
  MessageTarget,
} from '../adapters/adapter_interface';
import type { NotificationFormatter, DigestData } from './formatters/cli_formatter';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

/**
 * Logger interface for digest scheduler logging.
 */
export interface DigestLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

/**
 * Default no-op logger used when no logger is provided.
 */
const nullLogger: DigestLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ---------------------------------------------------------------------------
// DigestConfig interface
// ---------------------------------------------------------------------------

/**
 * Configuration for the daily digest scheduler.
 */
export interface DigestConfig {
  /** Time to send the digest in "HH:MM" format, e.g., "09:00". */
  daily_digest_time: string;
  /** Channel type to deliver the digest through. */
  channel_type: string;
  /** Platform-specific channel ID to deliver the digest to. */
  daily_digest_channel: string;
}

// ---------------------------------------------------------------------------
// DigestScheduler class
// ---------------------------------------------------------------------------

/**
 * Schedules and delivers daily pipeline digest reports.
 *
 * The scheduler calculates the next run time based on the configured
 * daily_digest_time, generates a digest from the database, formats it
 * using the appropriate channel formatter, and delivers it via the
 * corresponding adapter.
 *
 * Timer drift mitigation: after each execution, `calculateNextRun` is
 * called again to compute the exact delay for the next day, preventing
 * accumulated drift.
 */
export class DigestScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private db: Repository,
    private adapters: Map<ChannelType, IntakeAdapter>,
    private formatters: Map<ChannelType, NotificationFormatter>,
    private logger: DigestLogger = nullLogger,
  ) {}

  /**
   * Start the digest scheduler. Computes the delay until the next
   * configured time and sets a timeout to generate and deliver the digest.
   *
   * After each execution, the scheduler reschedules itself for the next
   * day to prevent accumulated timer drift.
   *
   * @param config - Digest configuration with time, channel, and target.
   */
  start(config: DigestConfig): void {
    const nextRunMs = this.calculateNextRun(config.daily_digest_time);
    this.logger.info('Digest scheduler started', {
      nextRun: new Date(Date.now() + nextRunMs).toISOString(),
      time: config.daily_digest_time,
    });

    this.timer = setTimeout(async () => {
      try {
        await this.generateAndSendDigest(config);
      } catch (error: unknown) {
        this.logger.error('Digest generation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      // Reschedule for next day
      this.start(config);
    }, nextRunMs);
  }

  /**
   * Stop the digest scheduler, clearing any pending timer.
   */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Generate the digest from the database and deliver it to the
   * configured channel.
   *
   * If the digest is empty (no activity in the last 24 hours), delivery
   * is skipped. If the formatter or adapter for the configured channel
   * type is unavailable, a warning is logged and no crash occurs.
   *
   * @param config - Digest configuration.
   */
  async generateAndSendDigest(config: DigestConfig): Promise<void> {
    const digest = await this.buildDigest();

    // Skip if no activity in the last 24 hours
    if (this.isEmptyDigest(digest)) {
      this.logger.info('Digest skipped: no activity in last 24 hours');
      return;
    }

    const target: MessageTarget = {
      channelType: config.channel_type as ChannelType,
      platformChannelId: config.daily_digest_channel,
    };

    const formatter = this.formatters.get(target.channelType);
    if (!formatter) {
      this.logger.warn('No formatter for digest channel type', { channelType: target.channelType });
      return;
    }

    const message: FormattedMessage = formatter.formatDigest(digest);
    const adapter = this.adapters.get(target.channelType);
    if (!adapter) {
      this.logger.warn('Adapter unavailable for digest delivery', { channelType: target.channelType });
      return;
    }

    await adapter.sendMessage(target, message);
    this.logger.info('Daily digest delivered', { channelType: target.channelType });
  }

  /**
   * Build the digest data by querying the database for active-by-state
   * counts, blocked requests, requests completed in the last 24 hours,
   * and queue depth by priority.
   *
   * @returns Aggregated digest data.
   */
  private async buildDigest(): Promise<DigestData> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    return {
      generatedAt: now,
      activeByState: this.db.countRequestsByState(),
      blockedRequests: this.db.getBlockedRequests(),
      completedLast24h: this.db.getCompletedSince(yesterday),
      queueDepth: this.db.getQueuedRequestCount(),
      queueDepthByPriority: this.db.getQueuedCountByPriority(),
    };
  }

  /**
   * Calculate the delay in milliseconds until the next run at the
   * specified time.
   *
   * If the target time has already passed today, schedules for
   * tomorrow.
   *
   * @param timeStr - Time in "HH:MM" format, e.g., "09:00".
   * @returns Delay in milliseconds.
   */
  calculateNextRun(timeStr: string): number {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);

    if (target.getTime() <= now.getTime()) {
      // Already past today's time, schedule for tomorrow
      target.setDate(target.getDate() + 1);
    }

    return target.getTime() - now.getTime();
  }

  /**
   * Check if a digest contains no meaningful data.
   *
   * A digest is considered empty when there are no active (queued +
   * active + paused) requests, no blocked requests, and no requests
   * completed in the last 24 hours.
   *
   * @param digest - The digest data to check.
   * @returns True if the digest is empty.
   */
  isEmptyDigest(digest: DigestData): boolean {
    const totalActive = Object.values(digest.activeByState).reduce((a, b) => a + b, 0);
    return totalActive === 0 &&
           digest.blockedRequests.length === 0 &&
           digest.completedLast24h.length === 0;
  }
}
