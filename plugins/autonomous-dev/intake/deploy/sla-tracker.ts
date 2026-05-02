/**
 * SLA rolling-window tracker (SPEC-023-3-01).
 *
 * Fixed-capacity ring buffer of `HealthSample`. Used by `HealthMonitor`
 * to compute consecutive-failure counts and uptime percent without
 * allocating on the hot path.
 *
 * Pure: no I/O, no clock dependency. The buffer is bounded so memory is
 * O(rolling_window_size).
 *
 * @module intake/deploy/sla-tracker
 */

import type { HealthSample } from './monitor-types';

export class SlaTracker {
  private readonly buf: (HealthSample | undefined)[];
  private head = 0;
  private size = 0;
  private readonly capacity: number;

  constructor(capacity: number) {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error(`SlaTracker: capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = Math.floor(capacity);
    this.buf = new Array<HealthSample | undefined>(this.capacity).fill(undefined);
  }

  /** Append a sample, evicting the oldest if at capacity. */
  record(sample: HealthSample): void {
    this.buf[this.head] = sample;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size += 1;
  }

  /**
   * Count of trailing samples (newest backwards) where `healthy === false`,
   * stopping at the first healthy sample.
   *
   * One healthy sample resets this to 0 (acceptance criterion).
   */
  consecutiveFailures(): number {
    let count = 0;
    for (let i = 0; i < this.size; i++) {
      const idx = (this.head - 1 - i + this.capacity) % this.capacity;
      const s = this.buf[idx];
      if (!s) break;
      if (s.healthy) break;
      count += 1;
    }
    return count;
  }

  /**
   * healthy / total in the window. Returns `1.0` when window is empty so
   * a freshly-started monitor reports full uptime instead of 0/0 = NaN.
   */
  uptimePct(): number {
    if (this.size === 0) return 1.0;
    let healthy = 0;
    for (let i = 0; i < this.size; i++) {
      const s = this.buf[i];
      if (s && s.healthy) healthy += 1;
    }
    return healthy / this.size;
  }

  /** Newest sample, or `undefined` when empty. Useful for `MonitorStatus`. */
  lastSample(): HealthSample | undefined {
    if (this.size === 0) return undefined;
    const idx = (this.head - 1 + this.capacity) % this.capacity;
    return this.buf[idx];
  }

  /** Current sample count in the window (≤ capacity). */
  count(): number {
    return this.size;
  }
}
