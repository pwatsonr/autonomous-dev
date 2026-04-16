/**
 * SQLite store for queryable secondary metrics storage (SPEC-005-2-1, Task 3).
 *
 * Maintains 5 tables (agent_invocations, quality_dimensions, tool_calls,
 * agent_alerts, aggregate_snapshots) with WAL mode enabled for concurrent
 * read/write support.
 *
 * This module requires `better-sqlite3` at runtime.  When the dependency is
 * unavailable (e.g. in lightweight environments), construction succeeds but
 * `isAvailable()` returns false and mutation methods throw.
 */

import * as fs from 'fs';
import * as path from 'path';

import type {
  InvocationMetric,
  AlertRecord,
  AlertSeverity,
  AggregateSnapshot,
  DomainStats,
} from './types';

// ---------------------------------------------------------------------------
// Optional better-sqlite3 import
// ---------------------------------------------------------------------------

// We type the database loosely so the module compiles even when
// better-sqlite3 is not installed.  The actual import is attempted lazily
// inside `initialize()`.

/* eslint-disable @typescript-eslint/no-explicit-any */
type Database = any;
type Statement = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

let BetterSqlite3: ((...args: unknown[]) => Database) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  BetterSqlite3 = require('better-sqlite3');
} catch {
  // Module not available; isAvailable() will return false.
}

// ---------------------------------------------------------------------------
// SQL DDL
// ---------------------------------------------------------------------------

const CREATE_TABLES_SQL = `
-- Table 1: agent_invocations
CREATE TABLE IF NOT EXISTS agent_invocations (
  invocation_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  agent_version TEXT NOT NULL,
  pipeline_run_id TEXT,
  input_hash TEXT NOT NULL,
  input_domain TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_hash TEXT NOT NULL,
  output_tokens INTEGER NOT NULL,
  output_quality_score REAL NOT NULL,
  review_iteration_count INTEGER NOT NULL,
  review_outcome TEXT NOT NULL,
  reviewer_agent TEXT,
  wall_clock_ms INTEGER NOT NULL,
  turn_count INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  environment TEXT NOT NULL DEFAULT 'production'
);
CREATE INDEX IF NOT EXISTS idx_invocations_agent ON agent_invocations(agent_name);
CREATE INDEX IF NOT EXISTS idx_invocations_timestamp ON agent_invocations(timestamp);
CREATE INDEX IF NOT EXISTS idx_invocations_domain ON agent_invocations(input_domain);
CREATE INDEX IF NOT EXISTS idx_invocations_pipeline ON agent_invocations(pipeline_run_id);

-- Table 2: quality_dimensions
CREATE TABLE IF NOT EXISTS quality_dimensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL REFERENCES agent_invocations(invocation_id),
  dimension TEXT NOT NULL,
  score REAL NOT NULL,
  weight REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dimensions_invocation ON quality_dimensions(invocation_id);

-- Table 3: tool_calls
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invocation_id TEXT NOT NULL REFERENCES agent_invocations(invocation_id),
  tool_name TEXT NOT NULL,
  invocation_count INTEGER NOT NULL,
  total_duration_ms INTEGER NOT NULL,
  blocked INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_tools_invocation ON tool_calls(invocation_id);

-- Table 4: agent_alerts
CREATE TABLE IF NOT EXISTS agent_alerts (
  alert_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  evidence TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_alerts_agent ON agent_alerts(agent_name);
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON agent_alerts(severity);
CREATE INDEX IF NOT EXISTS idx_alerts_active ON agent_alerts(resolved_at) WHERE resolved_at IS NULL;

-- Table 5: aggregate_snapshots
CREATE TABLE IF NOT EXISTS aggregate_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  window_days INTEGER NOT NULL,
  invocation_count INTEGER NOT NULL,
  approval_rate REAL NOT NULL,
  avg_quality_score REAL NOT NULL,
  median_quality_score REAL NOT NULL,
  stddev_quality_score REAL NOT NULL,
  avg_review_iterations REAL NOT NULL,
  avg_wall_clock_ms REAL NOT NULL,
  avg_turns REAL NOT NULL,
  total_tokens INTEGER NOT NULL,
  trend_direction TEXT NOT NULL,
  trend_slope REAL NOT NULL,
  trend_confidence REAL NOT NULL,
  domain_breakdown TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON aggregate_snapshots(agent_name);
CREATE INDEX IF NOT EXISTS idx_snapshots_computed ON aggregate_snapshots(computed_at);
`;

// ---------------------------------------------------------------------------
// Query option types
// ---------------------------------------------------------------------------

export interface InvocationQueryOptions {
  since?: string;   // ISO 8601
  until?: string;   // ISO 8601
  domain?: string;
  limit?: number;
}

export interface AlertQueryOptions {
  agentName?: string;
  severity?: AlertSeverity;
  activeOnly?: boolean;
}

// ---------------------------------------------------------------------------
// SqliteStore
// ---------------------------------------------------------------------------

export class SqliteStore {
  private readonly dbPath: string;
  private db: Database | null = null;

  constructor(dbPath: string) {
    this.dbPath = path.resolve(dbPath);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Create all tables, enable WAL mode, and prepare the database for use.
   * Must be called before any read/write operations.
   */
  initialize(): void {
    if (!BetterSqlite3) {
      throw new Error(
        'better-sqlite3 is not installed. Install it to use SqliteStore.',
      );
    }

    // Ensure parent directory exists
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new (BetterSqlite3 as any)(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(CREATE_TABLES_SQL);
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Health check: returns true when the database file exists and is
   * accessible, false otherwise.
   */
  isAvailable(): boolean {
    if (!this.db) return false;
    try {
      // Attempt a trivial query; if the db is locked or corrupt this throws.
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  // -----------------------------------------------------------------------
  // Invocations
  // -----------------------------------------------------------------------

  /**
   * Insert a full `InvocationMetric` record into the `agent_invocations`,
   * `quality_dimensions`, and `tool_calls` tables within a single
   * transaction.
   */
  insertInvocation(metric: InvocationMetric): void {
    this.requireDb();

    const insertMain = this.db!.prepare(`
      INSERT INTO agent_invocations (
        invocation_id, agent_name, agent_version, pipeline_run_id,
        input_hash, input_domain, input_tokens,
        output_hash, output_tokens, output_quality_score,
        review_iteration_count, review_outcome, reviewer_agent,
        wall_clock_ms, turn_count, timestamp, environment
      ) VALUES (
        @invocation_id, @agent_name, @agent_version, @pipeline_run_id,
        @input_hash, @input_domain, @input_tokens,
        @output_hash, @output_tokens, @output_quality_score,
        @review_iteration_count, @review_outcome, @reviewer_agent,
        @wall_clock_ms, @turn_count, @timestamp, @environment
      )
    `);

    const insertDimension = this.db!.prepare(`
      INSERT INTO quality_dimensions (invocation_id, dimension, score, weight)
      VALUES (@invocation_id, @dimension, @score, @weight)
    `);

    const insertToolCall = this.db!.prepare(`
      INSERT INTO tool_calls (
        invocation_id, tool_name, invocation_count, total_duration_ms,
        blocked, blocked_reason
      ) VALUES (
        @invocation_id, @tool_name, @invocation_count, @total_duration_ms,
        @blocked, @blocked_reason
      )
    `);

    const transaction = this.db!.transaction(() => {
      insertMain.run({
        invocation_id: metric.invocation_id,
        agent_name: metric.agent_name,
        agent_version: metric.agent_version,
        pipeline_run_id: metric.pipeline_run_id,
        input_hash: metric.input_hash,
        input_domain: metric.input_domain,
        input_tokens: metric.input_tokens,
        output_hash: metric.output_hash,
        output_tokens: metric.output_tokens,
        output_quality_score: metric.output_quality_score,
        review_iteration_count: metric.review_iteration_count,
        review_outcome: metric.review_outcome,
        reviewer_agent: metric.reviewer_agent,
        wall_clock_ms: metric.wall_clock_ms,
        turn_count: metric.turn_count,
        timestamp: metric.timestamp,
        environment: metric.environment,
      });

      for (const dim of metric.quality_dimensions) {
        insertDimension.run({
          invocation_id: metric.invocation_id,
          dimension: dim.dimension,
          score: dim.score,
          weight: dim.weight,
        });
      }

      for (const tc of metric.tool_calls) {
        insertToolCall.run({
          invocation_id: metric.invocation_id,
          tool_name: tc.tool_name,
          invocation_count: tc.invocation_count,
          total_duration_ms: tc.total_duration_ms,
          blocked: tc.blocked ? 1 : 0,
          blocked_reason: tc.blocked_reason ?? null,
        });
      }
    });

    transaction();
  }

  /**
   * Query invocations for a given agent, with optional time range, domain,
   * and limit filters.
   */
  getInvocations(
    agentName: string,
    opts?: InvocationQueryOptions,
  ): InvocationMetric[] {
    this.requireDb();

    const clauses: string[] = ['agent_name = @agentName'];
    const params: Record<string, unknown> = { agentName };

    if (opts?.since) {
      clauses.push('timestamp >= @since');
      params.since = opts.since;
    }
    if (opts?.until) {
      clauses.push('timestamp <= @until');
      params.until = opts.until;
    }
    if (opts?.domain) {
      clauses.push('input_domain = @domain');
      params.domain = opts.domain;
    }

    const limit = opts?.limit ? `LIMIT ${Number(opts.limit)}` : '';
    const sql = `
      SELECT * FROM agent_invocations
      WHERE ${clauses.join(' AND ')}
      ORDER BY timestamp DESC
      ${limit}
    `;

    const rows = this.db!.prepare(sql).all(params) as Record<string, unknown>[];
    return rows.map((row) => this.hydrateInvocation(row));
  }

  /**
   * Return all invocations belonging to a specific pipeline run.
   */
  getInvocationsByPipeline(pipelineRunId: string): InvocationMetric[] {
    this.requireDb();

    const rows = this.db!
      .prepare(
        'SELECT * FROM agent_invocations WHERE pipeline_run_id = ? ORDER BY timestamp ASC',
      )
      .all(pipelineRunId) as Record<string, unknown>[];

    return rows.map((row) => this.hydrateInvocation(row));
  }

  /**
   * Count invocations for an agent, optionally filtered to those recorded
   * since (>=) a given agent version string.
   */
  getInvocationCount(agentName: string, sinceVersion?: string): number {
    this.requireDb();

    if (sinceVersion) {
      const row = this.db!
        .prepare(
          `SELECT COUNT(*) as cnt FROM agent_invocations
           WHERE agent_name = ? AND agent_version >= ?`,
        )
        .get(agentName, sinceVersion) as { cnt: number };
      return row.cnt;
    }

    const row = this.db!
      .prepare('SELECT COUNT(*) as cnt FROM agent_invocations WHERE agent_name = ?')
      .get(agentName) as { cnt: number };
    return row.cnt;
  }

  // -----------------------------------------------------------------------
  // Alerts
  // -----------------------------------------------------------------------

  /** Insert an alert record. */
  insertAlert(alert: AlertRecord): void {
    this.requireDb();

    this.db!.prepare(`
      INSERT INTO agent_alerts (
        alert_id, agent_name, rule_id, severity, message, evidence,
        created_at, resolved_at, acknowledged
      ) VALUES (
        @alert_id, @agent_name, @rule_id, @severity, @message, @evidence,
        @created_at, @resolved_at, @acknowledged
      )
    `).run({
      alert_id: alert.alert_id,
      agent_name: alert.agent_name,
      rule_id: alert.rule_id,
      severity: alert.severity,
      message: alert.message,
      evidence: JSON.stringify(alert.evidence),
      created_at: alert.created_at,
      resolved_at: alert.resolved_at,
      acknowledged: alert.acknowledged ? 1 : 0,
    });
  }

  /**
   * Query alerts with optional filters for agent name, severity, and
   * active-only (unresolved).
   */
  getAlerts(opts?: AlertQueryOptions): AlertRecord[] {
    this.requireDb();

    const clauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (opts?.agentName) {
      clauses.push('agent_name = @agentName');
      params.agentName = opts.agentName;
    }
    if (opts?.severity) {
      clauses.push('severity = @severity');
      params.severity = opts.severity;
    }
    if (opts?.activeOnly) {
      clauses.push('resolved_at IS NULL');
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT * FROM agent_alerts ${where} ORDER BY created_at DESC`;

    const rows = this.db!.prepare(sql).all(params) as Record<string, unknown>[];
    return rows.map((row) => this.hydrateAlert(row));
  }

  /** Mark an alert as resolved (sets `resolved_at` to now). */
  resolveAlert(alertId: string): void {
    this.requireDb();
    const now = new Date().toISOString();
    this.db!
      .prepare('UPDATE agent_alerts SET resolved_at = ? WHERE alert_id = ?')
      .run(now, alertId);
  }

  /** Mark an alert as acknowledged. */
  acknowledgeAlert(alertId: string): void {
    this.requireDb();
    this.db!
      .prepare('UPDATE agent_alerts SET acknowledged = 1 WHERE alert_id = ?')
      .run(alertId);
  }

  /**
   * Find an active (unresolved) alert for the given agent and rule.
   *
   * Deduplication key: (agent_name, rule_id, resolved_at IS NULL).
   * Returns the matching alert or null if none exists.
   */
  findActiveAlert(agentName: string, ruleId: string): AlertRecord | null {
    this.requireDb();

    const row = this.db!
      .prepare(
        `SELECT * FROM agent_alerts
         WHERE agent_name = ? AND rule_id = ? AND resolved_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(agentName, ruleId) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.hydrateAlert(row);
  }

  /**
   * Count consecutive "good" invocations for an agent recorded since the
   * given timestamp, using a caller-supplied predicate to determine
   * what qualifies as "good".
   *
   * Invocations are walked in chronological order (oldest to newest since
   * `sinceTimestamp`).  The count resets to 0 on any "bad" invocation.
   * Returns the final consecutive-good count.
   */
  countConsecutiveGoodInvocations(
    agentName: string,
    sinceTimestamp: string,
    isGood: (metric: InvocationMetric) => boolean,
  ): number {
    this.requireDb();

    // Fetch invocations since the alert creation timestamp, oldest first
    const rows = this.db!
      .prepare(
        `SELECT * FROM agent_invocations
         WHERE agent_name = ? AND timestamp >= ?
         ORDER BY timestamp ASC`,
      )
      .all(agentName, sinceTimestamp) as Record<string, unknown>[];

    const metrics = rows.map((row) => this.hydrateInvocation(row));

    let consecutive = 0;
    for (const metric of metrics) {
      if (isGood(metric)) {
        consecutive++;
      } else {
        consecutive = 0;
      }
    }

    return consecutive;
  }

  // -----------------------------------------------------------------------
  // Aggregate snapshots
  // -----------------------------------------------------------------------

  /** Insert an aggregate snapshot. */
  insertSnapshot(snapshot: AggregateSnapshot): void {
    this.requireDb();

    this.db!.prepare(`
      INSERT INTO aggregate_snapshots (
        snapshot_id, agent_name, computed_at, window_days,
        invocation_count, approval_rate,
        avg_quality_score, median_quality_score, stddev_quality_score,
        avg_review_iterations, avg_wall_clock_ms, avg_turns,
        total_tokens, trend_direction, trend_slope, trend_confidence,
        domain_breakdown
      ) VALUES (
        @snapshot_id, @agent_name, @computed_at, @window_days,
        @invocation_count, @approval_rate,
        @avg_quality_score, @median_quality_score, @stddev_quality_score,
        @avg_review_iterations, @avg_wall_clock_ms, @avg_turns,
        @total_tokens, @trend_direction, @trend_slope, @trend_confidence,
        @domain_breakdown
      )
    `).run({
      snapshot_id: snapshot.snapshot_id,
      agent_name: snapshot.agent_name,
      computed_at: snapshot.computed_at,
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
      trend_direction: snapshot.trend_direction,
      trend_slope: snapshot.trend_slope,
      trend_confidence: snapshot.trend_confidence,
      domain_breakdown: JSON.stringify(snapshot.domain_breakdown),
    });
  }

  /**
   * Return the most recently computed snapshot for a given agent, or null
   * if none exists.
   */
  getLatestSnapshot(agentName: string): AggregateSnapshot | null {
    this.requireDb();

    const row = this.db!
      .prepare(
        `SELECT * FROM aggregate_snapshots
         WHERE agent_name = ?
         ORDER BY computed_at DESC
         LIMIT 1`,
      )
      .get(agentName) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.hydrateSnapshot(row);
  }

  /**
   * Return the N most recently computed snapshots for a given agent,
   * ordered from newest to oldest.  Used by anomaly detection to compare
   * current vs previous snapshots for trend reversal detection.
   */
  getLatestSnapshots(agentName: string, count: number): AggregateSnapshot[] {
    this.requireDb();

    const rows = this.db!
      .prepare(
        `SELECT * FROM aggregate_snapshots
         WHERE agent_name = ?
         ORDER BY computed_at DESC
         LIMIT ?`,
      )
      .all(agentName, count) as Record<string, unknown>[];

    return rows.map((row) => this.hydrateSnapshot(row));
  }

  // -----------------------------------------------------------------------
  // Maintenance
  // -----------------------------------------------------------------------

  /**
   * Delete invocation records older than `cutoffDate` (ISO 8601).
   *
   * Also deletes linked `quality_dimensions` and `tool_calls` rows
   * (cascade).  Returns the number of invocation rows deleted.
   */
  deleteInvocationsBefore(cutoffDate: string): number {
    this.requireDb();

    const transaction = this.db!.transaction(() => {
      // Collect invocation IDs to delete
      const ids = this.db!
        .prepare(
          'SELECT invocation_id FROM agent_invocations WHERE timestamp < ?',
        )
        .all(cutoffDate) as Array<{ invocation_id: string }>;

      if (ids.length === 0) return 0;

      const idList = ids.map((r) => r.invocation_id);

      // Delete child rows first (quality_dimensions and tool_calls)
      for (const id of idList) {
        this.db!
          .prepare('DELETE FROM quality_dimensions WHERE invocation_id = ?')
          .run(id);
        this.db!
          .prepare('DELETE FROM tool_calls WHERE invocation_id = ?')
          .run(id);
      }

      // Delete parent rows
      const result = this.db!
        .prepare('DELETE FROM agent_invocations WHERE timestamp < ?')
        .run(cutoffDate);

      return result.changes;
    });

    return transaction() as number;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /** Throw if the database has not been initialised. */
  private requireDb(): void {
    if (!this.db) {
      throw new Error('SqliteStore not initialised. Call initialize() first.');
    }
  }

  /**
   * Hydrate a raw `agent_invocations` row into a full `InvocationMetric`,
   * including linked quality dimensions and tool calls.
   */
  private hydrateInvocation(row: Record<string, unknown>): InvocationMetric {
    const invocationId = row.invocation_id as string;

    const dimensions = this.db!
      .prepare('SELECT * FROM quality_dimensions WHERE invocation_id = ?')
      .all(invocationId) as Array<Record<string, unknown>>;

    const toolCalls = this.db!
      .prepare('SELECT * FROM tool_calls WHERE invocation_id = ?')
      .all(invocationId) as Array<Record<string, unknown>>;

    return {
      invocation_id: invocationId,
      agent_name: row.agent_name as string,
      agent_version: row.agent_version as string,
      pipeline_run_id: (row.pipeline_run_id as string) ?? null,
      input_hash: row.input_hash as string,
      input_domain: row.input_domain as string,
      input_tokens: row.input_tokens as number,
      output_hash: row.output_hash as string,
      output_tokens: row.output_tokens as number,
      output_quality_score: row.output_quality_score as number,
      review_iteration_count: row.review_iteration_count as number,
      review_outcome: row.review_outcome as InvocationMetric['review_outcome'],
      reviewer_agent: (row.reviewer_agent as string) ?? null,
      wall_clock_ms: row.wall_clock_ms as number,
      turn_count: row.turn_count as number,
      timestamp: row.timestamp as string,
      environment: row.environment as InvocationMetric['environment'],
      quality_dimensions: dimensions.map((d) => ({
        dimension: d.dimension as string,
        score: d.score as number,
        weight: d.weight as number,
      })),
      tool_calls: toolCalls.map((tc) => ({
        tool_name: tc.tool_name as string,
        invocation_count: tc.invocation_count as number,
        total_duration_ms: tc.total_duration_ms as number,
        blocked: (tc.blocked as number) === 1,
        ...(tc.blocked_reason ? { blocked_reason: tc.blocked_reason as string } : {}),
      })),
    };
  }

  /** Hydrate a raw `agent_alerts` row into an `AlertRecord`. */
  private hydrateAlert(row: Record<string, unknown>): AlertRecord {
    return {
      alert_id: row.alert_id as string,
      agent_name: row.agent_name as string,
      rule_id: row.rule_id as string,
      severity: row.severity as AlertRecord['severity'],
      message: row.message as string,
      evidence: JSON.parse(row.evidence as string) as Record<string, unknown>,
      created_at: row.created_at as string,
      resolved_at: (row.resolved_at as string) ?? null,
      acknowledged: (row.acknowledged as number) === 1,
    };
  }

  /** Hydrate a raw `aggregate_snapshots` row into an `AggregateSnapshot`. */
  private hydrateSnapshot(row: Record<string, unknown>): AggregateSnapshot {
    return {
      snapshot_id: row.snapshot_id as string,
      agent_name: row.agent_name as string,
      computed_at: row.computed_at as string,
      window_days: row.window_days as number,
      invocation_count: row.invocation_count as number,
      approval_rate: row.approval_rate as number,
      avg_quality_score: row.avg_quality_score as number,
      median_quality_score: row.median_quality_score as number,
      stddev_quality_score: row.stddev_quality_score as number,
      avg_review_iterations: row.avg_review_iterations as number,
      avg_wall_clock_ms: row.avg_wall_clock_ms as number,
      avg_turns: row.avg_turns as number,
      total_tokens: row.total_tokens as number,
      trend_direction: row.trend_direction as AggregateSnapshot['trend_direction'],
      trend_slope: row.trend_slope as number,
      trend_confidence: row.trend_confidence as number,
      domain_breakdown: JSON.parse(
        row.domain_breakdown as string,
      ) as Record<string, DomainStats>,
    };
  }
}
