# SPEC-023-3-04: Unit + Integration Tests for Monitor / Logger / Cost Subsystem

## Metadata
- **Parent Plan**: PLAN-023-3
- **Tasks Covered**: Task 10 (unit tests), Task 11 (integration test with auto-rollback simulation)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-3-04-unit-and-integration-tests.md`

## Description
Deliver the test suite for the deployment observability + cost subsystem implemented in SPEC-023-3-01, -02, and -03. Four unit-test files cover monitor scheduling and rollback, deploy logger rotation and concurrency, cost ledger HMAC chain integrity, and cost-cap threshold enforcement (including boundary fixtures at 79/80/99/100/109/110 percent). One integration test exercises the full lifecycle: a deploy is launched with the monitor attached, three consecutive simulated health failures trigger auto-rollback, and the resulting escalation message is asserted to contain the deploy ID and rollback outcome. All tests are deterministic (mocked timers, mocked filesystems where appropriate) and target ≥95% line coverage on the modules from the prior three specs.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/tests/deploy/test-monitor.test.ts` | Create | Loop scheduling, SLA, auto-rollback paths |
| `plugins/autonomous-dev/tests/deploy/test-deploy-logger.test.ts` | Create | Directory creation, rotation, concurrency, failure modes |
| `plugins/autonomous-dev/tests/deploy/test-cost-ledger.test.ts` | Create | HMAC chain, replay safety, corruption detection |
| `plugins/autonomous-dev/tests/deploy/test-cost-cap.test.ts` | Create | Threshold boundaries, override consumption |
| `plugins/autonomous-dev/tests/integration/test-deploy-monitoring.test.ts` | Create | Full lifecycle: deploy → monitor → fail → rollback → escalate |
| `plugins/autonomous-dev/tests/deploy/fixtures/cost-ledger-fixtures.ts` | Create | Pre-built ledger files at 79/80/99/100/109/110 percent of cap |
| `plugins/autonomous-dev/tests/deploy/helpers/fake-backend.ts` | Create | Configurable backend driving pass/fail health checks |
| `plugins/autonomous-dev/package.json` | Modify | Add `test:deploy` script if missing |

## Implementation Details

### Test Framework

Use the project's existing test runner (Vitest, per the existing tests under `plugins/autonomous-dev/tests/`). Use `vi.useFakeTimers()` for any monitor-loop timing assertions. Use `memfs` (already in devDependencies; if not, add `memfs@^4`) for `DeployLogger` filesystem tests so concurrent-write tests do not hit real disk.

### `test-monitor.test.ts`

Cases (each one `it` block):

1. `start()` schedules `healthCheck` exactly once per active deploy per interval (advance fake clock 5 intervals, assert call count = 5 × deployCount).
2. Polling cadence stays within ±5% of `health_check_interval_ms` over 100 ticks (compute observed intervals from spy timestamps).
3. Health-check timeout aborts via `AbortController` and records a failure sample with `error: 'health_check_timeout'`.
4. Three consecutive failures invoke `backend.rollback()` exactly once; subsequent failures while in `rolling-back` state do not invoke it again.
5. Two failures + one success resets `consecutiveFailures()` to 0 (no rollback).
6. Successful rollback writes a new `DeploymentRecord` with `cause: 'auto-rollback'` and `parent_deploy_id` matching the failed deploy.
7. Failed rollback emits exactly one escalation with `severity: 'critical'` carrying the rollback error.
8. `stop()` aborts pending checks and resolves within `graceMs + 1s` (assert with `expect(elapsed).toBeLessThan(graceMs + 1000)`).
9. `start()` after `stop()` throws `MonitorAlreadyStoppedError`.
10. Per-backend SLA overrides win over defaults (table-driven test).

### `test-deploy-logger.test.ts`

1. First write creates the full directory tree (`build/`, `deploy/`, `health/`, `monitor/`).
2. Each line is valid single-line JSON with the four required keys.
3. Concurrent writes from build and deploy components produce no torn lines (1000 alternating writes; parse every line).
4. Rotation triggers when projected size > `rotateAtBytes`. After rotation, the prior content is at `<comp>.log.1` and the new file is empty.
5. 11 rotations cap the chain at `<comp>.log.10`; the 11th rotation drops the oldest.
6. Throughput exceeds 1000 lines/sec (with `memfs` backend) — assert `elapsed_ms < 1000` for 1000 writes.
7. `ENOSPC` from underlying write rejects emits exactly one stderr warning (spy on `process.stderr.write`) and does not throw to the caller.
8. `flush()` resolves only after all queued writes complete.
9. `close()` flushes; subsequent `info()` throws `LoggerClosedError`.
10. `forComponent()` returns a sibling logger writing to a different component file but sharing the rotation policy (independent counters per component).
11. Telemetry adapter receives one `emit` call per `info`/`warn`/`error` line and zero calls for `debug`.

### `test-cost-ledger.test.ts`

1. Genesis entry has `prev_hmac` of 64 zero hex chars and a verifiable `hmac`.
2. Sequential append of 1000 entries produces a valid HMAC chain (walk file, recompute every `hmac`, expect equal).
3. Tampering with any entry's `estimated_cost_usd` causes the next `append()` to throw `CostLedgerCorruptError` with the offending line number.
4. Concurrent appenders across 10 child processes (`child_process.fork`) each writing 10 entries result in 100 valid entries with no torn lines and an intact HMAC chain.
5. Mid-append crash (simulated via `process.kill` between write and rename) leaves at most one partial line; the next `append()` truncates it, logs a warning, and proceeds.
6. Daemon restart resumes from the last entry's `hmac` (re-construct ledger, append, verify chain).
7. Aggregate over `window: 'day'` returns correct `byEnv`, `byBackend`, totals, and `entryCount` against the fixture.
8. `recordActual` appends a follow-up entry referencing the original deploy ID; aggregate distinguishes `totalEstimated` from `totalActual`.
9. Missing `DEPLOY_COST_HMAC_KEY` causes `CostLedgerKeyMissingError` on the first `append()`.

### `test-cost-cap.test.ts`

Boundary table-driven test — for each fixture file (79%, 80%, 99%, 100%, 109%, 110%):

| Spent (% of $100 cap) | Expected outcome |
|-----------------------|------------------|
| 79 | Allowed silently. No escalation. |
| 80 | Allowed. One warning escalation emitted. |
| 99 | Allowed. (No second warning — sticky-once-per-day.) |
| 100 | Rejected with `DailyCostCapExceededError`. |
| 109 | Rejected with `DailyCostCapExceededError`. (Has not crossed 110.) |
| 110 | Rejected with `AdminOverrideRequiredError`. |

Plus:

- Sticky warning idempotency: at 80%, second `check()` in the same UTC day does not re-escalate.
- Sticky warning persistence across restarts: write `deploy-cap-warnings.json`, instantiate a fresh `CostCapEnforcer`, second `check()` does not re-escalate.
- Override consumption: at 110% with a valid override token for `deployId`, deploy is allowed and the token is removed from `deploy-cap-overrides.json`. Second deploy with same token throws `AdminOverrideRequiredError`.
- Expired override (past `expires_at`) is rejected as if no override existed.

### Integration: `test-deploy-monitoring.test.ts`

Sequence:

1. Construct `DeployLogger`, `DeployTelemetry`, `CostLedger`, `CostCapEnforcer`, `HealthMonitor`, and a `FakeBackend` from `helpers/fake-backend.ts`.
2. `FakeBackend.deploy()` returns a `DeploymentRecord` and stages a health-check fail sequence: `[true, true, false, false, false, true]`.
3. Run the deploy entrypoint end-to-end: cap check passes, ledger entry appended, backend deploys, monitor attaches and begins polling.
4. Advance fake clock through 5 intervals.
5. Assertions:
   - The third consecutive `false` triggers exactly one `backend.rollback()` call.
   - On rollback success, a new `DeploymentRecord` is written with `cause: 'auto-rollback'` and `parent_deploy_id: <failed-id>`.
   - One informational escalation is emitted naming the deploy ID and outcome.
   - `<request>/.autonomous-dev/deploy-logs/<deployId>/monitor/monitor.log` contains `monitor_started`, three `health_check_failed` lines, `auto_rollback_triggered`, and `auto_rollback_completed`.
   - The cost ledger has one entry for the original deploy and zero new entries for the rollback (rollback is free per current policy — documented).
   - Telemetry pipeline received the documented event sequence.
6. Variant: same scenario but `backend.rollback()` throws. Assert one `severity: 'critical'` escalation containing the rollback error and the failed deploy's ID. Monitor stops polling that deploy.

The integration test must complete in <10s on CI (use fake timers throughout).

### Coverage

Run `vitest --coverage` (or `c8`) and assert ≥95% line coverage on:

- `src/deploy/monitor.ts`
- `src/deploy/sla-tracker.ts`
- `src/deploy/logger.ts`
- `src/deploy/log-rotation.ts`
- `src/deploy/cost-ledger.ts`
- `src/deploy/cost-cap-enforcer.ts`

Coverage check is wired into the `test:deploy` script (`vitest run --coverage --reporter=verbose && node scripts/check-deploy-coverage.mjs`). The check script is OUT OF SCOPE for this spec — we add the coverage flag to the existing script and document the threshold in the spec; enforcement automation is a follow-up if not already present.

## Acceptance Criteria

- [ ] `npm test -- tests/deploy` (or project equivalent) runs all four unit-test files green.
- [ ] `npm test -- tests/integration/test-deploy-monitoring.test.ts` runs green.
- [ ] Total runtime for `tests/deploy` + the one integration test is <30s on CI.
- [ ] Coverage report shows ≥95% line coverage on all six modules listed above. The build fails if coverage drops below the threshold.
- [ ] All monitor-loop timing tests use `vi.useFakeTimers()` — no real `setTimeout`/`setInterval` in any deploy test (verified by grep in CI: `grep -r "setTimeout\|setInterval" plugins/autonomous-dev/tests/deploy && exit 1 || exit 0`, allowed only when wrapped in `vi.useFakeTimers`).
- [ ] Logger concurrency test parses every line of the resulting file as JSON without errors (1000 alternating writes across two components).
- [ ] Ledger stress test (10 processes × 10 entries) produces 100 valid entries with intact HMAC chain.
- [ ] All six cost-cap boundary cases (79/80/99/100/109/110) pass.
- [ ] Override consumption test asserts the token is removed from `deploy-cap-overrides.json` after a successful consume.
- [ ] Integration test asserts auto-rollback fires after the third failure, not earlier (assert call count = 0 after the second failure, then = 1 after the third).
- [ ] Rollback-failure variant of the integration test asserts exactly one `severity: 'critical'` escalation containing both the deploy ID and the rollback error.
- [ ] No test depends on real network, real disk, or real time (besides perf assertions on `memfs`).
- [ ] No test relies on `console.log` for assertions; all assertions go through return values, spy mocks, or file contents read after the fact.

## Dependencies

- **SPEC-023-3-01**: `HealthMonitor`, `SlaTracker`, types under test.
- **SPEC-023-3-02**: `DeployLogger`, `DeployTelemetry`, backend wiring under test.
- **SPEC-023-3-03**: `CostLedger`, `CostCapEnforcer`, error types under test.
- **PLAN-023-1**: `DeploymentRecord`, `BackendInterface` (the fake backend implements this interface).
- Vitest (existing). `memfs` may need to be added to devDependencies if not already present.

## Notes

- Tests live under `plugins/autonomous-dev/tests/deploy/` for unit tests and `plugins/autonomous-dev/tests/integration/` for the integration test, matching existing project layout (verify against `tests/deploy/` siblings before authoring).
- The fixtures file `cost-ledger-fixtures.ts` should expose builder functions (`buildLedgerAt(percent: number)`) rather than checked-in JSONL files. This avoids coupling the test suite to a specific HMAC key — the builder signs against a test key supplied by `process.env.DEPLOY_COST_HMAC_KEY` set per-test via `vi.stubEnv`.
- The integration test uses `FakeBackend` rather than driving any real backend (`local`, `static`, etc.). This is intentional: end-to-end behavior of real backends is exercised by SPEC-023-1 / 023-2 tests; this spec validates the monitor + logger + ledger interactions specifically.
- If `memfs` is not already a devDependency, prefer adding it (it's small, well-maintained) over reaching for `mock-fs` (deprecated). Document the addition in the spec rollout note.
- The grep-based check for `setTimeout`/`setInterval` in CI is a guardrail to keep deploy tests deterministic. False positives (e.g., a comment containing the word) can be resolved by linting or by relocating the comment.
