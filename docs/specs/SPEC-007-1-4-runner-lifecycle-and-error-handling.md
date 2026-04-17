# SPEC-007-1-4: Observation Runner Lifecycle & MCP Error Handling

## Metadata
- **Parent Plan**: PLAN-007-1
- **Tasks Covered**: Task 9 (scheduled observation runner), Task 10 (MCP error handling), Task 11 (unit/integration tests)
- **Estimated effort**: 26 hours

## Description

Implement the observation runner that orchestrates the full lifecycle from initialization through finalization, including run ID generation, audit logging, concurrency control via lock files, and the `/autonomous-dev:observe` command. Also implement MCP failure handling with retry logic and graceful degradation, and the comprehensive test suite for all PLAN-007-1 components.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/runner/observation-runner.ts` | Create | Main runner lifecycle orchestrator |
| `src/runner/run-id.ts` | Create | Run ID generation and audit log initialization |
| `src/runner/lock-manager.ts` | Create | Per-service lock file creation, checking, and stale lock cleanup |
| `src/runner/audit-logger.ts` | Create | Run-level audit log writer |
| `src/adapters/mcp-error-handler.ts` | Create | Retry logic and graceful degradation wrapper |
| `commands/observe.md` | Create | `/autonomous-dev:observe` command definition |
| `tests/runner/observation-runner.test.ts` | Create | Runner lifecycle integration tests |
| `tests/runner/lock-manager.test.ts` | Create | Lock file unit tests |
| `tests/adapters/mcp-error-handler.test.ts` | Create | Retry and degradation tests |
| `tests/integration/full-collection-run.test.ts` | Create | End-to-end integration test with mock MCP servers |

## Implementation Details

### Task 9: Scheduled Observation Runner

The runner implements the lifecycle from TDD section 3.2.2. Services are processed sequentially within a single session to stay within the 200K token budget (NFR-005).

**Run ID format**: `RUN-YYYYMMDD-HHMMSS` (e.g., `RUN-20260408-143000`)

```typescript
interface RunMetadata {
  run_id: string;
  started_at: string;       // ISO 8601
  completed_at: string;     // ISO 8601
  services_in_scope: string[];
  data_source_status: Record<string, DataSourceStatus>;
  observations_generated: number;
  observations_deduplicated: number;
  observations_filtered: number;
  triage_decisions_processed: number;
  total_tokens_consumed: number;
  queries_executed: Record<string, number>;
  errors: string[];
}

class ObservationRunner {
  async run(scope: string | 'all'): Promise<RunMetadata> {
    // 1. INITIALIZE
    const runId = generateRunId();                          // RUN-YYYYMMDD-HHMMSS
    const auditLog = new AuditLogger(runId);
    const config = loadConfig(CONFIG_PATH);
    await bootstrapDirectories(ROOT_DIR);
    const connectivity = await validateConnectivity(config);

    if (connectivity.all_unreachable) {
      auditLog.critical('All MCP servers unreachable. Aborting run.');
      return abortedRunMetadata(runId, connectivity);
    }
    auditLog.info(`Connectivity: ${JSON.stringify(connectivity.results)}`);

    // 2. PROCESS PENDING TRIAGE (delegates to PLAN-007-4 triage processor)
    const triageCount = await processPendingTriage(config);

    // 3. FOR EACH SERVICE IN SCOPE
    const services = scope === 'all'
      ? config.services
      : config.services.filter(s => s.name === scope);

    const budget = new QueryBudgetTracker(config.query_budgets);
    const observations: CandidateObservation[] = [];

    for (const service of services) {
      // 3a. Acquire lock
      const lock = await this.lockManager.acquire(service.name);
      if (!lock) {
        auditLog.warn(`Skipping ${service.name}: lock held by another session`);
        continue;
      }

      try {
        // 3a. DATA COLLECTION
        const rawData = await this.collectData(service, connectivity, budget);

        // 3b. DATA SAFETY (delegates to PLAN-007-2 scrub pipeline)
        const scrubbedData = await scrubCollectedData(rawData);

        // 3c. ANALYSIS (delegates to PLAN-007-3 intelligence engine)
        const candidates = await analyzeData(scrubbedData, service, config);

        // 3d. DEDUPLICATION (delegates to PLAN-007-3)
        const deduped = await deduplicateCandidates(candidates, service);

        // 3e. GOVERNANCE CHECK (delegates to PLAN-007-5)
        const governed = await applyGovernanceChecks(deduped, service, config);

        // 3f. REPORT GENERATION (delegates to PLAN-007-4)
        await generateReports(governed, service, runId);

        observations.push(...governed);
      } finally {
        await this.lockManager.release(service.name);
      }
    }

    // 4. FINALIZE
    const metadata = buildRunMetadata(runId, services, connectivity, budget, observations, triageCount);
    await auditLog.writeMetadata(metadata);
    await auditLog.close();

    return metadata;
  }
}
```

**Lock file management**:

```typescript
class LockManager {
  private lockDir: string; // .autonomous-dev/observations/

  async acquire(serviceName: string): Promise<boolean> {
    const lockFile = path.join(this.lockDir, `.lock-${serviceName}`);
    // Check if lock exists
    if (await this.lockExists(lockFile)) {
      // Check if stale (>60 minutes old)
      if (await this.isStale(lockFile, 60 * 60 * 1000)) {
        await this.cleanStaleLock(lockFile);
      } else {
        // Wait up to 5 minutes with exponential backoff
        const acquired = await this.waitForLock(lockFile, 5 * 60 * 1000);
        if (!acquired) return false;
      }
    }
    // Write lock file with PID and timestamp
    await fs.writeFile(lockFile, JSON.stringify({
      pid: process.pid,
      acquired_at: new Date().toISOString(),
      service: serviceName,
    }));
    return true;
  }

  async release(serviceName: string): Promise<void> {
    const lockFile = path.join(this.lockDir, `.lock-${serviceName}`);
    await fs.unlink(lockFile).catch(() => {});
  }

  async cleanStaleLocks(): Promise<string[]> {
    // Find all .lock-* files older than 60 minutes
    // Remove them and return list of cleaned lock names
  }
}
```

**Audit log format** (written to `.autonomous-dev/logs/intelligence/RUN-<id>.log`):

```
[2026-04-08T14:30:00Z] [INFO] Run RUN-20260408-143000 started
[2026-04-08T14:30:01Z] [INFO] Config loaded: 3 services in scope
[2026-04-08T14:30:02Z] [INFO] Connectivity: prometheus=available, grafana=available, opensearch=degraded
[2026-04-08T14:30:05Z] [INFO] Service api-gateway: collecting data...
[2026-04-08T14:30:15Z] [INFO] Service api-gateway: 7 prometheus queries, 2 opensearch queries, 2 grafana queries
[2026-04-08T14:30:16Z] [INFO] Service api-gateway: scrubbing (12 email, 34 ip redactions)
...
[2026-04-08T14:35:00Z] [INFO] Run completed. 2 observations generated. 38200 tokens consumed.
```

**`/autonomous-dev:observe` command** (`commands/observe.md`):

```markdown
---
name: observe
description: Run the Production Intelligence Loop observation cycle
arguments:
  - name: scope
    description: Service name or "all"
    required: false
    default: "all"
  - name: run-id
    description: Override run ID (mainly for testing)
    required: false
allowed_tools:
  - prometheus_query
  - prometheus_query_range
  - grafana_list_alerts
  - grafana_get_annotations
  - opensearch_search
  - opensearch_aggregate
  - Read
  - Write
  - Bash
---
```

### Task 10: MCP Error Handling

Wrap all MCP adapter calls with retry and degradation logic per TDD section 6.1.

```typescript
interface McpErrorPolicy {
  max_retries: number;          // 1
  retry_delay_ms: number;       // 10_000 (10 seconds)
  timeout_ms: number;           // From query budget
}

async function withMcpRetry<T>(
  operation: () => Promise<T>,
  policy: McpErrorPolicy,
  context: { source: string; query: string; service: string },
  auditLog: AuditLogger
): Promise<T | null> {
  try {
    return await Promise.race([
      operation(),
      rejectAfter(policy.timeout_ms)
    ]);
  } catch (firstError) {
    auditLog.warn(
      `MCP ${context.source} query failed for ${context.service}: ${firstError}. ` +
      `Retrying in ${policy.retry_delay_ms}ms...`
    );

    // Wait 10 seconds before retry
    await delay(policy.retry_delay_ms);

    try {
      return await Promise.race([
        operation(),
        rejectAfter(policy.timeout_ms)
      ]);
    } catch (secondError) {
      auditLog.error(
        `MCP ${context.source} retry failed for ${context.service}: ${secondError}. ` +
        `Skipping query: ${context.query}`
      );
      return null; // Graceful degradation: return null, caller handles partial data
    }
  }
}
```

**Error handling behaviors**:

| Failure | Behavior |
|---------|----------|
| Mid-query timeout | Retry once after 10s. Second failure returns null, query skipped |
| Error response (4xx/5xx) | Log error code, skip query, continue with remaining |
| All sources unavailable | Abort run cleanly with critical log entry |
| Partial data collection | Proceed with available data; note gaps in observation `data_sources` |

### Task 11: Test Suite

**Unit tests**:
- Config loader: valid/invalid/partial configs, deep-merge, interval conversion
- Connectivity: available/degraded/unreachable/not_configured states
- Query budget: under limit, at limit, per-service isolation, state reporting
- Each adapter: mock MCP responses for success, timeout, error
- Lock manager: acquire, release, stale detection, concurrent access
- Audit logger: format, write, close

**Integration tests**:
- Full runner lifecycle with all MCP servers mocked as available
- Runner with one source unavailable (partial data collection)
- Runner with all sources unavailable (abort)
- Lock file prevents concurrent writes to same service
- Stale lock cleanup after 60 minutes
- Query budget exhaustion mid-service (proceeds with partial data)
- MCP retry on timeout (first fail, second succeed)
- MCP retry exhaustion (both attempts fail, graceful skip)

## Acceptance Criteria

1. Runner executes the full lifecycle: initialize -> load config -> generate run ID -> validate connectivity -> iterate services -> collect/scrub/analyze/dedup/govern/report -> finalize.
2. Run ID follows `RUN-YYYYMMDD-HHMMSS` format.
3. Services are processed sequentially within a single session.
4. Run metadata (run ID, start/end time, data source status, query counts, token consumption, errors) is written to `logs/intelligence/RUN-<id>.log`.
5. Lock file `.lock-<service-name>` is created before processing and removed after. Lock file contains PID and timestamp.
6. Stale locks (>60 minutes old) are automatically cleaned at the start of each run.
7. Lock conflict triggers up to 5 minutes of exponential backoff wait. Persistent lock causes the service to be skipped.
8. Mid-query timeout triggers exactly one retry after 10 seconds.
9. Second timeout failure skips the query, logs the error, and proceeds with collected data.
10. All-unreachable aborts cleanly with a critical log entry and no partial observation files.
11. The `/autonomous-dev:observe` command definition includes scope and run-id arguments with correct `allowed_tools`.
12. All unit and integration tests pass with >90% coverage on adapter, runner, connectivity, budget, and lock modules.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-1-4-01 | Run ID format | Current time 2026-04-08 14:30:00 | `RUN-20260408-143000` |
| TC-1-4-02 | Full lifecycle happy path | 2 services, all sources available | Run completes, 2 services processed, metadata written |
| TC-1-4-03 | Partial source availability | Prometheus available, Grafana unreachable | Run completes with Prometheus data only, metadata notes Grafana unreachable |
| TC-1-4-04 | All sources unreachable | All 3 configured sources unreachable | Run aborts, critical log, no observation files |
| TC-1-4-05 | Lock acquisition | No existing lock | Lock file created with PID and timestamp |
| TC-1-4-06 | Lock conflict wait | Lock held by other process, released after 30s | Waits with backoff, acquires after release |
| TC-1-4-07 | Lock conflict timeout | Lock held for >5 minutes | Service skipped, warning logged |
| TC-1-4-08 | Stale lock cleanup | Lock file 90 minutes old | Lock cleaned, service proceeds |
| TC-1-4-09 | MCP retry success | First call times out, second succeeds | Result from second call returned, warning logged |
| TC-1-4-10 | MCP retry exhaustion | Both calls time out | Null returned, error logged, run continues |
| TC-1-4-11 | MCP error response | MCP returns HTTP 500 | Error logged, query skipped, next query proceeds |
| TC-1-4-12 | Sequential service processing | 3 services | Processed one at a time, not in parallel |
| TC-1-4-13 | Audit log completeness | Full run with 2 services | Log contains init, connectivity, per-service entries, and finalize |
| TC-1-4-14 | Token tracking | Run with mock token counts | `total_tokens_consumed` in metadata reflects sum |
| TC-1-4-15 | Lock release on error | Service processing throws | Lock file is released in finally block |
