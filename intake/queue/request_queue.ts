/**
 * Priority request queue for the Intake Layer.
 *
 * Provides FIFO ordering within priority tiers (high > normal > low),
 * depth enforcement against a configurable maximum, and estimated wait
 * time based on a rolling average of completed pipeline durations.
 *
 * @module request_queue
 */

import type { Priority } from '../adapters/adapter_interface';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Configuration governing queue behavior. */
export interface QueueConfig {
  /** Maximum number of requests that can be queued simultaneously. Default: `50`. */
  max_depth: number;
}

/** Sensible defaults for queue configuration. */
export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  max_depth: 50,
};

// ---------------------------------------------------------------------------
// Entity & result types
// ---------------------------------------------------------------------------

/** A request entity as stored in the `requests` table. */
export interface RequestEntity {
  request_id: string;
  title: string;
  description: string;
  raw_input: string;
  priority: Priority;
  target_repo: string | null;
  status: string;
  current_phase: string;
  requester_id: string;
  source_channel: string;
  notification_config: string;
  deadline: string | null;
  related_tickets: string;
  technical_constraints: string | null;
  acceptance_criteria: string | null;
  created_at: string;
  updated_at: string;
}

/** Successful enqueue result. */
export interface EnqueueSuccess {
  success: true;
  requestId: string;
  /** 1-based position in the ordered queue. */
  position: number;
  /** Human-readable estimated wait time. */
  estimatedWait: string;
}

/** Failed enqueue result (queue at capacity). */
export interface EnqueueFailure {
  success: false;
  error: string;
  currentDepth: number;
}

export type EnqueueResult = EnqueueSuccess | EnqueueFailure;

// ---------------------------------------------------------------------------
// Repository contract
// ---------------------------------------------------------------------------

/**
 * Minimal repository interface consumed by the queue.
 * The concrete implementation lives in the DB layer.
 */
export interface QueueRepository {
  /** Count all requests with status = 'queued'. */
  getQueuedRequestCount(): Promise<number> | number;

  /** Insert a new request row. */
  insertRequest(request: RequestEntity): Promise<void> | void;

  /**
   * Return the 1-based position of `requestId` in the priority-ordered queue.
   *
   * Ordering:
   * ```sql
   * ORDER BY
   *   CASE priority
   *     WHEN 'high'   THEN 0
   *     WHEN 'normal'  THEN 1
   *     WHEN 'low'     THEN 2
   *   END ASC,
   *   created_at ASC
   * ```
   */
  getQueuePosition(requestId: string): Promise<number> | number;

  /**
   * Return the average total pipeline duration (in milliseconds) of the
   * last `n` completed requests, or `null` if fewer than 1 has completed.
   */
  getAveragePipelineDuration(n: number): Promise<number | null> | number | null;

  /**
   * Return the maximum number of concurrent pipeline slots, or `null`
   * if not configured.
   */
  getMaxConcurrentSlots(): Promise<number | null> | number | null;
}

// ---------------------------------------------------------------------------
// Duration formatting helper
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds into a human-readable string.
 *
 * Examples: "2h 30m", "45m", "< 1m".
 */
export function formatDuration(ms: number): string {
  if (ms <= 0) {
    return '< 1m';
  }

  const totalMinutes = Math.round(ms / 60_000);

  if (totalMinutes < 1) {
    return '< 1m';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours === 0) {
    return `${minutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}

// ---------------------------------------------------------------------------
// RequestQueue
// ---------------------------------------------------------------------------

/**
 * Priority request queue with depth enforcement and wait estimation.
 *
 * Requests are ordered by priority tier (high > normal > low), then FIFO
 * within the same tier.  Enqueueing is rejected when the queue reaches
 * `max_depth`.
 */
export class RequestQueue {
  constructor(private readonly db: QueueRepository) {}

  /**
   * Attempt to add a request to the queue.
   *
   * 1. Check current depth against `config.max_depth`.
   * 2. Insert the request row.
   * 3. Compute position and estimated wait time.
   *
   * @returns An {@link EnqueueResult} indicating success or failure.
   */
  async enqueue(
    request: RequestEntity,
    config: QueueConfig = DEFAULT_QUEUE_CONFIG,
  ): Promise<EnqueueResult> {
    const currentDepth = await this.db.getQueuedRequestCount();

    if (currentDepth >= config.max_depth) {
      return {
        success: false,
        error: `Queue is at capacity (${config.max_depth} requests).`,
        currentDepth,
      };
    }

    await this.db.insertRequest(request);

    const position = await this.db.getQueuePosition(request.request_id);
    const estimatedWait = await this.estimateWaitTime(position);

    return {
      success: true,
      requestId: request.request_id,
      position,
      estimatedWait,
    };
  }

  /**
   * Estimate the wait time for a request at the given queue position.
   *
   * Uses a rolling average of the last 20 completed pipeline durations
   * divided by the number of concurrent slots.
   *
   * @returns A human-readable duration string, or a message indicating
   *          insufficient history.
   */
  async estimateWaitTime(position: number): Promise<string> {
    const avgDuration = await this.db.getAveragePipelineDuration(20);
    const concurrentSlots = await this.db.getMaxConcurrentSlots();

    if (!avgDuration || !concurrentSlots) {
      return 'Unable to estimate (insufficient history)';
    }

    const waitMs = (position / concurrentSlots) * avgDuration;
    return formatDuration(waitMs);
  }
}
