# SPEC-023-3-01: Health Monitor + SLA Tracking + Auto-Rollback

## Metadata
- **Parent Plan**: PLAN-023-3
- **Tasks Covered**: Task 1 (HealthMonitor class), Task 2 (SLA tracking + auto-rollback)
- **Estimated effort**: 7 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-3-01-health-monitor-sla-auto-rollback.md`

## Description
Implement the continuous health-check monitor per TDD-023 §12. The `HealthMonitor` runs a background loop that polls each active deployment's `healthCheck()` method at a configurable interval (default 30s). It tracks healthy/unhealthy status in a rolling window, computes uptime against the deployment's declared SLA, and triggers `backend.rollback()` automatically when consecutive failures exceed the configured threshold (default 3). On rollback success it records a new `auto-rollback` deployment record; on rollback failure it escalates to the operator. The monitor must shut down cleanly via `stop()` (canceling pending health checks via `AbortController`) so the daemon can terminate within its 30s grace window.

This spec delivers monitor scheduling and rollback policy only. Logging, telemetry emission, cost ledger, and CLI surfaces are covered by SPEC-023-3-02, SPEC-023-3-03, and SPEC-023-3-04.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/monitor.ts` | Create | `HealthMonitor` class with `start`/`stop`/`getStatus` |
| `plugins/autonomous-dev/src/deploy/monitor-types.ts` | Create | `SlaConfig`, `HealthSample`, `MonitorStatus`, `RollbackOutcome` types |
| `plugins/autonomous-dev/src/deploy/sla-tracker.ts` | Create | Rolling-window helper used by the monitor |
| `plugins/autonomous-dev/src/deploy/index.ts` | Modify | Re-export `HealthMonitor` and types |

## Implementation Details

### Types (`monitor-types.ts`)

```ts
export interface SlaConfig {
  uptime_pct: number;                       // default 0.99
  consecutive_failures_for_rollback: number;// default 3
  health_check_interval_ms: number;         // default 30_000
  health_check_timeout_ms: number;          // default 5_000
  rolling_window_size: number;              // default 100 samples
}

export interface HealthSample {
  ts: number;
  healthy: boolean;
  latency_ms: number;
  error?: string;
}

export type RollbackOutcome =
  | { kind: 'success'; newDeployId: string }
  | { kind: 'failure'; error: string };

export interface MonitorStatus {
  deployId: string;
  consecutiveFailures: number;
  uptimePct: number;
  lastSample?: HealthSample;
  state: 'healthy' | 'degraded' | 'rolling-back' | 'escalated' | 'stopped';
}
```

Defaults live in `monitor-types.ts` as `DEFAULT_SLA: SlaConfig`.

### `SlaTracker`

- Fixed-capacity ring buffer of `HealthSample` (capacity = `rolling_window_size`).
- `record(sample: HealthSample)` pushes and evicts oldest.
- `consecutiveFailures()` walks from the tail counting trailing `healthy === false` until the first healthy sample.
- `uptimePct()` = healthy / total in the window. Returns `1.0` when window is empty.
- A single healthy sample resets `consecutiveFailures()` to 0 (verified by unit test).

### `HealthMonitor`

```ts
export class HealthMonitor {
  constructor(private deps: {
    backends: BackendRegistry;        // from PLAN-023-1
    activeDeployments: () => Promise<DeploymentRecord[]>;
    escalate: (msg: EscalationMessage) => Promise<void>; // PLAN-009-X router
    now?: () => number;               // injectable for tests
    setIntervalFn?: typeof setInterval; // injectable
    clearIntervalFn?: typeof clearInterval;
  }) {}

  start(): void;                       // begins the loop
  async stop(graceMs = 30_000): Promise<void>; // cancels in-flight checks
  getStatus(deployId: string): MonitorStatus | undefined;
}
```

Loop algorithm (pseudo):

```
on every tick (per-deploy interval):
  controller = new AbortController()
  pending.add(controller)
  try:
    sample = await withTimeout(backend.healthCheck(record, { signal }), sla.health_check_timeout_ms)
  catch err:
    sample = { ts: now(), healthy: false, latency_ms: timeout, error: err.message }
  finally:
    pending.delete(controller)
  tracker.record(sample)
  if tracker.consecutiveFailures() >= sla.consecutive_failures_for_rollback:
    await triggerAutoRollback(record)
```

`triggerAutoRollback` is idempotent per-deployment: once the state is `rolling-back`, additional failed samples do not re-invoke `rollback()`. State transitions:

```
healthy ──fail──▶ degraded ──fail*N──▶ rolling-back ──ok──▶ stopped
                                       │
                                       └──err──▶ escalated
```

On `rollback()` success: insert a new `DeploymentRecord` with `cause: 'auto-rollback'`, `parent_deploy_id: <failed>`, write an escalation note (informational), and stop monitoring the failed deploy. On `rollback()` failure: escalate with severity `critical` and stop monitoring (operator must remediate manually).

### Configuration

Per-backend SLA overrides live in `deploy.yaml`:

```yaml
backends:
  - name: local
    sla:
      uptime_pct: 0.995
      consecutive_failures_for_rollback: 5
      health_check_interval_ms: 15000
```

Resolution order: `deploy.yaml` per-backend → `deploy.yaml` defaults → `DEFAULT_SLA`.

### Shutdown

`stop(graceMs)` aborts every controller in `pending`, awaits the loop's current iteration up to `graceMs`, then resolves. After `stop()` resolves, the monitor enters terminal state and cannot be restarted (must construct a new instance).

## Acceptance Criteria

- [ ] `HealthMonitor.start()` invokes `backend.healthCheck()` once per active deployment per configured interval (verified with mocked timers, `setInterval` injection).
- [ ] Polling cadence stays within ±5% of `health_check_interval_ms` over 100 ticks (verified in unit test using fake clock).
- [ ] Health checks exceeding `health_check_timeout_ms` are aborted via `AbortController` and recorded as failures with `error: 'health_check_timeout'`.
- [ ] Three consecutive failed samples (default threshold) trigger exactly one call to `backend.rollback()`. The state transitions to `rolling-back`.
- [ ] Two failures followed by one healthy sample do NOT trigger rollback; `consecutiveFailures()` returns 0 after the healthy sample.
- [ ] On successful rollback, a new `DeploymentRecord` is written with `cause: 'auto-rollback'` and `parent_deploy_id` pointing to the failed deploy.
- [ ] On failed rollback, `escalate()` is invoked exactly once with `severity: 'critical'` containing the rollback error message and the failed deploy's ID.
- [ ] `stop()` aborts all pending health checks and resolves within `graceMs + 1s`.
- [ ] Calling `start()` after `stop()` throws `MonitorAlreadyStoppedError`.
- [ ] Per-backend SLA overrides in `deploy.yaml` override the defaults; missing fields fall back to `DEFAULT_SLA`.
- [ ] `getStatus(deployId)` returns the current `MonitorStatus` including the latest sample, consecutive-failure count, and uptime percent.
- [ ] No console.log calls outside of explicit logger usage (logger plumbing arrives in SPEC-023-3-02).

## Dependencies

- **PLAN-023-1** (blocking): Backend interface — `BackendRegistry`, `healthCheck()`, `rollback()`, `DeploymentRecord` shape.
- **PLAN-023-2** (blocking): Active-deployment query (used by `activeDeployments` callback).
- **PLAN-009-X** (existing): Escalation router for `escalate()` calls.
- No new npm packages introduced.

## Notes

- Hysteresis (`consecutive_failures_for_rollback`) is intentionally configurable per-backend so operators can tune for environments with flaky network paths (DNS hiccups, transient CDN errors). Documented default of 3 favors stability; operators should measure their baseline error rate before lowering.
- The monitor itself never logs to disk in this spec — `DeployLogger` integration is in SPEC-023-3-02. To keep tests deterministic, this spec deliberately couples no I/O beyond the backend interface.
- `setIntervalFn`/`now` injection is required so unit tests can drive the loop with `vi.useFakeTimers()` (or equivalent) without sleeping. All timing assertions in tests use the fake clock.
- The `state` enum is intentionally narrow; richer state (e.g., `paused`, `manual-override`) is out of scope and tracked under TDD-023 future work.
