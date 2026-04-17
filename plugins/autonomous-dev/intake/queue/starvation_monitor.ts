/**
 * Starvation prevention monitor for the request queue.
 *
 * Periodically scans for queued requests that have been waiting longer than
 * a configurable threshold, and promotes them one tier at a time:
 *
 *   low -> normal -> high
 *
 * Promotion is gated on `last_promoted_at` (falling back to `created_at`),
 * which prevents double-promotion in a single cycle: a request promoted
 * from low to normal at time T must wait another full threshold period
 * before being promoted from normal to high.
 *
 * @module starvation_monitor
 */

import type { Priority } from '../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration for the starvation monitor. */
export interface StarvationConfig {
  /** How often to check for starved requests, in milliseconds. Default: `900_000` (15 min). */
  check_interval_ms: number;
  /** How many hours a request must wait before being promoted. Default: `48`. */
  threshold_hours: number;
}

/** Sensible defaults for starvation prevention. */
export const DEFAULT_STARVATION_CONFIG: StarvationConfig = {
  check_interval_ms: 900_000,
  threshold_hours: 48,
};

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Record of a single priority promotion. */
export interface PromotionResult {
  /** The request that was promoted. */
  requestId: string;
  /** The priority before promotion. */
  fromPriority: Priority;
  /** The priority after promotion. */
  toPriority: Priority;
  /** When the promotion occurred. */
  promotedAt: Date;
}

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

/**
 * Minimal repository interface consumed by the starvation monitor.
 *
 * The promotion query corresponds to:
 * ```sql
 * UPDATE requests
 * SET priority = :toPriority,
 *     updated_at = :now,
 *     promotion_count = promotion_count + 1,
 *     last_promoted_at = :now
 * WHERE status = 'queued'
 *   AND priority = :fromPriority
 *   AND COALESCE(last_promoted_at, created_at) < :threshold
 * RETURNING request_id
 * ```
 */
export interface StarvationRepository {
  /**
   * Promote all queued requests of `fromPriority` whose last promotion
   * (or creation) timestamp is older than `threshold`.
   *
   * @returns The IDs of promoted requests.
   */
  promoteStarvedRequests(
    fromPriority: Priority,
    toPriority: Priority,
    threshold: Date,
    now: Date,
  ): Promise<string[]> | string[];
}

// ---------------------------------------------------------------------------
// StarvationMonitor
// ---------------------------------------------------------------------------

/**
 * Periodically promotes starved requests up the priority ladder.
 *
 * Usage:
 * ```ts
 * const monitor = new StarvationMonitor(repo);
 * monitor.start();          // begins periodic checks
 * const results = await monitor.promote();  // manual promotion
 * monitor.stop();           // stops periodic checks
 * ```
 */
export class StarvationMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: StarvationConfig;

  constructor(
    private readonly db: StarvationRepository,
    config: Partial<StarvationConfig> = {},
  ) {
    this.config = { ...DEFAULT_STARVATION_CONFIG, ...config };
  }

  /**
   * Start the periodic promotion check.
   *
   * Calls {@link promote} every `config.check_interval_ms` milliseconds.
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  start(config?: StarvationConfig): void {
    if (this.timer) {
      return; // already running
    }
    if (config) {
      this.config = config;
    }
    this.timer = setInterval(() => {
      void this.promote(this.config);
    }, this.config.check_interval_ms);
  }

  /**
   * Stop the periodic promotion check.
   * Safe to call even if the monitor is not running.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run a single promotion cycle.
   *
   * For each eligible tier transition (low -> normal, normal -> high),
   * promotes all queued requests whose `COALESCE(last_promoted_at, created_at)`
   * is older than `threshold_hours` ago.
   *
   * `high` is the ceiling -- it is never promoted further.
   *
   * @returns An array of {@link PromotionResult} records.
   */
  async promote(
    config: StarvationConfig = this.config,
  ): Promise<PromotionResult[]> {
    const now = new Date();
    const threshold = new Date(
      now.getTime() - config.threshold_hours * 3_600_000,
    );

    const results: PromotionResult[] = [];

    // Promote low -> normal
    const lowPromoted = await this.db.promoteStarvedRequests(
      'low',
      'normal',
      threshold,
      now,
    );
    for (const requestId of lowPromoted) {
      results.push({
        requestId,
        fromPriority: 'low',
        toPriority: 'normal',
        promotedAt: now,
      });
    }

    // Promote normal -> high
    const normalPromoted = await this.db.promoteStarvedRequests(
      'normal',
      'high',
      threshold,
      now,
    );
    for (const requestId of normalPromoted) {
      results.push({
        requestId,
        fromPriority: 'normal',
        toPriority: 'high',
        promotedAt: now,
      });
    }

    return results;
  }
}
