# SPEC-005-2-4: Graceful Degradation, Metrics Retention, and Observation Tracking

## Metadata
- **Parent Plan**: PLAN-005-2
- **Tasks Covered**: Task 8 (Graceful degradation), Task 9 (Metrics retention and pruning), Task 10 (Observation state tracker)
- **Estimated effort**: 14 hours

## Description

Implement the resilience layer that keeps metrics flowing when SQLite is unavailable, the daily maintenance job that prunes old records to control storage growth, and the observation state tracker that counts per-agent invocations toward the improvement trigger threshold. These components ensure the metrics system is durable, bounded in size, and connected to the improvement lifecycle.

## Files to Create/Modify

### New Files

**`src/agent-factory/metrics/retention.ts`**
- Exports: `RetentionManager` class with `prune(): PruneResult`
- Exports: `rebuildSqliteFromJsonl(): RebuildResult`

**`src/agent-factory/metrics/observation.ts`**
- Exports: `ObservationTracker` class with per-agent invocation counting

### Modified Files

**`src/agent-factory/metrics/engine.ts`** (extend graceful degradation)
- Add: memory buffer management, SQLite health monitoring, replay-on-recovery logic

## Implementation Details

### Graceful Degradation (engine.ts modifications)

**Degraded mode detection:**
- Before every SQLite write, call `sqliteStore.isAvailable()`.
- If unavailable, enter degraded mode.
- Periodically (every 60 seconds or every 10 record attempts), retry availability check.

**Degraded mode behavior:**

| Component | Normal Mode | Degraded Mode |
|-----------|-------------|---------------|
| JSONL writes | Synchronous, always | Synchronous, always (unchanged) |
| SQLite writes | Async after JSONL | Skipped, buffered |
| Anomaly detection | Active | Paused (logged as warning) |
| Aggregate computation | Active | Paused (logged as warning) |
| Query API (`getInvocations`) | SQLite | Falls back to JSONL reader |
| Query API (`getAggregate`) | SQLite | Returns last cached snapshot or null |
| Query API (`getAlerts`) | SQLite | Returns empty with warning |

**Memory buffer specification:**
```typescript
interface BufferState {
  records: InvocationMetric[];      // bounded to 1000
  maxSize: number;                  // 1000
  droppedCount: number;             // total records dropped due to overflow
  enteredDegradedAt: string | null; // ISO 8601 timestamp
}
```

- When buffer is full and new record arrives: drop oldest record, increment `droppedCount`, log warning.
- On recovery: replay all buffered records to SQLite in timestamp order, then clear buffer.

**SQLite rebuild from JSONL:**
- Maintenance operation for full reconstruction.
- Read all JSONL records, insert into SQLite (fresh database).
- Used when SQLite is corrupted beyond repair.

```typescript
interface RebuildResult {
  recordsProcessed: number;
  recordsInserted: number;
  errors: number;
  duration_ms: number;
}
```

### Metrics Retention (`metrics/retention.ts`)

**Pruning job:**

1. Compute cutoff date: `now - 90 days`.
2. **JSONL pruning:**
   - Read all lines from the JSONL file.
   - Write lines with `timestamp >= cutoff` to a new temporary file.
   - Atomically replace the original file: write to `agent-invocations.jsonl.tmp`, rename to `agent-invocations.jsonl`.
   - Log: "Pruned {N} JSONL records older than {cutoff}".
3. **SQLite pruning:**
   - Call `sqliteStore.deleteInvocationsBefore(cutoff)`.
   - Also delete orphaned `quality_dimensions` and `tool_calls` records.
   - Do NOT delete from `aggregate_snapshots` (retained indefinitely).
   - Do NOT delete from `agent_alerts` (retained for audit history).
4. Return `PruneResult`.

```typescript
interface PruneResult {
  jsonlPruned: number;
  sqlitePruned: number;
  snapshotsRetained: number;
  alertsRetained: number;
  duration_ms: number;
}
```

**Idempotency:**
- Running prune twice with the same cutoff produces the same result (no double-deletion).
- Safe to run while writes are occurring (JSONL uses atomic rename; SQLite uses transaction).

**Scheduling:**
- Exposes `prune()` method for external scheduling (integrated with daemon supervisor).
- No internal timer; called by the system's job scheduler.

### Observation State Tracker (`metrics/observation.ts`)

Tracks per-agent invocation counts since last version promotion to determine when an agent is eligible for performance analysis.

```typescript
interface ObservationState {
  agent_name: string;
  invocations_since_promotion: number;
  threshold: number;              // from config, per-agent override or default
  status: 'collecting' | 'threshold_reached';
  last_promotion_version: string; // version when counter was last reset
}

class ObservationTracker {
  constructor(
    private metricsEngine: IMetricsEngine,
    private config: AgentFactoryConfig
  ) {}

  // Called after each metric record
  recordInvocation(agentName: string, agentVersion: string): ObservationState;

  // Query current state
  getState(agentName: string): ObservationState;

  // Reset counter (called on version promotion)
  resetForPromotion(agentName: string, newVersion: string): void;

  // Check if threshold reached
  isThresholdReached(agentName: string): boolean;

  // Force bypass (for manual analysis triggering)
  forceThresholdReached(agentName: string): ObservationState;
}
```

**Invocation counting:**
- Maintained in memory with persistence to `data/observation-state.json`.
- On each `recordInvocation()`:
  1. Increment `invocations_since_promotion` for the agent.
  2. If `agentVersion` differs from `last_promotion_version`, reset counter to 1 (new version detected).
  3. Update `status` to `threshold_reached` if count >= threshold.
  4. Persist state.

**Threshold resolution:**
- Check `config.observation.perAgentOverrides[agentName]` first.
- Fall back to `config.observation.defaultThreshold` (default 10).

**`forceThresholdReached()`:**
- Sets `status` to `threshold_reached` regardless of count.
- Used by `agent analyze --force` CLI command.
- Does NOT bypass FROZEN state check (that is handled by the caller).

## Acceptance Criteria

1. JSONL writes continue normally when SQLite is unavailable.
2. Metrics are buffered in memory (max 1000) during SQLite outage.
3. Anomaly detection and aggregation are paused during degraded mode.
4. Buffered records replayed to SQLite on recovery (in timestamp order).
5. SQLite rebuild from JSONL produces a complete, consistent database.
6. Retention pruning removes per-invocation records older than 90 days from both JSONL and SQLite.
7. Aggregate snapshots are NOT pruned.
8. Alert records are NOT pruned.
9. JSONL pruning uses atomic file rename for safety.
10. Pruning is idempotent and safe to run concurrently with writes.
11. Observation tracker counts invocations per agent since last promotion.
12. Threshold is configurable per-agent with global default of 10.
13. Counter resets to 0 on version promotion (version change detection).
14. `--force` bypass sets threshold_reached without meeting count.
15. State persisted to disk for recovery across restarts.

## Test Cases

### Graceful Degradation Tests

```
test_jsonl_continues_when_sqlite_down
  Setup: make SQLite unavailable
  Action: record 5 metrics
  Expected: all 5 in JSONL file, 5 in memory buffer

test_anomaly_detection_paused_when_degraded
  Setup: make SQLite unavailable
  Action: record metric
  Expected: warning logged "anomaly detection paused", no alerts evaluated

test_buffer_bounded_to_1000
  Setup: SQLite unavailable
  Action: record 1050 metrics
  Expected: buffer has 1000, droppedCount = 50

test_replay_on_recovery
  Setup: buffer 10 metrics
  Action: restore SQLite
  Expected: all 10 metrics in SQLite, buffer empty

test_replay_order_by_timestamp
  Setup: buffer metrics with timestamps t1 < t2 < t3
  Action: replay
  Expected: inserted in order t1, t2, t3

test_get_invocations_fallback_to_jsonl
  Setup: SQLite unavailable, JSONL has records
  Action: getInvocations("agent-name")
  Expected: returns records from JSONL

test_get_aggregate_returns_cached_when_degraded
  Setup: compute aggregate while healthy, then SQLite goes down
  Action: getAggregate()
  Expected: returns last cached snapshot

test_rebuild_sqlite_from_jsonl
  Setup: JSONL with 100 records, no SQLite
  Action: rebuildSqliteFromJsonl()
  Expected: new SQLite with 100 records, correct table contents
```

### Retention Tests

```
test_prune_jsonl_older_than_90_days
  Setup: JSONL with records at day -120, -60, -30
  Action: prune()
  Expected: day -120 removed, day -60 and -30 retained

test_prune_sqlite_older_than_90_days
  Setup: SQLite with records at day -120, -60
  Action: prune()
  Expected: day -120 invocations, dimensions, tool_calls deleted

test_aggregate_snapshots_not_pruned
  Setup: aggregate_snapshots with record at day -180
  Action: prune()
  Expected: snapshot retained

test_alerts_not_pruned
  Setup: agent_alerts with record at day -180
  Action: prune()
  Expected: alert retained

test_prune_atomic_jsonl_rename
  Action: prune() on JSONL file
  Expected: temp file created, renamed atomically (no partial state)

test_prune_idempotent
  Action: prune() twice with same cutoff
  Expected: second run deletes 0 records, no errors

test_prune_concurrent_with_writes
  Action: prune() while another thread appends to JSONL
  Expected: no data corruption (append goes to new file after rename)
```

### Observation Tracker Tests

```
test_initial_state_collecting
  Setup: new agent, 0 invocations
  Expected: status = "collecting", invocations_since_promotion = 0

test_increment_on_invocation
  Action: recordInvocation 3 times
  Expected: invocations_since_promotion = 3, status = "collecting"

test_threshold_reached
  Setup: threshold = 10
  Action: recordInvocation 10 times
  Expected: status = "threshold_reached"

test_per_agent_override
  Setup: default threshold = 10, override for "code-executor" = 20
  Action: recordInvocation 15 times for code-executor
  Expected: status = "collecting" (15 < 20)

test_reset_on_version_promotion
  Setup: 8 invocations recorded for v1.0.0
  Action: resetForPromotion("agent", "1.1.0")
  Expected: invocations_since_promotion = 0, last_promotion_version = "1.1.0"

test_auto_reset_on_version_change
  Setup: 8 invocations at v1.0.0
  Action: recordInvocation with v1.1.0
  Expected: counter resets to 1

test_force_threshold_reached
  Setup: 3 invocations (below threshold of 10)
  Action: forceThresholdReached("agent")
  Expected: status = "threshold_reached"

test_state_persisted_to_disk
  Setup: record 5 invocations
  Action: create new ObservationTracker instance (simulating restart)
  Expected: state loaded, invocations_since_promotion = 5

test_is_threshold_reached_query
  Setup: threshold = 10, 10 invocations
  Expected: isThresholdReached() returns true
```
