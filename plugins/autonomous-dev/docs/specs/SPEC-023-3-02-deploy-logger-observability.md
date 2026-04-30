# SPEC-023-3-02: Per-Deploy Logger + Backend Wiring + Telemetry Integration

## Metadata
- **Parent Plan**: PLAN-023-3
- **Tasks Covered**: Task 3 (per-deploy log directory + DeployLogger), Task 4 (wire logger into backends), Task 5 (telemetry integration)
- **Estimated effort**: 6.5 hours
- **Future home**: `/Users/pwatson/codebase/autonomous-dev/plugins/autonomous-dev/docs/specs/SPEC-023-3-02-deploy-logger-observability.md`

## Description
Deliver per-deploy observability per TDD-023 §13. Each deploy gets an isolated log directory at `<request>/.autonomous-dev/deploy-logs/<deployId>/` with four component subdirs (`build/`, `deploy/`, `health/`, `monitor/`). The new `DeployLogger` class opens the appropriate JSONL file for the active component, emits structured `{ts, level, message, fields}` lines, and rotates each file at 100 MB (max 10 rotations per component, oldest dropped). All four bundled deployment backends from PLAN-023-1 (`local`, `static`, `npm`, `pypi`) accept a logger instance and emit structured events at every lifecycle transition. The same events also reach the TDD-007 telemetry pipeline so the existing dashboards and alerting can consume deploy events without bespoke parsing.

This spec is purely about observability plumbing. Cost ledger, cost-cap enforcement, and operator CLIs are in SPEC-023-3-03; tests are in SPEC-023-3-04.

## Files to Create/Modify

| File | Action | Notes |
|------|--------|-------|
| `plugins/autonomous-dev/src/deploy/logger.ts` | Create | `DeployLogger` class + `LogLevel` + `LogLine` types |
| `plugins/autonomous-dev/src/deploy/log-rotation.ts` | Create | Pure helper for rotation policy |
| `plugins/autonomous-dev/src/deploy/telemetry.ts` | Create | Adapter that maps log/monitor events to TDD-007 metrics |
| `plugins/autonomous-dev/src/deploy/backends/local.ts` | Modify | Accept logger; emit `build_*`, `deploy_*`, `health_*` events |
| `plugins/autonomous-dev/src/deploy/backends/static.ts` | Modify | Same wiring as `local` |
| `plugins/autonomous-dev/src/deploy/backends/npm.ts` | Modify | Same wiring as `local` |
| `plugins/autonomous-dev/src/deploy/backends/pypi.ts` | Modify | Same wiring as `local` |
| `plugins/autonomous-dev/src/deploy/monitor.ts` | Modify | Accept logger; write to `monitor/monitor.log`; emit telemetry |
| `plugins/autonomous-dev/src/deploy/index.ts` | Modify | Re-export `DeployLogger`, `DeployTelemetry` |

## Implementation Details

### Directory Layout (Created on First Write)

```
<request>/.autonomous-dev/deploy-logs/<deployId>/
├── build/
│   ├── build.log         # current
│   ├── build.log.1       # rotated (oldest of newer)
│   └── ...               # up to build.log.10 then drop oldest
├── deploy/
│   └── deploy.log
├── health/
│   └── health.log
└── monitor/
    └── monitor.log
```

`<request>` resolves via the existing request-context helper. `<deployId>` is the ULID assigned by PLAN-023-1.

### `DeployLogger` API

```ts
export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type LogComponent = 'build' | 'deploy' | 'health' | 'monitor';

export interface LogLine {
  ts: string;          // ISO 8601 with ms precision
  level: LogLevel;
  message: string;     // stable event name e.g. "build_started"
  fields: Record<string, unknown>;
}

export class DeployLogger {
  constructor(private opts: {
    requestRoot: string;
    deployId: string;
    component: LogComponent;
    fs?: FsLike;             // injectable for tests
    rotateAtBytes?: number;  // default 100 * 1024 * 1024
    maxRotations?: number;   // default 10
    telemetry?: DeployTelemetry; // optional fan-out
  });

  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  async flush(): Promise<void>;
  async close(): Promise<void>;

  /** Spawns a sibling logger for a different component, sharing rotation state. */
  forComponent(component: LogComponent): DeployLogger;
}
```

Behavior:

- First write creates the full directory tree (`mkdir -p`-style) and the target log file. Subsequent writes append.
- Each line is `JSON.stringify(line) + "\n"`. No multi-line entries; embedded newlines in `message` are escaped by `JSON.stringify`.
- Writes are queued so concurrent calls from the same process do not interleave bytes within a line. The implementation uses an internal append queue (`Promise` chain).
- Rotation triggers when the current file size + pending write would exceed `rotateAtBytes`. Rotation steps:
  1. Close the current write stream.
  2. Shift `<comp>.log.N` → `<comp>.log.N+1` for `N = maxRotations-1` down to `1`.
  3. Drop `<comp>.log.maxRotations` if present.
  4. Rename `<comp>.log` → `<comp>.log.1`.
  5. Open a new `<comp>.log`.
- `flush()` waits for the queue to drain. `close()` flushes then releases handles.

### Backend Wiring

Each backend method receives a `DeployLogger` (constructed by the deploy entrypoint with `component: 'build'` or `'deploy'` as appropriate):

| Lifecycle phase | Required log line `message` | Fields |
|-----------------|-----------------------------|--------|
| Build start | `build_started` | `{commit, target}` |
| Commit validated | `commit_validated` | `{commit, signed_by?}` |
| Build complete | `build_completed` | `{duration_ms, artifact_size_bytes}` |
| Build failure | `build_failed` | `{error, stage}` |
| Deploy start | `deploy_started` | `{env, target_host?}` |
| Deploy complete | `deploy_completed` | `{duration_ms}` |
| Deploy failure | `deploy_failed` | `{error}` |
| Health check pass | `health_check_passed` | `{latency_ms}` |
| Health check fail | `health_check_failed` | `{latency_ms, error}` |
| Auto-rollback triggered | `auto_rollback_triggered` | `{consecutive_failures}` |
| Auto-rollback complete | `auto_rollback_completed` | `{outcome, new_deploy_id?}` |

Exact strings are part of the public contract — dashboards and downstream parsers depend on them.

### Telemetry Adapter

```ts
export class DeployTelemetry {
  emit(event: {
    deployId: string;
    env: string;
    backend: string;
    name: string;            // == LogLine.message
    timestamp: string;
    fields: Record<string, unknown>;
  }): void;
}
```

When a `DeployLogger` is constructed with `telemetry`, every `info`/`warn`/`error` line is forwarded to `telemetry.emit({...})` after the JSONL write completes. `debug` is NOT forwarded (volume control). The adapter writes through TDD-007's `MetricsClient` (consumed via existing import path; no new dependency).

### Failure Modes

- Disk full / `EACCES`: logger logs once to `process.stderr` (single-shot), drops the line, and continues. Downstream callers do not throw.
- Rotation rename failure: same handling — emit a single stderr warning, leave the current file in place, and continue appending until the next rotation attempt succeeds.

## Acceptance Criteria

- [ ] After a successful `local` backend deploy, `<request>/.autonomous-dev/deploy-logs/<deployId>/build/build.log` contains lines with `message: "build_started"`, `"commit_validated"`, `"build_completed"` in order, each valid JSONL.
- [ ] After the same deploy, `deploy/deploy.log` contains `"deploy_started"` and `"deploy_completed"`, and `health/health.log` contains at least one `"health_check_passed"` line.
- [ ] All four bundled backends (`local`, `static`, `npm`, `pypi`) accept a logger and emit the eleven documented event names per the wiring table.
- [ ] Each `LogLine` is single-line JSON with keys `ts`, `level`, `message`, `fields` (no extras).
- [ ] Concurrent writes from build and deploy components do not interleave bytes within any single line (verified by test that fires 1000 alternating writes across two components and parses every line as JSON).
- [ ] Rotation triggers when the file size + pending write would exceed `rotateAtBytes`. After rotation, the prior content is at `<comp>.log.1` and the new file starts empty.
- [ ] Rotations cap at `maxRotations`; the 11th rotation drops `<comp>.log.10` before shifting.
- [ ] Throughput exceeds 1000 lines/sec on a single logger without dropping lines (verified in perf-style unit test on a tmpdir-backed fs).
- [ ] Disk-full simulation (`fs.writeFile` rejects with `ENOSPC`) emits exactly one stderr warning and continues without throwing to the caller.
- [ ] Every `info`/`warn`/`error` line with a `telemetry` adapter attached produces exactly one `DeployTelemetry.emit` call carrying `deployId`, `env`, `backend`, the event name, an ISO timestamp, and the original fields.
- [ ] `debug` lines are written to the file but NOT forwarded to telemetry.
- [ ] `HealthMonitor` from SPEC-023-3-01, when given a logger, writes lifecycle events to `monitor/monitor.log` (`monitor_started`, `monitor_tick`, `auto_rollback_triggered`, `auto_rollback_completed`).
- [ ] `close()` flushes all pending writes; subsequent `info()` calls throw `LoggerClosedError`.

## Dependencies

- **PLAN-023-1** (blocking): Backend interface and bundled backends. This spec modifies them in place.
- **SPEC-023-3-01**: `HealthMonitor` constructor accepts a logger added here.
- **TDD-007 / PLAN-007-X** (existing): `MetricsClient` for telemetry forwarding. No new package.
- Node.js built-in `fs/promises` for writes; no new npm dependency.

## Notes

- The exact event-name strings (`build_started`, `health_check_failed`, etc.) are stable contracts. Add new events as new strings rather than renaming existing ones — downstream dashboards and alerts key off these literals.
- Rotation policy (100 MB × 10 = 1 GB per component max) is intentionally aligned with PRD-007's `<request>/.autonomous-dev/` retention so cleanup logic does not need a deploy-specific carve-out.
- Telemetry is an optional dependency: if `telemetry` is not passed to the logger, lines still land on disk. This keeps unit tests for backends from needing to mock the metrics pipeline.
- Per-component files (rather than one shared `deploy.log`) eliminate cross-component interleaving and make `deploy logs --component build` (SPEC-023-3-03) trivial to implement.
