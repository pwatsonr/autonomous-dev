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

Run the observation runner lifecycle for the Production Intelligence Loop.

## What this does

Executes the full 4-phase observation lifecycle:

1. **Initialize** -- Generate run ID, load config, bootstrap directories, validate MCP connectivity
2. **Triage** -- Process any pending triage decisions from previous runs
3. **Service Loop** -- For each service in scope:
   - Acquire advisory lock (prevents concurrent processing)
   - Collect data from Prometheus, Grafana, and OpenSearch via MCP
   - Scrub collected data (PII/secret removal)
   - Analyze for anomalies and trends
   - Deduplicate against existing observations
   - Apply governance checks (cooldowns, oscillation)
   - Generate reports
4. **Finalize** -- Write run metadata and audit log

## Usage

Process all configured services:
```
/autonomous-dev:observe
```

Process a single service:
```
/autonomous-dev:observe scope=api-gateway
```

Override run ID (for testing):
```
/autonomous-dev:observe run-id=RUN-20260408-143000
```

## Output

The run produces:
- Audit log at `.autonomous-dev/logs/intelligence/RUN-<id>.log`
- Observation files in `.autonomous-dev/observations/YYYY/MM/`
- Lock files during execution at `.autonomous-dev/observations/.lock-<service>`

## Error Handling

- If an MCP source is unavailable, the run continues with partial data
- If all MCP sources are unreachable, the run aborts with a critical log entry
- Mid-query timeouts trigger exactly one retry after 10 seconds
- Lock conflicts wait up to 5 minutes with exponential backoff before skipping
