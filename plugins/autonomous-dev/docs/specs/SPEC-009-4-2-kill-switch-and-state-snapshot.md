# SPEC-009-4-2: Kill Switch Core and State Snapshot

## Metadata
- **Parent Plan**: PLAN-009-4
- **Tasks Covered**: Task 3 (State Snapshot Capture), Task 4 (Implement KillSwitch class)
- **Estimated effort**: 12 hours

## Description

Implement the state snapshot capture mechanism that preserves the full system state at the moment of kill, and the core KillSwitch class with graceful and hard kill modes, per-request cancel, re-enable, and idempotency guarantees. The snapshot is captured BEFORE the abort signal is sent, ensuring a clean record of pre-kill state for forensic analysis.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/emergency/state-snapshot.ts` | Create | Pre-kill state capture and serialization |
| `src/emergency/kill-switch.ts` | Create | Core kill switch with graceful/hard modes |

## Implementation Details

### state-snapshot.ts

```typescript
export class StateSnapshotCapture {
  constructor(private stateDir: string) {}

  // Capture state for all active requests. Must complete in < 1 second.
  captureAll(activeRequestIds: string[]): StateSnapshot[];

  // Capture state for a single request
  captureOne(requestId: string): StateSnapshot;

  // Persist the kill snapshot to disk
  persistKillSnapshot(snapshots: StateSnapshot[], killMode: KillMode, issuedBy: string): string;
}
```

#### captureOne algorithm

Reads from the incremental state files (written after each phase completion by the pipeline orchestrator):

1. Read `.autonomous-dev/state/{requestId}/pipeline.json` for pipeline position and phase status.
2. List `.autonomous-dev/workspaces/{requestId}/` for generated artifact paths.
3. Read `.autonomous-dev/state/escalations/pending.json` and filter for this request's pending escalations.
4. Read trust level from pipeline state.

If any file is missing, use safe defaults (empty arrays, `"unknown"` phase status). The snapshot must never fail due to missing files.

#### persistKillSnapshot format

Written to: `.autonomous-dev/state/kill-snapshot-{timestamp}.json`

```json
{
  "kill_mode": "graceful",
  "issued_by": "user@example.com",
  "issued_at": "2026-04-08T10:30:00.000Z",
  "total_active_requests": 3,
  "snapshots": [
    {
      "requestId": "req-abc",
      "pipelinePhase": "code_review",
      "phaseStatus": "running",
      "artifacts": ["src/feature.ts", "src/feature.test.ts"],
      "pendingEscalationIds": ["esc-20260408-005"],
      "trustLevel": 2
    }
  ]
}
```

Written atomically: write to temp file, then rename (to prevent partial writes on hard kill).

### kill-switch.ts

```typescript
export class KillSwitch {
  private state: SystemState = "running";
  private lastKill: KillResult | null = null;

  constructor(
    private abortManager: AbortManager,
    private snapshotCapture: StateSnapshotCapture,
    private escalationEngine: { cancelAllPending(): void },
    private auditTrail: AuditTrail,
    private notifier: { emit(payload: NotificationPayload): void },
  ) {}

  async kill(mode: KillMode, issuedBy: string): Promise<KillResult>;
  async cancel(requestId: string, issuedBy: string): Promise<CancelResult>;
  isHalted(): boolean;
  getState(): SystemState;
  reenable(issuedBy: string): void;
}
```

#### kill() algorithm

```
async function kill(mode, issuedBy):
  // Idempotency check
  1. if this.state === "halted":
       auditTrail.append({ type: "kill_issued_duplicate", mode, issuedBy })
       return this.lastKill  // No-op, return previous result

  // Capture state BEFORE signaling
  2. activeIds = abortManager.getActiveRequestIds()
  3. snapshots = snapshotCapture.captureAll(activeIds)
  4. snapshotPath = snapshotCapture.persistKillSnapshot(snapshots, mode, issuedBy)

  // Signal abort
  5. if mode === "graceful":
       abortManager.abortAll("KILL_GRACEFUL")
       // Executors will finish current atomic operation, then stop
     else if mode === "hard":
       abortManager.abortAll("KILL_HARD")
       // Executors should stop immediately

  // Cancel all pending escalations
  6. escalationEngine.cancelAllPending()

  // Update state
  7. this.state = "halted"
  8. result = { mode, issuedBy, issuedAt: new Date(), haltedRequests: snapshots, totalActiveRequests: activeIds.length }
  9. this.lastKill = result

  // Audit and notification
  10. auditTrail.append({ type: "kill_issued", mode, issuedBy, snapshotPath, totalRequests: activeIds.length })
  11. notifier.emit({ type: "kill_switch_activated", urgency: "immediate", ... })

  12. return result
```

#### cancel() algorithm

```
async function cancel(requestId, issuedBy):
  1. snapshot = snapshotCapture.captureOne(requestId)
  2. abortManager.abortRequest(requestId, "CANCEL")
  3. auditTrail.append({ type: "cancel_issued", requestId, issuedBy })
  4. return { requestId, cancelledBy: issuedBy, cancelledAt: new Date(), snapshot }
```

Note: `cancel()` does NOT change the global system state to `"halted"`. Only `kill()` does.

#### reenable() algorithm

```
function reenable(issuedBy):
  1. if this.state !== "halted":
       throw new Error("Cannot re-enable: system is not halted")

  2. abortManager.reset()
  3. this.state = "running"
  4. this.lastKill = null
  5. auditTrail.append({ type: "system_reenabled", issuedBy })
```

## Acceptance Criteria

1. State snapshot captures pipeline position, artifacts, pending escalations, and trust level for all active requests.
2. Missing state files do not cause snapshot failure (safe defaults used).
3. Kill snapshot written atomically (temp + rename) before abort signal.
4. Snapshot completes in < 1 second for up to 10 active requests.
5. Graceful kill sends `KILL_GRACEFUL` abort reason to all requests.
6. Hard kill sends `KILL_HARD` abort reason to all requests.
7. State transitions to `"halted"` after kill.
8. `isHalted()` returns `true` after kill.
9. All pending escalation chains cancelled during kill.
10. Idempotent: second kill while halted returns previous result, no state change.
11. `cancel()` aborts a single request without changing global state.
12. `reenable()` restores system to `"running"`, creates fresh abort controller.
13. `reenable()` throws if system is not halted.
14. Audit events: `kill_issued`, `cancel_issued`, `system_reenabled`, `kill_issued_duplicate`.
15. Immediate-urgency notification emitted on kill.

## Test Cases

### State Snapshot

1. **Capture single request** -- Pipeline state file exists; snapshot has correct phase and artifacts.
2. **Capture with missing pipeline file** -- No pipeline.json; snapshot uses defaults (unknown phase, empty artifacts).
3. **Capture multiple requests** -- 3 active requests; `captureAll` returns 3 snapshots.
4. **Persist kill snapshot atomically** -- Verify file written to expected path; content matches JSON schema.
5. **Persist uses temp+rename** -- Verify no partial file visible during write (mock fs to observe write pattern).

### Kill Switch

6. **Graceful kill signals all requests** -- Kill with `"graceful"`; all registered abort signals have `aborted === true` with reason `KILL_GRACEFUL`.
7. **Hard kill signals all requests** -- Kill with `"hard"`; all signals aborted with reason `KILL_HARD`.
8. **State transitions to halted** -- After kill, `getState()` returns `"halted"` and `isHalted()` returns `true`.
9. **Snapshot captured before abort** -- Verify `captureAll` called before `abortAll` (use spy call ordering).
10. **Escalation chains cancelled** -- Verify `escalationEngine.cancelAllPending()` called during kill.
11. **Idempotent double kill** -- Kill twice; second call returns same result; `kill_issued_duplicate` audit event emitted; state still `"halted"`.
12. **Cancel single request** -- Cancel `req-1`; only `req-1` aborted; global state still `"running"`.
13. **Cancel emits audit event** -- `cancel_issued` event with `requestId` and `cancelledBy`.
14. **Re-enable restores running** -- After kill, `reenable("admin")`; `getState()` returns `"running"`; new registrations get non-aborted signals.
15. **Re-enable when not halted throws** -- Call `reenable()` while `"running"`; error thrown.
16. **Re-enable emits audit event** -- `system_reenabled` event with `issuedBy`.
17. **Notification emitted on kill** -- `notifier.emit` called with `urgency: "immediate"`.
