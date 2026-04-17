# PLAN-007-1: MCP Integration & Data Collection

## Metadata
- **Parent TDD**: TDD-007-production-intelligence
- **Estimated effort**: 8 days
- **Dependencies**: []
- **Blocked by**: [] (no blockers -- this is the foundational plan)
- **Priority**: P0

## Objective

Stand up the MCP server connections (Grafana, Prometheus, OpenSearch, Sentry) and the scheduled observation runner that drives the entire Production Intelligence Loop. This plan delivers the "plumbing" -- the ability to query monitoring backends on a cron schedule, enforce query budgets, and pass raw results downstream.

## Scope

### In Scope
- MCP server definitions in `.mcp.json` (section 3.1.1)
- MCP tool catalog wiring for Prometheus, Grafana, OpenSearch, Sentry (section 3.1.2)
- Connectivity validation at the start of each run (section 3.1.3)
- Per-source query budget enforcement (section 3.1.4)
- Scheduled observation runner lifecycle (section 3.2)
- Runner configuration loading from `intelligence.yaml` (section 3.2.1)
- Run ID generation and audit log initialization (section 3.2.2 steps 1a-1c)
- Data collection query templates for Prometheus PromQL, OpenSearch DSL, and Grafana API (section 3.3.1)
- Concurrency model with lock files (section 3.2.3)
- Directory structure creation (section 2.3)
- MCP server failure handling (section 6.1)
- File system failure handling for directory creation and lock files (section 6.4)
- Environment variable-based credential management (section 7.3)

### Out of Scope
- PII/secret scrubbing (PLAN-007-2)
- Error detection, severity scoring, deduplication, analytics (PLAN-007-3)
- Report generation and triage interface (PLAN-007-4)
- Governance (cooldown, oscillation, effectiveness tracking) (PLAN-007-5)
- Phase 3 Sentry advanced integration (PLAN-007-5 handles the auto-promote context; Sentry wiring here is connectivity only)
- Notification channel integration (Slack/Discord webhooks) -- Phase 3

## Tasks

1. **Define MCP server configuration** -- Create the `.mcp.json` plugin-level file with entries for Grafana, Prometheus, OpenSearch, and Sentry using `${ENV_VAR}` references for credentials.
   - Files to create/modify: `.mcp.json`
   - Acceptance criteria: All four MCP servers are declared with SSE type, environment variable-based URLs and tokens. No hardcoded credentials.
   - Estimated effort: 2 hours

2. **Create intelligence.yaml configuration schema** -- Define the primary configuration file at `.autonomous-dev/config/intelligence.yaml` with schedule, services, query templates, query budgets, and per-service overrides.
   - Files to create/modify: `.autonomous-dev/config/intelligence.yaml`, configuration schema documentation or validation logic
   - Acceptance criteria: Config file supports cron and simple interval schedule formats, per-service override deep-merge with defaults, and all query budget limits from TDD section 3.1.4.
   - Estimated effort: 4 hours

3. **Implement directory structure bootstrap** -- Write logic that ensures the full `.autonomous-dev/` directory tree exists (observations/YYYY/MM, digests, archive, baselines, fingerprints, logs/intelligence) before a run begins.
   - Files to create/modify: Runner initialization module
   - Acceptance criteria: Missing directories are created automatically. Existing directories are not overwritten. Works on first-ever run.
   - Estimated effort: 2 hours

4. **Build connectivity validation** -- Implement the MCP connectivity check that probes each configured server at the start of a run (e.g., `prometheus_query` with `up`), recording available/degraded/unreachable status.
   - Files to create/modify: Connectivity validation module
   - Acceptance criteria: Each server is probed with a lightweight call. Responses >5s are marked degraded. Unreachable servers are excluded from the run. Availability status is recorded in run metadata. If all servers are unreachable, the run aborts with a critical error log.
   - Estimated effort: 6 hours

5. **Implement query budget tracker** -- Build a per-source, per-service query counter that enforces the limits from TDD section 3.1.4 (Prometheus: 20, Grafana: 10, OpenSearch: 15, Sentry: 10) with per-query timeouts.
   - Files to create/modify: Query budget module
   - Acceptance criteria: Queries beyond the budget are blocked with a warning log. Query timeouts are enforced per TDD (30s/60s). Budget state is included in run metadata.
   - Estimated effort: 4 hours

6. **Build Prometheus query executor** -- Implement parameterized PromQL query execution via `prometheus_query` and `prometheus_query_range` MCP tools for the seven query templates (error rate, p50/p95/p99 latency, throughput, availability, error rate by endpoint).
   - Files to create/modify: Prometheus adapter module
   - Acceptance criteria: All seven query templates from TDD section 3.3.1 are implemented with parameterized `<job>` and `<window>` substitution. Results are returned in a structured format ready for downstream processing. Query budget is respected.
   - Estimated effort: 6 hours

7. **Build OpenSearch query executor** -- Implement OpenSearch search and aggregation queries via `opensearch_search` and `opensearch_aggregate` MCP tools for error log aggregation and error sample retrieval.
   - Files to create/modify: OpenSearch adapter module
   - Acceptance criteria: Both query templates from TDD section 3.3.1 are implemented with parameterized `<service>` and time window. Collapsed dedup on `message.keyword` works correctly. Results include `@timestamp`, `message`, `stack_trace`, `trace_id` fields.
   - Estimated effort: 6 hours

8. **Build Grafana query executor** -- Implement Grafana alert listing and annotation retrieval via `grafana_list_alerts` and `grafana_get_annotations` MCP tools.
   - Files to create/modify: Grafana adapter module
   - Acceptance criteria: Alert states (alerting, pending) are retrieved by dashboard UID. Deploy annotations are retrieved for the last 4 hours with tag filtering. Results are structured for downstream consumption.
   - Estimated effort: 4 hours

9. **Implement scheduled observation runner** -- Build the runner lifecycle (TDD section 3.2.2): initialize, load config, generate run ID, open audit log, validate connectivity, iterate services, call data collection for each service, finalize with token/query logging.
   - Files to create/modify: Observation runner main module, `/autonomous-dev:observe` command definition
   - Acceptance criteria: Runner executes the full lifecycle from initialize to finalize. Services are processed sequentially. Run metadata (run ID, start/end time, data source status, query counts, token consumption) is written to `logs/intelligence/RUN-<id>.log`. Lock file is created per-service and cleaned up on completion. Stale locks (>60 min) are cleaned.
   - Estimated effort: 10 hours

10. **Implement MCP error handling** -- Add retry logic and graceful degradation for MCP failures per TDD section 6.1 (retry once after 10s on mid-query timeout, proceed with partial data, abort if all sources unavailable).
    - Files to create/modify: Each MCP adapter module, runner error handling
    - Acceptance criteria: Mid-query timeout triggers one retry after 10s. Error responses are logged and the query is skipped. Partial data collection proceeds. All-unreachable aborts cleanly with a critical log entry.
    - Estimated effort: 4 hours

11. **Write unit and integration tests for MCP adapters** -- Create mock MCP server responses and test each adapter, connectivity validation, query budget enforcement, and the runner lifecycle.
    - Files to create/modify: Test files for each adapter, runner, connectivity, budget modules
    - Acceptance criteria: Each adapter has tests with mock responses for success, timeout, and error cases. Connectivity validation tests cover available/degraded/unreachable states. Budget enforcement tests confirm queries are blocked after limit. Runner lifecycle test confirms all steps execute in order.
    - Estimated effort: 12 hours

## Dependencies & Integration Points
- **Downstream**: PLAN-007-2 (scrubbing) receives raw data from the collection pipeline. PLAN-007-3 (analytics) receives scrubbed data. PLAN-007-4 (reports) consumes analysis output. PLAN-007-5 (governance) hooks into the runner lifecycle.
- **External**: Requires MCP server instances (or mocks) for Grafana, Prometheus, OpenSearch. Sentry MCP is Phase 3 but connectivity wiring is included here.
- **Plugin infrastructure**: Depends on the Claude Code `schedule` skill for cron-based triggering.
- **Configuration**: The `intelligence.yaml` schema defined here is consumed by all downstream plans.

## Testing Strategy
- **Unit tests**: Each MCP adapter tested with mock responses (success, timeout, error). Query budget counter tested for enforcement and reset. Config loader tested for schema validation and deep-merge.
- **Integration tests**: Full runner lifecycle with mock MCP servers. Graceful degradation when one or more sources are unavailable. Lock file creation and cleanup. Directory bootstrap on clean filesystem.
- **Manual validation**: Run against real MCP servers in a staging/dev environment to confirm query templates return expected data shapes.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| MCP server API changes break query templates | Medium | High | Pin MCP server versions in config. Connectivity validation catches breaking changes early. |
| Query budget too restrictive for services with many endpoints | Low | Medium | Budget is configurable in `intelligence.yaml`. Log when budget is exhausted so operators can adjust. |
| Lock file mechanism is insufficient for true concurrency | Low | Medium | Lock files are advisory. Document that multi-session runs should use non-overlapping service scopes. |
| Token consumption exceeds expectations for data collection phase | Medium | Medium | Log token counts per query. Add a per-run token budget check that halts collection early if exceeded (TDD section 6.3). |

## Definition of Done
- [ ] `.mcp.json` defines all four MCP server connections with environment variable credentials
- [ ] `intelligence.yaml` schema is defined and validated on load
- [ ] Directory structure is auto-created on first run
- [ ] Connectivity validation probes all configured servers and records status
- [ ] Query budgets are enforced per-source per-service with logging on exhaustion
- [ ] Prometheus, OpenSearch, and Grafana adapters execute all query templates from TDD
- [ ] Scheduled observation runner completes the full lifecycle (init -> collect -> finalize)
- [ ] MCP failure handling follows the retry/degradation behavior from TDD section 6.1
- [ ] Run audit log records run ID, timestamps, data source status, query counts, and errors
- [ ] Lock files prevent concurrent writes to the same service and are cleaned up after 60 minutes
- [ ] All unit and integration tests pass with >90% coverage on adapter and runner modules
