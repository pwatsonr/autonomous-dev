/**
 * Dual-write MetricsEngine with graceful degradation
 * (SPEC-005-2-2 Task 4, SPEC-005-2-4 Task 8).
 *
 * Orchestrates JSONL-primary, SQLite-async-secondary dual-write for every
 * invocation metric. Provides the single entry point (`IMetricsEngine`) for
 * all metrics operations consumed by the rest of the Agent Factory.
 *
 * When SQLite is unavailable the engine enters **degraded mode**:
 *   - JSONL writes continue unchanged (always synchronous).
 *   - SQLite writes are skipped; metrics are buffered in memory (max 1000).
 *   - Anomaly detection and aggregation are paused (logged as warning).
 *   - Query API falls back: invocations from JSONL, aggregates from cache,
 *     alerts return empty with warning.
 *   - On recovery the buffer is replayed to SQLite in timestamp order.
 *
 * Exports: `MetricsEngine`, `BufferState`, `MetricsEngineOptions`, `EngineLogger`
 */

import { randomUUID } from 'crypto';

import type {
  InvocationMetric,
  AggregateMetrics,
  AggregateSnapshot,
  AlertRecord,
  QueryOptions,
  AlertQueryOptions,
  IMetricsEngine,
} from './types';
import type { JsonlWriter } from './jsonl-writer';
import type { SqliteStore } from './sqlite-store';
import type { AnomalyDetector } from './anomaly-detector';
import { MetricsAggregator } from './aggregator';
import type { ObservationTrigger } from '../improvement/observation-trigger';
import type { TriggerDecision } from '../improvement/types';

// ---------------------------------------------------------------------------
// Logger interface
// ---------------------------------------------------------------------------

export interface EngineLogger {
  warn(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

const defaultLogger: EngineLogger = {
  warn: (msg: string) => console.warn(`[metrics-engine] ${msg}`),
  info: (msg: string) => console.info(`[metrics-engine] ${msg}`),
  error: (msg: string) => console.error(`[metrics-engine] ${msg}`),
};

// ---------------------------------------------------------------------------
// BufferState (SPEC-005-2-4)
// ---------------------------------------------------------------------------

/**
 * In-memory buffer holding metrics that could not be written to SQLite.
 * Bounded to `maxSize` records; oldest records are dropped on overflow.
 */
export interface BufferState {
  records: InvocationMetric[];
  maxSize: number;
  /** Total records dropped due to buffer overflow since entering degraded mode. */
  droppedCount: number;
  /** ISO 8601 timestamp when degraded mode was entered, or null if healthy. */
  enteredDegradedAt: string | null;
}

// ---------------------------------------------------------------------------
// MetricsEngine configuration
// ---------------------------------------------------------------------------

/** Default maximum number of metrics held in the in-memory buffer. */
const DEFAULT_BUFFER_MAX_SIZE = 1000;

/** Default interval between SQLite health re-checks in degraded mode (ms). */
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000;

/** Default number of record attempts between health re-checks. */
const DEFAULT_HEALTH_CHECK_RECORD_INTERVAL = 10;

export interface MetricsEngineOptions {
  jsonlWriter: JsonlWriter;
  sqliteStore: SqliteStore;
  logger?: EngineLogger;
  /** Optional custom aggregator (defaults to 30-day window). */
  aggregator?: MetricsAggregator;
  /** Optional anomaly detector (when omitted, evaluateAnomalies returns []). */
  anomalyDetector?: AnomalyDetector;
  /** Maximum buffer size for degraded mode (default 1000). */
  bufferMaxSize?: number;
  /** Interval (ms) between SQLite health re-checks in degraded mode (default 60000). */
  healthCheckIntervalMs?: number;
  /** Number of record attempts between health re-checks in degraded mode (default 10). */
  healthCheckRecordInterval?: number;
  /** Optional observation trigger for the improvement lifecycle (SPEC-005-3-1). */
  observationTrigger?: ObservationTrigger;
}

// ---------------------------------------------------------------------------
// MetricsEngine
// ---------------------------------------------------------------------------

/** Payload emitted with the 'analysis_triggered' event. */
export interface AnalysisTriggeredEvent {
  agentName: string;
  decision: TriggerDecision;
}

/** Listener for metrics engine events. */
export type MetricsEventListener = (event: AnalysisTriggeredEvent) => void;

export class MetricsEngine implements IMetricsEngine {
  private readonly jsonlWriter: JsonlWriter;
  private readonly sqliteStore: SqliteStore;
  private readonly logger: EngineLogger;
  private readonly aggregator: MetricsAggregator;
  private readonly anomalyDetector: AnomalyDetector | null;

  // -- Observation trigger (SPEC-005-3-1) ---------------------------------

  private readonly observationTrigger: ObservationTrigger | null;

  // -- Event listeners ----------------------------------------------------

  private readonly eventListeners: Map<string, MetricsEventListener[]> = new Map();

  // -- Degraded-mode state (SPEC-005-2-4) --------------------------------

  /** Whether the SQLite store is currently available. */
  private sqliteAvailable: boolean = true;

  /** Memory buffer for metrics during degraded mode. */
  private buffer: BufferState;

  // -- Health-check cadence -----------------------------------------------

  private readonly healthCheckIntervalMs: number;
  private readonly healthCheckRecordInterval: number;
  private lastHealthCheckTime: number = Date.now();
  private recordsSinceLastHealthCheck: number = 0;

  // -- Cached aggregate snapshots (for degraded-mode fallback) ------------

  private readonly snapshotCache: Map<string, AggregateMetrics> = new Map();

  constructor(opts: MetricsEngineOptions) {
    this.jsonlWriter = opts.jsonlWriter;
    this.sqliteStore = opts.sqliteStore;
    this.logger = opts.logger ?? defaultLogger;
    this.aggregator = opts.aggregator ?? new MetricsAggregator();
    this.anomalyDetector = opts.anomalyDetector ?? null;
    this.observationTrigger = opts.observationTrigger ?? null;

    const maxSize = opts.bufferMaxSize ?? DEFAULT_BUFFER_MAX_SIZE;
    this.buffer = {
      records: [],
      maxSize,
      droppedCount: 0,
      enteredDegradedAt: null,
    };

    this.healthCheckIntervalMs =
      opts.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.healthCheckRecordInterval =
      opts.healthCheckRecordInterval ?? DEFAULT_HEALTH_CHECK_RECORD_INTERVAL;

    // Initial SQLite availability check
    this.sqliteAvailable = this.checkSqliteHealth();
    if (!this.sqliteAvailable) {
      this.enterDegradedMode();
    }
  }

  // -----------------------------------------------------------------------
  // IMetricsEngine.record()
  // -----------------------------------------------------------------------

  /**
   * Record a new invocation metric.
   *
   * 1. JSONL write (synchronous, primary) -- always, throws on failure.
   * 2. SQLite write (secondary) -- skipped and buffered when unavailable.
   * 3. Post-record hooks (aggregate + anomaly) -- paused when degraded.
   */
  record(metric: InvocationMetric): void {
    // Step 1: JSONL write (synchronous, primary — always)
    // If this fails, the exception propagates to the caller.
    this.jsonlWriter.append(metric);

    // Step 2: SQLite write (secondary)
    if (this.sqliteAvailable) {
      try {
        this.sqliteStore.insertInvocation(metric);

        // On success: replay any buffered records from a prior degraded period
        if (this.buffer.records.length > 0) {
          this.replayBuffer();
        }
      } catch (err: unknown) {
        this.logger.warn(
          `SQLite write failed, metric buffered: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.bufferRecord(metric);
        this.enterDegradedMode();
      }
    } else {
      // Degraded mode: buffer the record and periodically re-check health
      this.bufferRecord(metric);
      this.maybeRetryHealth();
    }

    // Step 3: Post-record hooks (paused in degraded mode)
    if (this.sqliteAvailable) {
      this.runPostRecordHooks(metric.agent_name);
    } else {
      this.logger.warn(
        'Anomaly detection and aggregation paused — SQLite unavailable',
      );
    }

    // Step 4: Observation trigger (SPEC-005-3-1)
    // Runs regardless of degraded mode — observation counting is independent
    if (this.observationTrigger) {
      try {
        const decision = this.observationTrigger.check(
          metric.agent_name,
          metric.agent_version,
        );
        if (decision.triggered) {
          this.emit('analysis_triggered', {
            agentName: metric.agent_name,
            decision,
          });
        }
      } catch (err: unknown) {
        this.logger.error(
          `Observation trigger failed for '${metric.agent_name}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // IMetricsEngine.getInvocations()
  // -----------------------------------------------------------------------

  /**
   * Query invocations for an agent.
   *
   * Normal mode: queries SQLite.
   * Degraded mode: falls back to JSONL reader (slower, filters in-memory).
   */
  getInvocations(
    agentName: string,
    opts?: QueryOptions,
  ): InvocationMetric[] {
    if (this.sqliteAvailable) {
      try {
        return this.sqliteStore.getInvocations(agentName, {
          since: opts?.since,
          until: opts?.until,
          domain: opts?.domain,
          limit: opts?.limit,
        });
      } catch {
        this.logger.warn(
          'SQLite query failed for getInvocations, falling back to JSONL',
        );
      }
    }

    // Fallback: read from JSONL and filter in memory
    return this.getInvocationsFromJsonl(agentName, opts);
  }

  // -----------------------------------------------------------------------
  // IMetricsEngine.getAggregate()
  // -----------------------------------------------------------------------

  /**
   * Return the latest aggregate metrics for an agent.
   *
   * Normal mode: queries the latest aggregate snapshot from SQLite and
   *              updates the cache.
   * Degraded mode: returns the last cached snapshot, or null.
   */
  getAggregate(agentName: string): AggregateMetrics | null {
    if (this.sqliteAvailable) {
      try {
        const snapshot = this.sqliteStore.getLatestSnapshot(agentName);
        if (!snapshot) return null;

        const aggregate = this.snapshotToAggregate(snapshot);
        this.snapshotCache.set(agentName, aggregate);
        return aggregate;
      } catch {
        this.logger.warn('Failed to retrieve aggregate snapshot from SQLite');
      }
    }

    // Degraded mode: return cached snapshot or null
    return this.snapshotCache.get(agentName) ?? null;
  }

  // -----------------------------------------------------------------------
  // IMetricsEngine.getAlerts()
  // -----------------------------------------------------------------------

  /**
   * Query alert records.
   *
   * Normal mode: queries SQLite.
   * Degraded mode: returns empty array with warning.
   */
  getAlerts(opts?: AlertQueryOptions): AlertRecord[] {
    if (this.sqliteAvailable) {
      try {
        return this.sqliteStore.getAlerts({
          agentName: opts?.agentName,
          severity: opts?.severity,
          activeOnly: opts?.activeOnly,
        });
      } catch {
        this.logger.warn('Failed to retrieve alerts from SQLite');
      }
    }

    this.logger.warn('Alert query unavailable — SQLite is in degraded mode');
    return [];
  }

  // -----------------------------------------------------------------------
  // IMetricsEngine.evaluateAnomalies()
  // -----------------------------------------------------------------------

  /**
   * Evaluate anomaly rules for an agent.
   *
   * Delegates to the `AnomalyDetector` when one was provided at
   * construction time.  In degraded mode this is a no-op that returns
   * an empty array.
   */
  evaluateAnomalies(agentName: string): AlertRecord[] {
    if (!this.sqliteAvailable) {
      this.logger.warn(
        `Anomaly evaluation skipped for '${agentName}' — SQLite unavailable`,
      );
      return [];
    }
    if (!this.anomalyDetector) {
      return [];
    }
    try {
      return this.anomalyDetector.evaluate(agentName);
    } catch (err: unknown) {
      this.logger.error(
        `Anomaly evaluation failed for '${agentName}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return [];
    }
  }

  // -----------------------------------------------------------------------
  // Event emitter (SPEC-005-3-1)
  // -----------------------------------------------------------------------

  /**
   * Register a listener for a named event.
   *
   * Currently supported events:
   *   - `'analysis_triggered'`: emitted when the observation trigger fires.
   */
  on(event: string, listener: MetricsEventListener): void {
    const listeners = this.eventListeners.get(event) ?? [];
    listeners.push(listener);
    this.eventListeners.set(event, listeners);
  }

  /**
   * Remove a listener for a named event.
   */
  off(event: string, listener: MetricsEventListener): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners) return;
    const index = listeners.indexOf(listener);
    if (index !== -1) {
      listeners.splice(index, 1);
    }
  }

  /**
   * Emit a named event to all registered listeners.
   * Listener errors are caught and logged (never propagated).
   */
  private emit(event: string, payload: AnalysisTriggeredEvent): void {
    const listeners = this.eventListeners.get(event);
    if (!listeners || listeners.length === 0) return;

    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (err: unknown) {
        this.logger.error(
          `Event listener error for '${event}': ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // Degraded-mode introspection (SPEC-005-2-4)
  // -----------------------------------------------------------------------

  /** Whether the engine is currently in degraded mode. */
  isDegraded(): boolean {
    return !this.sqliteAvailable;
  }

  /** Return a snapshot of the current buffer state (for diagnostics). */
  getBufferState(): Readonly<BufferState> {
    return { ...this.buffer, records: [...this.buffer.records] };
  }

  /** Return the current number of buffered (unflushed) metrics. */
  getPendingBufferSize(): number {
    return this.buffer.records.length;
  }

  /** Return whether the engine considers SQLite available. */
  isSqliteAvailable(): boolean {
    return this.sqliteAvailable;
  }

  /**
   * Manually trigger a SQLite health check and attempt recovery.
   * Returns true if SQLite is now available.
   */
  attemptRecovery(): boolean {
    if (this.sqliteAvailable) return true;
    const available = this.checkSqliteHealth();
    if (available) {
      this.recoverFromDegraded();
      return true;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Private: degraded-mode management
  // -----------------------------------------------------------------------

  private enterDegradedMode(): void {
    if (!this.sqliteAvailable) return; // already degraded
    this.sqliteAvailable = false;
    this.buffer.enteredDegradedAt = new Date().toISOString();
    this.recordsSinceLastHealthCheck = 0;
    this.lastHealthCheckTime = Date.now();
    this.logger.warn(
      `Entered degraded mode at ${this.buffer.enteredDegradedAt}`,
    );
  }

  private recoverFromDegraded(): void {
    this.logger.info('SQLite recovered — replaying buffered records');
    this.sqliteAvailable = true;
    this.replayBuffer();
    this.buffer.enteredDegradedAt = null;
    this.logger.info('Exited degraded mode');
  }

  // -----------------------------------------------------------------------
  // Private: buffer management
  // -----------------------------------------------------------------------

  /**
   * Add a metric to the in-memory buffer.  If the buffer is at capacity,
   * drop the oldest record and increment `droppedCount`.
   */
  private bufferRecord(metric: InvocationMetric): void {
    if (this.buffer.records.length >= this.buffer.maxSize) {
      this.buffer.records.shift(); // drop oldest
      this.buffer.droppedCount++;
      this.logger.warn(
        `Buffer full (${this.buffer.maxSize}): dropped oldest record ` +
          `(total dropped: ${this.buffer.droppedCount})`,
      );
    }
    this.buffer.records.push(metric);
  }

  /**
   * Replay all buffered records to SQLite in timestamp order, then clear
   * the buffer.  If any record fails, the remaining failures stay buffered.
   */
  private replayBuffer(): void {
    if (this.buffer.records.length === 0) return;

    // Sort by timestamp to guarantee insertion order
    const sorted = [...this.buffer.records].sort((a, b) =>
      a.timestamp.localeCompare(b.timestamp),
    );

    let replayed = 0;
    const failures: InvocationMetric[] = [];

    for (const record of sorted) {
      try {
        this.sqliteStore.insertInvocation(record);
        replayed++;
      } catch (err: unknown) {
        this.logger.warn(
          `Replay failed for ${record.invocation_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        failures.push(record);
      }
    }

    this.logger.info(
      `Replayed ${replayed}/${sorted.length} buffered records to SQLite`,
    );

    if (failures.length > 0) {
      this.buffer.records = failures;
      this.sqliteAvailable = false;
      this.logger.warn(
        `${failures.length} records failed replay — remaining in buffer`,
      );
    } else {
      this.buffer.records = [];
      this.buffer.droppedCount = 0;
    }
  }

  // -----------------------------------------------------------------------
  // Private: health checking
  // -----------------------------------------------------------------------

  private checkSqliteHealth(): boolean {
    try {
      return this.sqliteStore.isAvailable();
    } catch {
      return false;
    }
  }

  /**
   * Periodically re-check SQLite availability while in degraded mode.
   * Checks occur every `healthCheckIntervalMs` or every
   * `healthCheckRecordInterval` record attempts, whichever comes first.
   */
  private maybeRetryHealth(): void {
    this.recordsSinceLastHealthCheck++;
    const elapsed = Date.now() - this.lastHealthCheckTime;

    if (
      elapsed >= this.healthCheckIntervalMs ||
      this.recordsSinceLastHealthCheck >= this.healthCheckRecordInterval
    ) {
      this.lastHealthCheckTime = Date.now();
      this.recordsSinceLastHealthCheck = 0;

      const available = this.checkSqliteHealth();
      if (available) {
        this.recoverFromDegraded();
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private: post-record hooks
  // -----------------------------------------------------------------------

  /**
   * Run aggregate recomputation and anomaly evaluation after a successful
   * SQLite write.
   */
  private runPostRecordHooks(agentName: string): void {
    // Aggregate recomputation
    try {
      this.recomputeAggregate(agentName);
    } catch (err: unknown) {
      this.logger.error(
        `Post-record aggregate recomputation failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // Auto-resolve active alerts that have recovered, then evaluate new
    // anomalies (SPEC-005-2-3: auto-resolution after each invocation)
    if (this.anomalyDetector) {
      try {
        this.anomalyDetector.autoResolve(agentName);
      } catch (err: unknown) {
        this.logger.error(
          `Post-record auto-resolution failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }

      try {
        this.anomalyDetector.evaluate(agentName);
      } catch (err: unknown) {
        this.logger.error(
          `Post-record anomaly evaluation failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * Recompute aggregate metrics for an agent and store the snapshot
   * in SQLite.
   */
  private recomputeAggregate(agentName: string): void {
    const invocations = this.getInvocations(agentName);
    const aggregate = this.aggregator.compute(agentName, invocations);

    if (!aggregate) return;

    const snapshot: AggregateSnapshot = {
      snapshot_id: randomUUID(),
      agent_name: aggregate.agent_name,
      computed_at: new Date().toISOString(),
      window_days: aggregate.window_days,
      invocation_count: aggregate.invocation_count,
      approval_rate: aggregate.approval_rate,
      avg_quality_score: aggregate.avg_quality_score,
      median_quality_score: aggregate.median_quality_score,
      stddev_quality_score: aggregate.stddev_quality_score,
      avg_review_iterations: aggregate.avg_review_iterations,
      avg_wall_clock_ms: aggregate.avg_wall_clock_ms,
      avg_turns: aggregate.avg_turns,
      total_tokens: aggregate.total_tokens,
      trend_direction: aggregate.trend.direction,
      trend_slope: aggregate.trend.slope,
      trend_confidence: aggregate.trend.confidence,
      domain_breakdown: aggregate.domain_breakdown,
    };

    try {
      this.sqliteStore.insertSnapshot(snapshot);
      this.snapshotCache.set(agentName, aggregate);
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to store aggregate snapshot: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // Private: JSONL fallback reader
  // -----------------------------------------------------------------------

  /**
   * Read invocations from the JSONL file and filter in memory.
   * Used as a fallback when SQLite is unavailable.
   */
  private getInvocationsFromJsonl(
    agentName: string,
    opts?: QueryOptions,
  ): InvocationMetric[] {
    const allMetrics = this.jsonlWriter.readAll();

    let filtered = allMetrics.filter((m) => m.agent_name === agentName);

    if (opts?.since) {
      filtered = filtered.filter((m) => m.timestamp >= opts.since!);
    }
    if (opts?.until) {
      filtered = filtered.filter((m) => m.timestamp <= opts.until!);
    }
    if (opts?.domain) {
      filtered = filtered.filter((m) => m.input_domain === opts.domain);
    }
    if (opts?.environment) {
      filtered = filtered.filter((m) => m.environment === opts.environment);
    }

    // Sort descending by timestamp (matching SQLite behaviour)
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (opts?.limit && opts.limit > 0) {
      filtered = filtered.slice(0, opts.limit);
    }

    return filtered;
  }

  // -----------------------------------------------------------------------
  // Private: type conversion
  // -----------------------------------------------------------------------

  /**
   * Convert an `AggregateSnapshot` (persisted form) to an
   * `AggregateMetrics` (runtime form).
   */
  private snapshotToAggregate(snapshot: AggregateSnapshot): AggregateMetrics {
    return {
      agent_name: snapshot.agent_name,
      window_days: snapshot.window_days,
      invocation_count: snapshot.invocation_count,
      approval_rate: snapshot.approval_rate,
      avg_quality_score: snapshot.avg_quality_score,
      median_quality_score: snapshot.median_quality_score,
      stddev_quality_score: snapshot.stddev_quality_score,
      avg_review_iterations: snapshot.avg_review_iterations,
      avg_wall_clock_ms: snapshot.avg_wall_clock_ms,
      avg_turns: snapshot.avg_turns,
      total_tokens: snapshot.total_tokens,
      trend: {
        direction: snapshot.trend_direction,
        slope: snapshot.trend_slope,
        confidence: snapshot.trend_confidence,
        sample_size: snapshot.invocation_count,
        low_confidence: snapshot.invocation_count < 5,
      },
      domain_breakdown: snapshot.domain_breakdown,
    };
  }
}
