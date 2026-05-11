# SPEC-037-2-02: GET /api/daemon-status Endpoint

## Metadata
- **Parent Plan**: PLAN-037-2-mount-missing-routes
- **Parent PRD**: PRD-018-portal-visual-redesign (rail-ops pill)
- **Tasks Covered**: PLAN-037-2 §Scope item 2
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09
- **Safety Class**: NORMAL (read-only; no state mutation)

## 1. Summary

Implement a new read-only endpoint `GET /api/daemon-status` that drives the rail-ops
status pill rendered on every portal page (PLAN-037-3 consumes the payload). The handler
reads `~/.autonomous-dev/heartbeat.json` for liveness, the existing cost-ledger reader
for `mtdSpend`, the approvals stub/store for `approvalsCount`, and the kill-switch state
file for `killSwitchEngaged`. No daemon RPC; pure filesystem reads behind a 50ms
soft-deadline.

## 2. Functional Requirements

| ID    | Requirement                                                                                                                                                                                       |
|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| FR-1  | Register `app.get("/api/daemon-status", daemonStatusHandler)` in `server/routes/index.ts` after the static mount and the SSE wiring.                                                              |
| FR-2  | Handler MUST return `Content-Type: application/json; charset=UTF-8`, HTTP 200 on success, with body shape `{ status: 'running'|'stale'|'down', mtdSpend: number, approvalsCount: number, killSwitchEngaged: boolean, heartbeatAgeMs: number }`. |
| FR-3  | `status` MUST be derived from heartbeat age: `< 60_000ms → 'running'`, `60_000–300_000ms → 'stale'`, `> 300_000ms` or file missing → `'down'`.                                                     |
| FR-4  | `mtdSpend` MUST be sourced from the cost-ledger reader (`lib/cost-ledger.ts` or equivalent existing module) and reflect month-to-date USD as a non-negative number. On read failure, default to `0` and log a structured WARN `daemon_status_cost_unavailable`. |
| FR-5  | `approvalsCount` MUST be the count of pending approvals (existing `stubs/approvals` or `loadApprovalsStub` reader). On read failure, default to `0` and log WARN.                                  |
| FR-6  | `killSwitchEngaged` MUST be read from the kill-switch state file (existing `lib/daemon-halt` getter or equivalent). On read failure, default to `false` and log WARN.                              |
| FR-7  | The handler MUST set `Cache-Control: no-store` so the rail-ops poll never serves stale data from an intermediary.                                                                                  |
| FR-8  | The handler MUST complete in p99 < 50ms (pure FS reads). Reads MUST run in parallel via `Promise.allSettled`; no sequential awaits.                                                                |
| FR-9  | The handler MUST NOT require CSRF (GET is safe per RFC 9110 §9.2.1) but MUST require an authenticated session (upstream auth middleware).                                                          |
| FR-10 | The handler MUST NOT mutate any state. No audit log entry is written on read; only WARN logs on partial read failures.                                                                              |

## 3. Acceptance Criteria

### AC-1: Healthy daemon
```
Given heartbeat.json mtime within last 30s, ledger=12.34, approvals=3, ks=false
When GET /api/daemon-status
Then 200, body == {"status":"running","mtdSpend":12.34,"approvalsCount":3,"killSwitchEngaged":false,"heartbeatAgeMs":<number<60000>}
```

### AC-2: Stale daemon
```
Given heartbeat.json mtime 90s ago
When GET /api/daemon-status
Then status field == "stale" AND heartbeatAgeMs in [60000, 300000]
```

### AC-3: Down daemon (missing file)
```
Given heartbeat.json does not exist
When GET /api/daemon-status
Then 200, status == "down", heartbeatAgeMs == Infinity-equivalent (e.g. -1 sentinel documented)
```

### AC-4: Partial failure resilience (FR-4..FR-6)
```
Given cost-ledger throws but heartbeat is healthy
When GET /api/daemon-status
Then 200, status == "running", mtdSpend == 0 AND a structured WARN line is emitted
```

### AC-5: No-store header (FR-7)
```
Then response header Cache-Control == "no-store"
```

### AC-6: Latency (FR-8)
```
Given all four reads succeed with cold OS cache
Then p99 of 100 sequential probes < 50ms
```

## 4. Implementation

**File: `plugins/autonomous-dev-portal/server/routes/daemon-status.ts`** (new).

```ts
import type { Context } from "hono";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const RUNNING_MS = 60_000;
const STALE_MS = 300_000;

export interface DaemonStatusDeps {
    heartbeatPath?: string;
    readMtdSpend: () => Promise<number>;
    readApprovalsCount: () => Promise<number>;
    readKillSwitchEngaged: () => Promise<boolean>;
    logger: { warn(event: string, fields?: Record<string, unknown>): void };
}

export function buildDaemonStatusHandler(deps: DaemonStatusDeps) {
    const hbPath = deps.heartbeatPath ??
        join(homedir(), ".autonomous-dev", "heartbeat.json");
    return async (c: Context): Promise<Response> => {
        c.header("Cache-Control", "no-store");
        const [hbR, spendR, apprR, ksR] = await Promise.allSettled([
            fs.stat(hbPath),
            deps.readMtdSpend(),
            deps.readApprovalsCount(),
            deps.readKillSwitchEngaged(),
        ]);
        const heartbeatAgeMs = hbR.status === "fulfilled"
            ? Date.now() - hbR.value.mtimeMs : -1;
        const status = heartbeatAgeMs < 0 || heartbeatAgeMs > STALE_MS
            ? "down"
            : heartbeatAgeMs > RUNNING_MS ? "stale" : "running";
        if (spendR.status !== "fulfilled") deps.logger.warn("daemon_status_cost_unavailable");
        if (apprR.status !== "fulfilled") deps.logger.warn("daemon_status_approvals_unavailable");
        if (ksR.status !== "fulfilled") deps.logger.warn("daemon_status_ks_unavailable");
        return c.json({
            status, heartbeatAgeMs,
            mtdSpend: spendR.status === "fulfilled" ? spendR.value : 0,
            approvalsCount: apprR.status === "fulfilled" ? apprR.value : 0,
            killSwitchEngaged: ksR.status === "fulfilled" ? ksR.value : false,
        });
    };
}
```

Wire into `registerRoutes` after the SSE mount.

## 5. Tests

**Integration — `tests/integration/daemon-status.test.ts`:**

| Test ID | Scenario                  | Assert                                                            |
|---------|---------------------------|-------------------------------------------------------------------|
| DS-01   | running                    | 200, status=running, heartbeatAgeMs<60000                         |
| DS-02   | stale                      | status=stale, heartbeatAgeMs in [60000,300000]                    |
| DS-03   | missing heartbeat          | status=down, heartbeatAgeMs=-1                                    |
| DS-04   | cost-ledger throws         | status=running, mtdSpend=0, WARN emitted                          |
| DS-05   | cache header               | Cache-Control: no-store                                           |
| DS-06   | unauthenticated            | 401 from upstream auth middleware                                 |

## 6. Verification

```bash
curl -i -b session=... http://localhost:8787/api/daemon-status
# Expect: 200, Cache-Control: no-store, JSON body with all five fields
```
