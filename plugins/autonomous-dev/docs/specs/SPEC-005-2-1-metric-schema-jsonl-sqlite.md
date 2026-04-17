# SPEC-005-2-1: Per-Invocation Metric Schema, JSONL Writer, and SQLite Store

## Metadata
- **Parent Plan**: PLAN-005-2
- **Tasks Covered**: Task 1 (Per-invocation metric schema and types), Task 2 (JSONL writer), Task 3 (SQLite store)
- **Estimated effort**: 14 hours

## Description

Define the complete per-invocation metrics data model, implement the append-only JSONL writer for durable primary storage, and build the SQLite store with all 5 tables for queryable secondary storage. These three components form the storage foundation for all metrics, alerts, and aggregate snapshots consumed by the rest of the Agent Factory.

## Files to Create/Modify

### New Files

**`src/agent-factory/metrics/types.ts`**
- Exports: `InvocationMetric`, `ToolCallRecord`, `QualityDimensionScore`, `ReviewOutcome`, `Environment`, `AlertRecord`, `AlertSeverity`, `AggregateSnapshot`

**`src/agent-factory/metrics/jsonl-writer.ts`**
- Exports: `JsonlWriter` class with `append(record: InvocationMetric): void` and `readAll(): InvocationMetric[]`

**`src/agent-factory/metrics/sqlite-store.ts`**
- Exports: `SqliteStore` class implementing all CRUD operations across 5 tables

## Implementation Details

### Metric Schema (`metrics/types.ts`)

```typescript
interface InvocationMetric {
  invocation_id: string;            // UUID v4
  agent_name: string;
  agent_version: string;
  pipeline_run_id: string | null;   // null for standalone invocations
  input_hash: string;               // SHA-256 of input
  input_domain: string;             // classified domain tag
  input_tokens: number;
  output_hash: string;              // SHA-256 of output
  output_tokens: number;
  output_quality_score: number;     // 1.0 - 5.0 overall score
  quality_dimensions: QualityDimensionScore[];
  review_iteration_count: number;   // 0 = first pass accepted
  review_outcome: ReviewOutcome;
  reviewer_agent: string | null;    // null if no review
  wall_clock_ms: number;
  turn_count: number;
  tool_calls: ToolCallRecord[];
  timestamp: string;                // ISO 8601
  environment: Environment;
}

interface ToolCallRecord {
  tool_name: string;
  invocation_count: number;
  total_duration_ms: number;
  blocked: boolean;                 // true if any call was blocked
  blocked_reason?: string;
}

interface QualityDimensionScore {
  dimension: string;
  score: number;                    // 1.0 - 5.0
  weight: number;
}

type ReviewOutcome = 'approved' | 'rejected' | 'revision_requested' | 'not_reviewed';

type Environment = 'production' | 'validation' | 'canary';

interface AlertRecord {
  alert_id: string;                 // UUID v4
  agent_name: string;
  rule_id: string;
  severity: AlertSeverity;
  message: string;
  evidence: Record<string, unknown>;
  created_at: string;               // ISO 8601
  resolved_at: string | null;       // ISO 8601, null if active
  acknowledged: boolean;
}

type AlertSeverity = 'info' | 'warning' | 'critical';

interface AggregateSnapshot {
  snapshot_id: string;              // UUID v4
  agent_name: string;
  computed_at: string;              // ISO 8601
  window_days: number;              // 30
  invocation_count: number;
  approval_rate: number;
  avg_quality_score: number;
  median_quality_score: number;
  stddev_quality_score: number;
  avg_review_iterations: number;
  avg_wall_clock_ms: number;
  avg_turns: number;
  total_tokens: number;
  trend_direction: 'improving' | 'stable' | 'declining';
  trend_slope: number;
  trend_confidence: number;         // R-squared
  domain_breakdown: Record<string, DomainStats>;
}

interface DomainStats {
  invocation_count: number;
  approval_rate: number;
  avg_quality_score: number;
}
```

### JSONL Writer (`metrics/jsonl-writer.ts`)

**Write path:**
1. Serialize `InvocationMetric` to JSON (single line, no pretty-print).
2. Open file in append mode (`'a'` flag).
3. Write JSON string + `\n`.
4. Close file descriptor (or use `fs.appendFileSync` for simplicity).
5. On write error, throw (caller handles buffering per SPEC-005-2-2).

**Crash safety:** Each write is a single `appendFileSync` call. If the process crashes mid-write, at most one partial line is lost. The reader skips lines that fail JSON.parse.

**Read path (`readAll`):**
1. Read file contents.
2. Split by `\n`.
3. For each non-empty line, attempt `JSON.parse`.
4. Skip lines that fail to parse (log warning).
5. Return array of `InvocationMetric`.

**File location:** `data/metrics/agent-invocations.jsonl` (from config).

### SQLite Store (`metrics/sqlite-store.ts`)

**Database:** `data/agent-metrics.db` with WAL mode enabled.

**Table schemas:**

```sql
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
  evidence TEXT NOT NULL,  -- JSON
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
  domain_breakdown TEXT NOT NULL  -- JSON
);
CREATE INDEX IF NOT EXISTS idx_snapshots_agent ON aggregate_snapshots(agent_name);
CREATE INDEX IF NOT EXISTS idx_snapshots_computed ON aggregate_snapshots(computed_at);
```

**Query methods:**

```typescript
class SqliteStore {
  constructor(dbPath: string);
  initialize(): void;  // create tables, enable WAL

  // Invocations
  insertInvocation(metric: InvocationMetric): void;
  getInvocations(agentName: string, opts?: { since?: string; until?: string; domain?: string; limit?: number }): InvocationMetric[];
  getInvocationsByPipeline(pipelineRunId: string): InvocationMetric[];
  getInvocationCount(agentName: string, sinceVersion?: string): number;

  // Alerts
  insertAlert(alert: AlertRecord): void;
  getAlerts(opts?: { agentName?: string; severity?: AlertSeverity; activeOnly?: boolean }): AlertRecord[];
  resolveAlert(alertId: string): void;
  acknowledgeAlert(alertId: string): void;

  // Aggregate snapshots
  insertSnapshot(snapshot: AggregateSnapshot): void;
  getLatestSnapshot(agentName: string): AggregateSnapshot | null;

  // Maintenance
  deleteInvocationsBefore(cutoffDate: string): number;  // returns count deleted
  isAvailable(): boolean;  // health check
}
```

## Acceptance Criteria

1. `InvocationMetric` includes all fields from TDD 3.3.1 with correct types.
2. JSONL writer opens file in append mode only; no read or truncate operations on the file path.
3. JSONL writer writes one JSON object per line.
4. JSONL writer is crash-safe: partial write loses at most one record.
5. JSONL reader skips malformed lines without throwing.
6. SQLite store creates all 5 tables with correct schemas, constraints, and indices.
7. SQLite store uses WAL mode for concurrent read/write support.
8. Insert and query operations work correctly for all 5 tables.
9. `deleteInvocationsBefore` removes records from `agent_invocations`, `quality_dimensions`, and `tool_calls` (cascade).
10. `isAvailable()` returns false when the database file is missing or locked.

## Test Cases

### JSONL Writer Tests

```
test_append_single_metric
  Action: append one InvocationMetric
  Expected: file contains one valid JSON line with all fields

test_append_multiple_metrics
  Action: append 5 metrics
  Expected: file contains 5 lines, each parseable

test_read_all_returns_all
  Action: append 3 metrics, readAll()
  Expected: array of 3 InvocationMetric objects

test_read_skips_malformed_lines
  Setup: file with 3 valid lines and 1 corrupt line
  Expected: readAll() returns 3, logs warning for corrupt line

test_file_created_on_first_write
  Setup: metrics file does not exist
  Action: append one metric
  Expected: file created, contains the metric

test_append_preserves_existing
  Setup: file with 2 existing lines
  Action: append 1 more
  Expected: file has 3 lines total

test_concurrent_appends
  Action: append 10 metrics in rapid succession (simulated concurrency)
  Expected: all 10 lines present in file
```

### SQLite Store Tests

```
test_initialize_creates_tables
  Action: new SqliteStore, initialize()
  Expected: all 5 tables exist in database

test_insert_and_query_invocation
  Action: insert an InvocationMetric, query by agent name
  Expected: returned record matches inserted data

test_query_by_time_range
  Action: insert metrics at t=1, t=5, t=10; query since=t=3
  Expected: returns metrics at t=5, t=10

test_query_by_domain
  Action: insert metrics with domains "typescript" and "python"
  Expected: query with domain="typescript" returns only typescript metrics

test_query_by_pipeline
  Action: insert metrics with pipeline_run_id="run-123"
  Expected: getInvocationsByPipeline("run-123") returns matching records

test_quality_dimensions_linked
  Action: insert metric with 3 quality dimensions
  Expected: dimensions queryable and linked to invocation_id

test_tool_calls_linked
  Action: insert metric with 2 tool call records
  Expected: tool calls queryable and linked to invocation_id

test_insert_and_query_alert
  Action: insertAlert, getAlerts(activeOnly=true)
  Expected: alert returned, resolved_at is null

test_resolve_alert
  Action: insertAlert, resolveAlert
  Expected: resolved_at is set, getAlerts(activeOnly=true) excludes it

test_insert_and_query_snapshot
  Action: insertSnapshot, getLatestSnapshot
  Expected: latest snapshot returned with correct data

test_delete_invocations_before
  Action: insert metrics spanning 120 days, delete before 90 days ago
  Expected: old records deleted, recent records retained

test_cascade_delete
  Action: delete invocations; verify quality_dimensions and tool_calls also deleted

test_is_available_when_healthy
  Expected: true

test_is_available_when_db_missing
  Setup: delete database file
  Expected: false

test_wal_mode_enabled
  Action: query PRAGMA journal_mode
  Expected: "wal"
```
