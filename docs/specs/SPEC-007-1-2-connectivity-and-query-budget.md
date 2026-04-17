# SPEC-007-1-2: Connectivity Validation & Query Budget Enforcement

## Metadata
- **Parent Plan**: PLAN-007-1
- **Tasks Covered**: Task 4 (connectivity validation), Task 5 (query budget tracker)
- **Estimated effort**: 10 hours

## Description

Implement the pre-run MCP connectivity probe and the per-source per-service query budget counter. These two components gate the data collection phase: connectivity validation determines which data sources are available for a given run, and the query budget prevents overloading monitoring backends.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/adapters/connectivity.ts` | Create | MCP server probe and status recording |
| `src/adapters/query-budget.ts` | Create | Per-source per-service query counter with timeout enforcement |
| `src/adapters/types.ts` | Create | Shared types: `DataSourceStatus`, `BudgetState`, `ConnectivityResult` |
| `tests/adapters/connectivity.test.ts` | Create | Unit tests with mock MCP responses |
| `tests/adapters/query-budget.test.ts` | Create | Budget enforcement unit tests |

## Implementation Details

### Task 4: Connectivity Validation

At the start of every observation run (lifecycle step 1d), the runner probes each configured MCP server with a lightweight call and classifies the result.

```typescript
type DataSourceStatus = 'available' | 'degraded' | 'unreachable' | 'not_configured';

interface ConnectivityResult {
  source: string;          // "prometheus" | "grafana" | "opensearch" | "sentry"
  status: DataSourceStatus;
  response_time_ms: number | null;
  error?: string;
}

interface ConnectivityReport {
  results: ConnectivityResult[];
  all_unreachable: boolean;
  timestamp: string;       // ISO 8601
}
```

**Probe calls per source**:

| Source | Probe Call | Success Criterion |
|--------|-----------|-------------------|
| Prometheus | `prometheus_query({ query: 'up' })` | Returns any result within timeout |
| Grafana | `grafana_list_alerts({ state: 'all', limit: 1 })` | Returns any response within timeout |
| OpenSearch | `opensearch_search({ index: '_cat/health', size: 0 })` | Returns any response within timeout |
| Sentry | `sentry_list_issues({ project: '<first_configured>', limit: 1 })` | Returns any response within timeout |

**Classification logic**:

```typescript
async function probeSource(source: string, probeCall: () => Promise<any>): Promise<ConnectivityResult> {
  const start = Date.now();
  try {
    await Promise.race([
      probeCall(),
      timeout(30_000)  // 30s hard timeout
    ]);
    const elapsed = Date.now() - start;
    return {
      source,
      status: elapsed > 5000 ? 'degraded' : 'available',
      response_time_ms: elapsed,
    };
  } catch (error) {
    return {
      source,
      status: 'unreachable',
      response_time_ms: null,
      error: String(error),
    };
  }
}
```

- Response <= 5s: `available`
- Response > 5s but < 30s: `degraded`
- Timeout or error: `unreachable`
- Not configured in `intelligence.yaml`: `not_configured`

**Abort condition**: If all configured (non-`not_configured`) sources return `unreachable`, the run aborts with a critical error log entry and exits without producing any observations.

**Degraded handling**: Degraded sources participate in the run normally but the degraded status is recorded in run metadata and observation report `data_sources` fields.

### Task 5: Query Budget Tracker

The budget tracker wraps every MCP query call. It enforces per-source per-service limits from `intelligence.yaml` and per-query timeouts.

```typescript
interface QueryBudgetConfig {
  max_queries_per_service: number;
  timeout_seconds: number;
}

interface BudgetState {
  source: string;
  service: string;
  queries_executed: number;
  queries_blocked: number;
  budget_exhausted: boolean;
}

class QueryBudgetTracker {
  private counts: Map<string, Map<string, number>> = new Map();
  // key: source, value: Map<service, count>

  constructor(private budgets: Record<string, QueryBudgetConfig>) {}

  canQuery(source: string, service: string): boolean {
    const budget = this.budgets[source];
    if (!budget) return false;
    const key = `${source}:${service}`;
    const current = this.getCount(source, service);
    return current < budget.max_queries_per_service;
  }

  recordQuery(source: string, service: string): void {
    // Increment counter
  }

  getTimeoutMs(source: string): number {
    return (this.budgets[source]?.timeout_seconds ?? 30) * 1000;
  }

  getState(): BudgetState[] {
    // Return current state for all source/service combinations
  }
}
```

**Default budgets from TDD section 3.1.4**:

| Source | Max Queries Per Service Per Run | Query Timeout |
|--------|-------------------------------|---------------|
| Prometheus | 20 | 30s |
| Grafana | 10 | 30s |
| OpenSearch | 15 | 60s |
| Sentry | 10 | 30s |

**Budget exhaustion behavior**:
1. When `canQuery()` returns false, log a warning: `Query budget exhausted for ${source}/${service} (${count}/${max})`
2. The blocked query is NOT executed
3. The runner proceeds with whatever data was collected before exhaustion
4. Budget state (queries executed, queries blocked per source per service) is included in run metadata

**Timeout enforcement**: Every query call is wrapped in `Promise.race([queryCall(), timeout(budget.timeout_seconds * 1000)])`. Timeout errors are caught and handled by the MCP error handling layer (SPEC-007-1-4).

## Acceptance Criteria

1. Each configured MCP server is probed with a lightweight call at the start of every observation run.
2. Responses are classified: <= 5s = `available`, > 5s = `degraded`, timeout/error = `unreachable`, not in config = `not_configured`.
3. Unreachable servers are excluded from the run's data collection. Degraded servers participate but are flagged.
4. If all configured servers are unreachable, the run aborts with a critical error log entry.
5. Connectivity results are recorded in run metadata (timestamps, response times, statuses).
6. Per-source per-service query counter enforces the configured maximum. Queries beyond the budget are blocked with a warning log.
7. Per-query timeouts are enforced per the budget configuration (Prometheus/Grafana/Sentry: 30s, OpenSearch: 60s).
8. Budget state (executed, blocked, exhausted) is included in run metadata at finalization.

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-1-2-01 | Probe available source | Mock Prometheus responds in 200ms | `status: 'available'`, `response_time_ms: ~200` |
| TC-1-2-02 | Probe degraded source | Mock Grafana responds in 7000ms | `status: 'degraded'`, `response_time_ms: ~7000` |
| TC-1-2-03 | Probe unreachable source | Mock OpenSearch times out | `status: 'unreachable'`, `response_time_ms: null` |
| TC-1-2-04 | Probe error response | Mock Sentry returns HTTP 500 | `status: 'unreachable'`, error message captured |
| TC-1-2-05 | Not configured source | Sentry not in services config | `status: 'not_configured'` |
| TC-1-2-06 | All unreachable aborts run | All 3 configured sources unreachable | `all_unreachable: true`, run aborts with critical log |
| TC-1-2-07 | Partial availability | Prometheus available, Grafana unreachable, OpenSearch degraded | Run proceeds, Grafana excluded, OpenSearch flagged degraded |
| TC-1-2-08 | Budget allows queries under limit | Prometheus, service A, 5 queries executed | `canQuery('prometheus', 'A')` returns true (5 < 20) |
| TC-1-2-09 | Budget blocks at limit | Prometheus, service A, 20 queries executed | `canQuery('prometheus', 'A')` returns false, warning logged |
| TC-1-2-10 | Budget is per-service | Prometheus: service A=20 (exhausted), service B=0 | `canQuery('prometheus', 'B')` returns true |
| TC-1-2-11 | Timeout enforcement | Query takes 45s with 30s budget | Query rejected after 30s timeout |
| TC-1-2-12 | Budget state in metadata | 15 Prometheus, 8 Grafana, 2 blocked | `getState()` returns correct counts for each |
| TC-1-2-13 | OpenSearch longer timeout | OpenSearch query at 50s with 60s timeout | Query succeeds (under 60s limit) |
