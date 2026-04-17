# PLAN-005-2: Metrics Collection & Observation Framework

## Metadata
- **Parent TDD**: TDD-005-agent-factory
- **Estimated effort**: 8 days
- **Dependencies**: PLAN-005-1 (Agent Registry Foundation)
- **Blocked by**: PLAN-005-1
- **Priority**: P0
- **Risk Level**: Low

## Objective

Build the complete metrics and observation layer: per-invocation metric recording (JSONL + SQLite dual-write), aggregate metrics computation, anomaly detection rules, metrics graceful degradation, the remaining 7 foundation agent definitions, rollback mechanism, and CLI commands for metrics/dashboard/rollback. After this plan, every agent invocation produces durable metrics, the system detects anomalies, operators can inspect agent health, and agents can be rolled back to previous versions.

## Scope

### In Scope

- Per-invocation metrics schema and recording (TDD 3.3.1)
- JSONL append-only storage at `data/metrics/agent-invocations.jsonl` (TDD 3.3.4)
- SQLite queryable store at `data/agent-metrics.db` with full schema (TDD 3.3.4)
- Dual-write: JSONL primary, SQLite async secondary (TDD 3.3.4)
- SQLite tables: `agent_invocations`, `quality_dimensions`, `tool_calls`, `agent_alerts`, `aggregate_snapshots` (TDD 3.3.4)
- Aggregate metrics computation: rolling 30-day window, trend analysis (last 20 invocations), domain breakdown (TDD 3.3.2)
- Anomaly detection rules: approval rate drop, quality decline, review iteration spike, escalation rate, trend reversal, token budget exceeded (TDD 3.3.3)
- Alert lifecycle: deduplication, escalation, auto-resolve after 5 consecutive good invocations (TDD 3.3.3)
- Graceful degradation: memory buffer (bounded 1000 records) when SQLite unavailable, JSONL continues, replay on recovery (TDD 3.3.4 / NFR-06)
- Metrics retention: 90-day pruning job for per-invocation records (TDD 3.3.4)
- Observation state tracking: per-agent invocation count vs. threshold (TDD 3.4.2)
- Rollback mechanism: `agent rollback` with impact analysis, git restore, re-commit (TDD 3.6.3)
- Remaining 7 foundation agent definitions: plan-author, spec-author, test-executor, deploy-executor, security-reviewer, architecture-reviewer, performance-analyst (TDD 3.9)
- CLI commands: `agent metrics`, `agent dashboard`, `agent rollback` (TDD 5.1)
- MetricsEngine API: `record()`, `getInvocations()`, `getAggregate()`, `getAlerts()`, `evaluateAnomalies()` (TDD 5.2)

### Out of Scope

- Performance analysis agent invocation (PLAN-005-3)
- Weakness report generation (PLAN-005-3)
- Proposal generation, meta-review (PLAN-005-3)
- A/B testing framework (PLAN-005-4)
- Canary mode, autonomous promotion (PLAN-005-5)

## Tasks

1. **Per-invocation metric schema and types** -- Define the `InvocationMetric` and `ToolCallRecord` TypeScript interfaces matching TDD 3.3.1.
   - Files to create: `src/agent-factory/metrics/types.ts`
   - Acceptance criteria: All fields from TDD 3.3.1 present with correct types; includes `invocation_id` (UUID v4), `agent_name`, `agent_version`, `pipeline_run_id`, `input_hash`, `input_domain`, `input_tokens`, `output_hash`, `output_tokens`, `output_quality_score`, `quality_dimensions`, `review_iteration_count`, `review_outcome`, `reviewer_agent`, `wall_clock_ms`, `turn_count`, `tool_calls`, `timestamp`, `environment`.
   - Estimated effort: 2 hours

2. **JSONL writer** -- Append-only writer for per-invocation metrics to `data/metrics/agent-invocations.jsonl`.
   - Files to create: `src/agent-factory/metrics/jsonl-writer.ts`
   - Acceptance criteria: Opens file in append mode; writes one JSON object per line; crash-safe (partial write loses at most one record); no read or truncate operations on the file.
   - Estimated effort: 4 hours

3. **SQLite store** -- Create and manage the SQLite database at `data/agent-metrics.db` with full schema from TDD 3.3.4.
   - Files to create: `src/agent-factory/metrics/sqlite-store.ts`
   - Acceptance criteria: Creates all 5 tables (`agent_invocations`, `quality_dimensions`, `tool_calls`, `agent_alerts`, `aggregate_snapshots`) with correct schemas, constraints, and indices. Supports insert, query by agent name + time range, query by domain, query by pipeline run.
   - Estimated effort: 8 hours

4. **Dual-write MetricsEngine** -- Implement the `MetricsEngine` interface with JSONL-primary, SQLite-async-secondary write path.
   - Files to create: `src/agent-factory/metrics/engine.ts`
   - Acceptance criteria: `record()` writes to JSONL first (sync), then SQLite (async). If SQLite write fails, metric is buffered in memory (bounded to 1000 records). `getInvocations()`, `getAggregate()`, `getAlerts()` query SQLite. JSONL is the source of truth.
   - Estimated effort: 8 hours

5. **Aggregate metrics computation** -- Compute `AggregateMetrics` from per-invocation records after each new invocation.
   - Files to create: `src/agent-factory/metrics/aggregator.ts`
   - Acceptance criteria: Computes all fields from TDD 3.3.2 including rolling 30-day window stats (invocation_count, approval_rate, average/median/stddev quality scores, average review iterations, average wall clock, average turns, total tokens). Trend analysis over last 20 invocations: linear regression slope, R-squared confidence, direction classification (improving/stable/declining). Domain breakdown with per-domain stats. Stores snapshots in `aggregate_snapshots` table.
   - Estimated effort: 10 hours

6. **Anomaly detection rules** -- Evaluate all 6 anomaly rules from TDD 3.3.3 after each invocation metric is recorded.
   - Files to create: `src/agent-factory/metrics/anomaly-detector.ts`
   - Acceptance criteria: Implements all 6 rules: approval rate drop (critical, default 0.70), quality score decline (warning, 0.5 points over 10 invocations), review iteration spike (warning, p95 for 3 consecutive), escalation rate exceeded (critical, 0.30), trend reversal (warning), token budget exceeded (info, 2x average). Deduplication: same alert for same agent not re-fired until resolved and recurred. Auto-resolve after 5 consecutive invocations where condition no longer holds. Thresholds configurable via `agent-factory.yaml`.
   - Estimated effort: 8 hours

7. **Alert management** -- Alert creation, storage, querying, acknowledgment, and auto-resolution.
   - Files to modify: `src/agent-factory/metrics/sqlite-store.ts`, `src/agent-factory/metrics/engine.ts`
   - Acceptance criteria: Alerts stored in `agent_alerts` table; queryable by agent name, severity, active/resolved; critical alerts surface via system notification mechanism; auto-resolve updates `resolved_at` timestamp.
   - Estimated effort: 4 hours

8. **Graceful degradation** -- Handle SQLite unavailability without losing metrics or blocking agent execution.
   - Files to modify: `src/agent-factory/metrics/engine.ts`
   - Acceptance criteria: When SQLite is unavailable (locked, corrupted): JSONL writes continue normally; metrics buffered in memory (bounded to 1000 records); anomaly detection paused (logged as warning); on recovery, buffered records and JSONL records not yet in SQLite are replayed. SQLite rebuild from JSONL supported as a maintenance operation.
   - Estimated effort: 6 hours

9. **Metrics retention and pruning** -- Daily maintenance job to prune records older than retention window.
   - Files to create: `src/agent-factory/metrics/retention.ts`
   - Acceptance criteria: Deletes per-invocation records older than 90 days from both JSONL and SQLite. Aggregate snapshots are retained indefinitely. Pruning is idempotent and safe to run concurrently with writes.
   - Estimated effort: 4 hours

10. **Observation state tracker** -- Track per-agent invocation count against observation threshold.
    - Files to create: `src/agent-factory/metrics/observation.ts`
    - Acceptance criteria: Tracks invocations per agent since last version promotion (or first load). Configurable threshold (default 10, per-agent overrides). Resets to 0 on version promotion. Reports `collecting` status with invocations_recorded and threshold. Supports `--force` bypass for manual analysis triggering.
    - Estimated effort: 4 hours

11. **Rollback mechanism** -- Restore an agent to its previous committed version.
    - Files to create: `src/agent-factory/rollback.ts`
    - Acceptance criteria: Identifies previous version from git history; displays impact analysis (invocation count for current version, diff, in-flight pipeline runs); requires operator confirmation (unless `--force`); restores via `git show <previous-commit>:agents/<name>.md`; updates version_history with rollback entry; commits with `revert(agents): rollback <name> v<current> -> v<previous>`; reloads registry; logs to audit log; emits rollback metric. Optional `--quarantine` flag marks artifacts from rolled-back version.
    - Estimated effort: 8 hours

12. **Remaining 7 foundation agent definitions** -- Write the agent `.md` files following the same patterns established by the first 6.
    - Files to create: `agents/plan-author.md`, `agents/spec-author.md`, `agents/test-executor.md`, `agents/deploy-executor.md`, `agents/security-reviewer.md`, `agents/architecture-reviewer.md`, `agents/performance-analyst.md`
    - Acceptance criteria: Each file passes schema validation; follows structural patterns from TDD 3.9; `performance-analyst` has role `meta` with read-only tools; all rubric dimensions are domain-appropriate.
    - Estimated effort: 8 hours

13. **CLI commands (metrics subset)** -- Implement `agent metrics`, `agent dashboard`, `agent rollback`.
    - Files to modify: `src/agent-factory/cli.ts`
    - Acceptance criteria: `metrics <name>` shows current aggregate metrics, trend, domain breakdown, and active alerts. `dashboard` shows summary table of all agents ranked by approval rate with trend indicators (arrows). `rollback <name>` triggers rollback workflow with confirmation prompt.
    - Estimated effort: 6 hours

## Dependencies & Integration Points

- **PLAN-005-1 (Agent Registry Foundation)**: Registry must be functional before metrics can be attached to invocations. The metrics engine hooks into the Agent Runtime wrapper to emit metrics per invocation.
- **TDD-001 (System Core)**: The daily pruning job integrates with the daemon process supervisor's scheduling.
- **TDD-002 (Document Pipeline)**: Pipeline run IDs from the document pipeline are recorded in per-invocation metrics for traceability.

## Testing Strategy

**Unit tests:**
- Anomaly detector: threshold crossing fires alert; deduplication prevents duplicate alerts; auto-resolve after 5 good invocations; rolling window computation handles edge cases (fewer than 20 invocations for trend).
- Metrics aggregator: approval rate calculation with 0, 1, N invocations; trend regression with perfect improving/declining/stable data; domain segmentation with single and multiple domains.
- JSONL writer: concurrent appends; partial write recovery; file creation on first write.
- Observation tracker: threshold crossing; reset on version change; force bypass.

**Integration tests:**
- Agent invocation with metrics: invoke agent -> emit metric -> verify JSONL record exists -> verify SQLite record exists.
- Metrics graceful degradation: delete SQLite DB -> invoke agent -> verify JSONL write succeeds -> verify memory buffer populated -> recreate SQLite -> verify replay.
- Rollback cycle: promote v1.1.0 -> rollback -> verify v1.0.0 restored -> verify git commit -> verify registry reloaded -> verify audit log entry.
- Retention pruning: insert records spanning 120 days -> run pruning -> verify records > 90 days deleted from both stores -> verify aggregate snapshots retained.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SQLite write contention under concurrent invocations | Medium | Low | Async writes with bounded buffer; WAL mode for SQLite; JSONL is the durability guarantee |
| Linear regression on small sample sizes is unreliable | Medium | Low | Require minimum 5 invocations for trend analysis; flag low-confidence trends |
| JSONL file grows large over time | Low | Medium | 90-day retention pruning; JSONL rotation can be added as a future enhancement |
| Rollback of an agent mid-pipeline could cause inconsistency | Low | High | Display in-flight pipeline warning during rollback; require confirmation |

## Definition of Done

- [ ] Every agent invocation produces a complete metric record in both JSONL and SQLite
- [ ] Aggregate metrics are recomputed after each new invocation
- [ ] All 6 anomaly detection rules fire correctly with deduplication and auto-resolve
- [ ] Graceful degradation tested: SQLite unavailable -> JSONL continues -> recovery replay
- [ ] Retention pruning removes records older than 90 days without affecting aggregate snapshots
- [ ] All 13 foundation agents committed and passing validation
- [ ] Rollback mechanism tested end-to-end: rollback -> git commit -> registry reload -> audit log
- [ ] Observation state tracks per-agent invocation counts and respects threshold + per-agent overrides
- [ ] CLI `metrics`, `dashboard`, `rollback` commands functional
- [ ] All unit and integration tests pass
- [ ] Metrics collected for 50+ invocations across 5+ agents (Phase 1 exit criterion)
- [ ] At least 1 true positive anomaly alert confirmed (Phase 1 exit criterion)
