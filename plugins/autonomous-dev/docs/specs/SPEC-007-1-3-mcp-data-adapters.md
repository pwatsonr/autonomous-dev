# SPEC-007-1-3: MCP Data Collection Adapters

## Metadata
- **Parent Plan**: PLAN-007-1
- **Tasks Covered**: Task 6 (Prometheus adapter), Task 7 (OpenSearch adapter), Task 8 (Grafana adapter)
- **Estimated effort**: 16 hours

## Description

Implement the three Phase 1 MCP data collection adapters: Prometheus (PromQL queries for error rates, latency percentiles, throughput, availability), OpenSearch (error log aggregation and sample retrieval), and Grafana (alert states and deploy annotations). Each adapter executes parameterized query templates via MCP tool calls, respects the query budget, and returns structured results for downstream scrubbing and analysis.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/adapters/prometheus-adapter.ts` | Create | Parameterized PromQL query execution via MCP |
| `src/adapters/opensearch-adapter.ts` | Create | OpenSearch search and aggregation via MCP |
| `src/adapters/grafana-adapter.ts` | Create | Grafana alert listing and annotation retrieval via MCP |
| `src/adapters/types.ts` | Modify | Add adapter result types |
| `tests/adapters/prometheus-adapter.test.ts` | Create | Tests with mock MCP responses |
| `tests/adapters/opensearch-adapter.test.ts` | Create | Tests with mock MCP responses |
| `tests/adapters/grafana-adapter.test.ts` | Create | Tests with mock MCP responses |

## Implementation Details

### Task 6: Prometheus Adapter

Seven parameterized query templates. Each query substitutes `<job>` from `service.prometheus_job` and `<window>` from context (default `5m` for instant, `30m` for sustained, `7d/14d/30d` for trends).

**Query templates**:

```typescript
const PROMETHEUS_QUERIES = {
  error_rate: (job: string, window: string) =>
    `sum(rate(http_requests_total{job="${job}",status=~"5.."}[${window}])) / sum(rate(http_requests_total{job="${job}"}[${window}])) * 100`,

  latency_p50: (job: string, window: string) =>
    `histogram_quantile(0.50, sum(rate(http_request_duration_seconds_bucket{job="${job}"}[${window}])) by (le)) * 1000`,

  latency_p95: (job: string, window: string) =>
    `histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{job="${job}"}[${window}])) by (le)) * 1000`,

  latency_p99: (job: string, window: string) =>
    `histogram_quantile(0.99, sum(rate(http_request_duration_seconds_bucket{job="${job}"}[${window}])) by (le)) * 1000`,

  throughput: (job: string, window: string) =>
    `sum(rate(http_requests_total{job="${job}"}[${window}]))`,

  availability: (job: string, window: string) =>
    `avg_over_time(up{job="${job}"}[${window}]) * 100`,

  error_rate_by_endpoint: (job: string, window: string) =>
    `topk(5, sum by (handler) (rate(http_requests_total{job="${job}",status=~"5.."}[${window}])) / sum by (handler) (rate(http_requests_total{job="${job}"}[${window}])) * 100)`,
};
```

**Additional detection queries**:

```typescript
const DETECTION_QUERIES = {
  crash_down: (job: string) =>
    `up{job="${job}"} == 0`,

  crash_restarts: (job: string, window: string) =>
    `changes(up{job="${job}"}[${window}])`,

  sustained_error_rate: (job: string, window: string) =>
    // Range query at 1-minute resolution for sustained duration check
    `sum(rate(http_requests_total{job="${job}",status=~"5.."}[1m])) / sum(rate(http_requests_total{job="${job}"}[1m])) * 100`,
};
```

**Adapter interface**:

```typescript
interface PrometheusResult {
  query_name: string;
  query: string;
  value: number | null;
  timestamp: string;
  labels?: Record<string, string>;
  raw_response: any;  // Will be scrubbed downstream
}

interface PrometheusRangeResult extends PrometheusResult {
  data_points: Array<{ timestamp: string; value: number }>;
}

class PrometheusAdapter {
  constructor(
    private budget: QueryBudgetTracker,
    private config: IntelligenceConfig
  ) {}

  async collectServiceMetrics(service: ServiceConfig): Promise<PrometheusResult[]> {
    const results: PrometheusResult[] = [];
    const job = service.prometheus_job;

    // Execute each query template, checking budget before each call
    for (const [name, queryFn] of Object.entries(PROMETHEUS_QUERIES)) {
      if (!this.budget.canQuery('prometheus', service.name)) {
        break; // Budget exhausted
      }
      const query = queryFn(job, '5m');
      const result = await this.executeQuery(name, query);
      this.budget.recordQuery('prometheus', service.name);
      results.push(result);
    }

    return results;
  }

  async querySustainedErrorRate(
    service: ServiceConfig,
    durationMinutes: number
  ): Promise<PrometheusRangeResult> {
    // Range query at 1-minute step over the sustained duration window
    // MCP call: prometheus_query_range(query, start, end, step='60s')
  }

  private async executeQuery(name: string, query: string): Promise<PrometheusResult> {
    // Call prometheus_query MCP tool
    // Wrap with budget timeout
    // Return structured result
  }
}
```

### Task 7: OpenSearch Adapter

Two query templates: error log aggregation (top error messages with counts) and error sample retrieval (latest unique errors with stack traces).

**Query 1: Error log aggregation**:

```typescript
function buildErrorAggregationQuery(service: string, windowHours: number = 4): object {
  return {
    query: {
      bool: {
        must: [
          { match: { level: "ERROR" } },
          { range: { "@timestamp": { gte: `now-${windowHours}h` } } }
        ],
        filter: [
          { term: { "service.name": service } }
        ]
      }
    },
    aggs: {
      error_messages: {
        terms: { field: "message.keyword", size: 20 }
      }
    },
    size: 50,
    _source: ["@timestamp", "message", "level", "stack_trace", "trace_id"]
  };
}
```

**Query 2: Error sample retrieval** (collapsed/deduped):

```typescript
function buildErrorSampleQuery(service: string, windowHours: number = 4): object {
  return {
    query: {
      bool: {
        must: [
          { match: { level: "ERROR" } },
          { range: { "@timestamp": { gte: `now-${windowHours}h` } } }
        ],
        filter: [
          { term: { "service.name": service } }
        ]
      }
    },
    collapse: { field: "message.keyword" },
    sort: [{ "@timestamp": "desc" }],
    size: 10,
    _source: ["@timestamp", "message", "stack_trace", "trace_id", "user_id", "request_path"]
  };
}
```

**Adapter interface**:

```typescript
interface OpenSearchResult {
  query_name: string;
  hits: Array<{
    timestamp: string;
    message: string;     // Will be scrubbed
    stack_trace?: string; // Will be scrubbed
    trace_id?: string;
    user_id?: string;    // Will be scrubbed (PII context-aware UUID)
    request_path?: string;
  }>;
  aggregations?: {
    error_messages: Array<{ key: string; doc_count: number }>;
  };
  total_hits: number;
}

class OpenSearchAdapter {
  async collectServiceLogs(service: ServiceConfig): Promise<OpenSearchResult[]> {
    // Execute both queries, respecting budget
    // opensearch_search for aggregation
    // opensearch_search for sample retrieval (collapsed)
  }
}
```

**Key requirement**: The `collapse` on `message.keyword` ensures deduplication of error messages. The response MUST include `@timestamp`, `message`, `stack_trace`, and `trace_id` fields.

### Task 8: Grafana Adapter

Two query types: alert state listing and deploy annotation retrieval.

```typescript
interface GrafanaAlertResult {
  alerts: Array<{
    name: string;
    state: 'alerting' | 'pending' | 'ok' | 'no_data';
    dashboard_uid: string;
    since: string;         // ISO 8601
    annotations?: Record<string, string>;
  }>;
}

interface GrafanaAnnotationResult {
  annotations: Array<{
    id: number;
    time: string;          // ISO 8601
    text: string;          // Will be scrubbed
    tags: string[];
    dashboard_uid: string;
  }>;
}

class GrafanaAdapter {
  async listAlerts(
    dashboardUid: string,
    states: string[] = ['alerting', 'pending']
  ): Promise<GrafanaAlertResult> {
    // MCP call: grafana_list_alerts(dashboard_uid, state)
    // Filter to configured dashboard
  }

  async getAnnotations(
    dashboardUid: string,
    windowHours: number = 4,
    tags: string[] = ['deploy']
  ): Promise<GrafanaAnnotationResult> {
    // MCP call: grafana_get_annotations(dashboard_uid, from, to, tags)
    // from = now - windowHours, to = now
  }
}
```

## Acceptance Criteria

1. All seven Prometheus query templates from TDD section 3.3.1 are implemented with parameterized `<job>` and `<window>` substitution.
2. Prometheus adapter returns structured results with query name, numeric value, timestamp, and optional labels.
3. Sustained error rate check uses `prometheus_query_range` with 1-minute step resolution over the configured duration.
4. Both OpenSearch query templates are implemented: error aggregation with top-20 `message.keyword` terms, and error sample retrieval with `collapse` on `message.keyword`.
5. OpenSearch results include `@timestamp`, `message`, `stack_trace`, `trace_id` fields.
6. Grafana adapter retrieves alert states filtered by `alerting` and `pending` for the configured dashboard UID.
7. Grafana adapter retrieves deploy annotations for the last 4 hours with `deploy` tag filtering.
8. All adapters check `budget.canQuery()` before every MCP call and call `budget.recordQuery()` after.
9. Each adapter handles the case where the source was marked `unreachable` during connectivity validation (returns empty results without attempting queries).

## Test Cases

| ID | Test | Input | Expected |
|----|------|-------|----------|
| TC-1-3-01 | Prometheus error rate query | Job `api-gateway`, window `5m` | PromQL: `sum(rate(http_requests_total{job="api-gateway",status=~"5.."}[5m])) / sum(rate(http_requests_total{job="api-gateway"}[5m])) * 100` |
| TC-1-3-02 | Prometheus range query | Job `api-gateway`, 30min sustained | Range query with step=60s, correct start/end timestamps |
| TC-1-3-03 | Prometheus result parsing | Mock returns `{ value: [1712588400, "12.3"] }` | `PrometheusResult.value === 12.3` |
| TC-1-3-04 | Prometheus budget respected | Budget at 19/20, execute query | Query executes; next call at 20/20 is blocked |
| TC-1-3-05 | Prometheus unavailable | Source status `unreachable` | Returns empty results, no MCP calls made |
| TC-1-3-06 | OpenSearch aggregation query | Service `api-gateway`, 4h window | Query matches TDD section 3.3.1 aggregation template exactly |
| TC-1-3-07 | OpenSearch collapse dedup | Mock returns 10 unique error messages | Result has 10 hits with distinct `message` values |
| TC-1-3-08 | OpenSearch result fields | Mock response with all fields | Each hit contains `@timestamp`, `message`, `stack_trace`, `trace_id` |
| TC-1-3-09 | Grafana alert listing | Dashboard UID `abc123`, states `alerting,pending` | MCP call with correct params; result structured with name, state, since |
| TC-1-3-10 | Grafana annotations | Dashboard UID `abc123`, last 4h, tag `deploy` | Annotations filtered by time range and tag; text field preserved for scrubbing |
| TC-1-3-11 | All adapters timeout handling | Query exceeds budget timeout | Timeout error thrown, caught by caller |
| TC-1-3-12 | Latency in milliseconds | Prometheus returns 0.045 seconds | Adapter multiplies by 1000, returns 45 ms |
