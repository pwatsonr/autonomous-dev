/**
 * ValidationStats — in-process telemetry for the validation pipeline
 * (SPEC-019-2-03, Task 5).
 *
 * Per-(point, version) counters (total / passed / failed) plus a rolling
 * window of recent latencies for p50/p95/p99 calculation. Counters are
 * monotonic; the window only affects percentile calculation. Memory is
 * bounded: 50 buckets × 1000 samples × 8 bytes ≈ 400 KB heap floor.
 *
 * `getStats()` is intended for periodic operator/dashboard polling, not
 * per-validation reads — the percentile sort is O(n log n) per bucket.
 *
 * Stats are per-process and not persisted across daemon restarts;
 * durable telemetry is owned by TDD-007 / PRD-007.
 *
 * @module intake/hooks/validation-stats
 */

/** Snapshot of one (point, version) bucket — or the aggregated `overall` row. */
export interface StatSnapshot {
  total: number;
  passed: number;
  failed: number;
  /** 0 when the window has fewer than 10 samples. */
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  /** Number of samples currently held in the rolling window (capped at windowSize). */
  windowSize: number;
}

export interface AllStats {
  /** [point][version] -> snapshot. */
  byHookPoint: Record<string, Record<string, StatSnapshot>>;
  /** Aggregate across every bucket. */
  overall: StatSnapshot;
}

/** Per-bucket internal state. Kept simple (Numbers + ring buffer). */
interface BucketState {
  total: number;
  passed: number;
  failed: number;
  /** Ring buffer of last `windowSize` durations (ms). Length only grows up to windowSize. */
  samples: number[];
  /** Next write index in `samples` (mod windowSize). */
  cursor: number;
}

/** Minimum samples before percentiles are reported (else 0 sentinel). */
export const PERCENTILE_MIN_SAMPLES = 10;

export class ValidationStats {
  private readonly buckets: Map<string, Map<string, BucketState>> = new Map();

  constructor(private readonly windowSize: number = 1000) {
    if (windowSize <= 0) throw new Error('windowSize must be > 0');
  }

  /** O(1). Updates counters and writes to the ring buffer. */
  record(point: string, version: string, isValid: boolean, durationMs: number): void {
    let perPoint = this.buckets.get(point);
    if (!perPoint) {
      perPoint = new Map();
      this.buckets.set(point, perPoint);
    }
    let bucket = perPoint.get(version);
    if (!bucket) {
      bucket = { total: 0, passed: 0, failed: 0, samples: [], cursor: 0 };
      perPoint.set(version, bucket);
    }
    bucket.total += 1;
    if (isValid) bucket.passed += 1;
    else bucket.failed += 1;

    if (bucket.samples.length < this.windowSize) {
      bucket.samples.push(durationMs);
    } else {
      bucket.samples[bucket.cursor] = durationMs;
    }
    bucket.cursor = (bucket.cursor + 1) % this.windowSize;
  }

  /**
   * Snapshot every bucket and the merged overall. O(n log n) per bucket
   * because of the percentile sort.
   */
  getStats(): AllStats {
    const byHookPoint: Record<string, Record<string, StatSnapshot>> = {};
    let aggTotal = 0;
    let aggPassed = 0;
    let aggFailed = 0;
    const mergedSamples: number[] = [];

    for (const [point, perPoint] of this.buckets.entries()) {
      byHookPoint[point] = {};
      for (const [version, bucket] of perPoint.entries()) {
        byHookPoint[point][version] = this.snapshotBucket(bucket);
        aggTotal += bucket.total;
        aggPassed += bucket.passed;
        aggFailed += bucket.failed;
        // Drain a proportional slice into mergedSamples so overall stays
        // bounded at windowSize. For typical test volumes (< windowSize total)
        // this just concatenates everything.
        for (const s of bucket.samples) {
          if (mergedSamples.length < this.windowSize) {
            mergedSamples.push(s);
          } else {
            // Reservoir-style replacement to avoid bias toward earlier buckets.
            const idx = Math.floor(Math.random() * mergedSamples.length);
            mergedSamples[idx] = s;
          }
        }
      }
    }

    const overall: StatSnapshot = {
      total: aggTotal,
      passed: aggPassed,
      failed: aggFailed,
      p50Ms: this.percentile(mergedSamples, 0.5),
      p95Ms: this.percentile(mergedSamples, 0.95),
      p99Ms: this.percentile(mergedSamples, 0.99),
      windowSize: mergedSamples.length,
    };

    return { byHookPoint, overall };
  }

  /** Wipes every bucket back to empty. */
  reset(): void {
    this.buckets.clear();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private snapshotBucket(b: BucketState): StatSnapshot {
    return {
      total: b.total,
      passed: b.passed,
      failed: b.failed,
      p50Ms: this.percentile(b.samples, 0.5),
      p95Ms: this.percentile(b.samples, 0.95),
      p99Ms: this.percentile(b.samples, 0.99),
      windowSize: b.samples.length,
    };
  }

  private percentile(samples: number[], p: number): number {
    if (samples.length < PERCENTILE_MIN_SAMPLES) return 0;
    const sorted = [...samples].sort((a, b) => a - b);
    // Nearest-rank: pick samples[ceil(p * len) - 1].
    const idx = Math.max(0, Math.ceil(p * sorted.length) - 1);
    return sorted[idx];
  }
}
