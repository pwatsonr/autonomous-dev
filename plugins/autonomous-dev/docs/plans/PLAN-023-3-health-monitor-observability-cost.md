# PLAN-023-3: Health Monitor + Observability + Cost Cap Enforcement

## Metadata
- **Parent TDD**: TDD-023-deployment-backend-framework-core
- **Estimated effort**: 4 days
- **Dependencies**: []
- **Blocked by**: [PLAN-023-1, PLAN-023-2]
- **Priority**: P0

## Objective
Complete the deployment subsystem by delivering: (1) a continuous health-check monitor per TDD §12 that polls each deployed instance against its declared SLA and triggers automatic rollback or escalation on sustained failure; (2) per-deploy observability per TDD §13 with isolated log directories at `<request>/.autonomous-dev/deploy-logs/<deployId>/`, structured `deploy.log` JSONL output, and integration with the existing TDD-007 metrics pipeline; (3) cost-cap enforcement per TDD §14 with daily aggregation across all deploys, escalation at 80% / 100% / 110% thresholds (mirroring PLAN-017-4's budget-gate pattern), and HMAC-signed cost ledger entries.

## Scope
### In Scope
- `HealthMonitor` class at `src/deploy/monitor.ts` per TDD §12: background loop polling each active deployment's `healthCheck()` at the configured interval (default 30s, configurable per backend in `deploy.yaml`)
- SLA tracking: each deployment declares an `sla.uptime_pct` (default 0.99) and `sla.consecutive_failures_for_rollback` (default 3). Monitor tracks healthy/unhealthy status over a rolling window.
- Auto-rollback trigger: when consecutive failures exceed the threshold, the monitor invokes the backend's `rollback()`. On rollback success, an escalation notes the auto-rollback. On rollback failure, an escalation requests operator intervention.
- Health-check timeout per check (default 5s, configurable). Slow health checks count as failures.
- Per-deploy log directory: `<request>/.autonomous-dev/deploy-logs/<deployId>/` with subdirs `build/` (stdout/stderr from build), `deploy/` (deploy invocation logs), `health/` (health check results), `monitor/` (monitor loop log). All logs are JSONL with `{ts, level, message, fields}`.
- `DeployLogger` at `src/deploy/logger.ts` that opens a per-deploy log file and emits structured lines. Used by all backend invocations and the monitor.
- Integration with TDD-007 metrics pipeline: each health check, rollback, escalation emits `{deployId, env, backend, event, timestamp}` events
- `deploy.cost.ledger.json` at `~/.autonomous-dev/deploy-cost-ledger.jsonl` with one HMAC-signed entry per deploy: `{deployId, env, backend, estimated_cost_usd, actual_cost_usd?, timestamp, hmac, prev_hmac}`. Mirrors PLAN-019-4's audit log pattern.
- Cost-cap enforcement at three thresholds per TDD §14 (mirroring PLAN-017-4): 80% warns, 100% fails new deploys, 110% requires admin override. Caps are operator-configurable in `~/.claude/autonomous-dev.json` `deploy.global_caps`.
- `autonomous-dev deploy cost` CLI shows month-to-date and day-to-date deploy spend with breakdown by env and backend
- `autonomous-dev deploy monitor [--deploy <id>]` CLI streams the monitor's log lines for live observability
- CLI `autonomous-dev deploy logs <deployId> [--component build|deploy|health|monitor]` prints the per-deploy logs
- Unit tests for: monitor loop scheduling, SLA computation, auto-rollback trigger, cost-cap thresholds, ledger HMAC chain
- Integration test: full deploy lifecycle with health monitoring → simulated failure → auto-rollback → escalation

### Out of Scope
- Backend interface, bundled backends, parameter validation, HMAC-signed records -- delivered by PLAN-023-1
- Multi-environment config, backend selection, approval gates -- delivered by PLAN-023-2
- Cloud backends -- TDD-024
- Service mesh, comprehensive monitoring system replacement (NG list in TDD §2)
- Auto-scaling, load-balancer health checks (basic per-deploy health only)
- Cost cap dashboard / portal page (data is exposed via CLI; portal integration is a separate plan)
- Cross-cloud cost aggregation (each backend reports its own cost; aggregation is per-deploy not per-org)

## Tasks

1. **Implement `HealthMonitor` class** -- Create `src/deploy/monitor.ts` with a `start()` method that iterates over active deployments and polls `healthCheck()` at the configured interval. Returns health status and SLA computation. Uses `setInterval` for the loop (cancelable on shutdown).
   - Files to create: `plugins/autonomous-dev/src/deploy/monitor.ts`
   - Acceptance criteria: Monitor polls each active deploy at the configured interval. Stops cleanly on `stop()`. Tests use mocked timers and verify polling cadence.
   - Estimated effort: 3h

2. **Implement SLA tracking and auto-rollback** -- Track healthy/unhealthy status in a rolling window. After N consecutive failures (default 3), invoke `backend.rollback(record)`. On rollback success, record a "auto-rollback" deployment record. On rollback failure, escalate to operator.
   - Files to modify: `plugins/autonomous-dev/src/deploy/monitor.ts`
   - Acceptance criteria: Three consecutive failed health checks trigger rollback. Two failures + 1 success resets the counter. Successful rollback records a new deployment with `cause: 'auto-rollback'`. Failed rollback escalates with the rollback error. Tests cover all three scenarios.
   - Estimated effort: 4h

3. **Implement per-deploy log directory structure** -- Create the directory layout at `<request>/.autonomous-dev/deploy-logs/<deployId>/{build,deploy,health,monitor}/`. Each subdir holds JSONL log files. `DeployLogger` opens the appropriate file based on component.
   - Files to create: `plugins/autonomous-dev/src/deploy/logger.ts`
   - Acceptance criteria: Logger creates the directory structure on first write. Log lines are JSONL with `{ts, level, message, fields}`. Concurrent writes from build + deploy don't conflict (separate files). File size capped at 100MB per component, then rotates to `build.log.1`, etc. Tests verify directory creation and rotation.
   - Estimated effort: 3h

4. **Wire `DeployLogger` into backends** -- Each bundled backend (PLAN-023-1) accepts a logger instance and emits structured events at key points (build start/end, deploy start/end, health check pass/fail).
   - Files to modify: 4 backend files in `plugins/autonomous-dev/src/deploy/backends/`
   - Acceptance criteria: After a `local` backend deploy, `<request>/.autonomous-dev/deploy-logs/<deployId>/build/build.log` has lines for `[INFO] build_started`, `[INFO] commit_validated`, `[INFO] build_completed`. Similarly for deploy and health. Tests verify log line presence per phase.
   - Estimated effort: 2h

5. **Telemetry integration** -- Emit `{deployId, env, backend, event, timestamp, fields}` per significant event (build_complete, deploy_started, deploy_completed, health_check_failed, auto_rollback_triggered, etc.) to the TDD-007 metrics pipeline.
   - Files to modify: `plugins/autonomous-dev/src/deploy/monitor.ts`, backend files
   - Acceptance criteria: Each documented event produces one telemetry event. Event types are stable (used in dashboard queries). Tests verify emission counts.
   - Estimated effort: 1.5h

6. **Implement deploy cost ledger** -- Create `src/deploy/cost-ledger.ts` that appends an HMAC-signed entry to `~/.autonomous-dev/deploy-cost-ledger.jsonl` per deploy. Each entry: `{deployId, env, backend, estimated_cost_usd, actual_cost_usd?, timestamp, hmac, prev_hmac}`. Mirrors PLAN-019-4's audit-writer.
   - Files to create: `plugins/autonomous-dev/src/deploy/cost-ledger.ts`
   - Acceptance criteria: Each deploy produces one ledger entry. HMAC chain is intact. Ledger file uses two-phase commit (temp + rename). Daemon restart resumes from the last entry's HMAC. Tests verify chain integrity.
   - Estimated effort: 3h

7. **Implement cost-cap enforcement** -- Aggregate `deploy.global_caps.cost_cap_usd_per_day` from the ledger for the current day. Three thresholds per TDD §14: 80% warns (sticky escalation), 100% fails new deploys, 110% requires admin override. Mirrors PLAN-017-4 budget-gate pattern.
   - Files to create: `plugins/autonomous-dev/src/deploy/cost-cap-enforcer.ts`
   - Acceptance criteria: With $80 spent against $100 cap, next deploy emits a warning escalation. At $100, deploy is rejected with `DailyCostCapExceededError`. At $110, requires admin approval (via PLAN-019-3 admin role). Override is single-use (consumed by the deploy). Tests cover all three thresholds.
   - Estimated effort: 4h

8. **Implement `deploy cost` CLI** -- `autonomous-dev deploy cost [--day|--month] [--env <env>] [--backend <name>]` prints aggregated spend with breakdowns. JSON output mode emits structured data.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/deploy-cost.ts`
   - Acceptance criteria: `deploy cost --day` prints today's spend with per-env, per-backend, and grand total. `--month` aggregates the current month. JSON mode emits the same data structurally. Tests cover both modes.
   - Estimated effort: 1.5h

9. **Implement `deploy monitor` and `deploy logs` CLI** -- `deploy monitor [--deploy <id>]` streams live monitor log lines. `deploy logs <deployId> [--component build|deploy|health|monitor]` prints the per-deploy logs.
   - Files to create: `plugins/autonomous-dev/src/cli/commands/deploy-monitor.ts`, `deploy-logs.ts`
   - Acceptance criteria: `monitor` follows new lines (tail -f semantics). `logs` prints all lines for the requested component. Both have JSON mode. Tests cover non-streaming variants.
   - Estimated effort: 2h

10. **Unit tests** -- `tests/deploy/test-monitor.test.ts`, `test-cost-ledger.test.ts`, `test-cost-cap.test.ts`, `test-deploy-logger.test.ts` covering all paths.
    - Files to create: four test files under `plugins/autonomous-dev/tests/deploy/`
    - Acceptance criteria: All tests pass. Coverage ≥95% on new modules. Mocked timers for monitor loop tests.
    - Estimated effort: 4h

11. **Integration test: full lifecycle with monitoring** -- `tests/integration/test-deploy-monitoring.test.ts` that runs a deploy → starts monitor → simulates 3 consecutive health failures → verifies auto-rollback triggers → asserts escalation fires.
    - Files to create: `plugins/autonomous-dev/tests/integration/test-deploy-monitoring.test.ts`
    - Acceptance criteria: Test passes deterministically. Auto-rollback occurs after the third failure. Escalation message contains the deploy ID and rollback outcome. Tests use mocked health checks for determinism.
    - Estimated effort: 3h

## Dependencies & Integration Points

**Exposes to other plans:**
- Health-monitor pattern reusable for any future continuous-monitoring use case (e.g., post-deploy regression suite).
- Per-deploy log directory layout consumed by future observability dashboards (the portal might add a "logs" panel).
- Cost ledger format consumed by PLAN-024-* (cloud backends contribute to the same ledger) and any future cost-related plan.
- Cost-cap enforcement pattern aligned with PLAN-017-4 budget-gate (intentional symmetry).

**Consumes from other plans:**
- **PLAN-023-1** (blocking): backend interface (calls `healthCheck()` and `rollback()`), HMAC-signed records.
- **PLAN-023-2** (blocking): environment resolver, approval state machine, per-env cost cap (works alongside this plan's daily cap).
- **PLAN-009-X** (existing on main): escalation router for monitor escalations and cost cap warnings.
- **PLAN-019-3** (existing on main): admin role for 110% cost override.
- TDD-007 / PLAN-007-X: telemetry pipeline.

## Testing Strategy

- **Unit tests (task 10):** Monitor scheduling, SLA computation, auto-rollback, cost-cap thresholds, ledger HMAC chain. ≥95% coverage.
- **Integration test (task 11):** Full deploy lifecycle with monitoring + simulated failure + auto-rollback + escalation.
- **Cost-cap thresholds:** Test fixtures spanning 79%, 80%, 99%, 100%, 109%, 110% to validate boundary behavior.
- **Ledger HMAC integrity:** 1000 entries, full chain verification. Tampering detected.
- **Performance:** Monitor poll cadence within ±5% of configured interval. Logger throughput >1000 lines/sec without dropping.
- **Manual smoke:** Deploy to a real `static` target, watch the monitor for 5 minutes, simulate a failure (kill the target service), verify rollback triggers.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Health-check polling adds significant load to deployed services (especially with frequent intervals) | Medium | Medium -- false-failure due to load | Default interval is 30s, configurable per backend. Health endpoints expected to be lightweight. Backend metadata declares `health_check.expected_latency_ms` so monitor can warn if check itself exceeds it. |
| Auto-rollback triggers during transient network blips (e.g., DNS hiccup), causing unnecessary rollbacks | High | Medium -- service flaps between versions | Default 3-consecutive-failure threshold provides hysteresis. Configurable per backend. Documented: operators tune based on their environment's stability profile. |
| Cost ledger key (`DEPLOY_COST_HMAC_KEY`) loss makes existing entries unverifiable, breaking aggregation | Medium | High -- cost gates can't trust ledger | Same recovery procedure as PLAN-019-4's audit key: log warning, regenerate, write rotation entry. Existing entries become unverifiable; aggregation falls back to current period. Documented. |
| Per-deploy log files accumulate, filling disk over many requests | Medium | Medium -- daemon disk usage | PRD-007 cleanup retention covers `<request>/.autonomous-dev/` directory. Per-component log files rotate at 100MB. After 10 rotations (1GB total per component), oldest is dropped. |
| Cost-cap pre-check uses estimates that diverge from actuals, causing 100% threshold to fire late | High | Medium -- gates fail after the fact | This plan's enforcement is on actuals (post-deploy ledger). PLAN-023-2's pre-check uses estimates. The two layers complement: pre-check warns early; daily cap enforces actuals. Both use the same ledger for actuals. |
| Monitor loop blocks daemon shutdown if a health check is in-flight | Low | Low -- shutdown delay | `stop()` cancels pending checks via `AbortController`. Documented timeout for shutdown: 30s grace. After that, force-kill. Tested. |

## Definition of Done

- [ ] `HealthMonitor` polls active deployments at the configured interval
- [ ] SLA tracking with rolling window correctly identifies sustained failures
- [ ] Auto-rollback triggers after N consecutive failures and records a new deployment
- [ ] Per-deploy log directory structure exists with build/deploy/health/monitor subdirs
- [ ] Log files are JSONL and rotate at 100MB per component
- [ ] All bundled backends emit structured logs via `DeployLogger`
- [ ] Telemetry events emit for all documented deploy lifecycle events
- [ ] Cost ledger maintains HMAC chain across all entries
- [ ] Cost-cap enforcement at 80%/100%/110% thresholds works with admin override at 110%
- [ ] `deploy cost`, `deploy monitor`, `deploy logs` CLI subcommands work with JSON output
- [ ] Unit tests pass with ≥95% coverage on new modules
- [ ] Integration test demonstrates full lifecycle with auto-rollback
- [ ] Cost-cap boundary tests cover 79/80/99/100/109/110 percentages
- [ ] Ledger HMAC chain verified across 1000 entries
- [ ] Monitor poll cadence within ±5% of configured interval
- [ ] No regressions in PLAN-023-1/2 functionality
