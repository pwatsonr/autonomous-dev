# SPEC-009-4-3: HALTED State Gate and Pause/Resume Controls

## Metadata
- **Parent Plan**: PLAN-009-4
- **Tasks Covered**: Task 5 (HALTED state gate), Task 6 (Pause/Resume commands), Task 8 (Emergency config loader)
- **Estimated effort**: 11 hours

## Description

Implement the HALTED state gate middleware that rejects all incoming pipeline requests when the system is halted, the pause/resume commands that provide lighter-weight execution control without full kill semantics, and the emergency configuration loader. The HALTED gate enforces that no work can proceed until explicit human re-enablement. Pause/resume provide a reversible stop that does not require the human ceremony of re-enable.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/emergency/halted-gate.ts` | Create | Request rejection middleware for HALTED state |
| `src/emergency/pause-resume.ts` | Create | Pause and resume pipeline execution |
| `src/emergency/emergency-config.ts` | Create | Emergency config parsing and validation |

## Implementation Details

### halted-gate.ts

```typescript
export class HaltedGate {
  constructor(private killSwitch: KillSwitch) {}

  // Middleware check: call before processing any incoming pipeline request
  checkAccess(requestId: string): GateCheckResult;
}

export type GateCheckResult =
  | { allowed: true }
  | { allowed: false; error: HaltedError };

export interface HaltedError {
  code: "SYSTEM_HALTED";
  message: string;
  killedBy: string;
  killedAt: Date;
  killMode: KillMode;
}
```

#### checkAccess algorithm

```
function checkAccess(requestId):
  1. if !killSwitch.isHalted():
       return { allowed: true }

  2. lastKill = killSwitch.getLastKillResult()
  3. return {
       allowed: false,
       error: {
         code: "SYSTEM_HALTED",
         message: "System is halted. Kill issued by {lastKill.issuedBy} at {lastKill.issuedAt} (mode: {lastKill.mode}). Re-enable required before processing new requests.",
         killedBy: lastKill.issuedBy,
         killedAt: lastKill.issuedAt,
         killMode: lastKill.mode,
       }
     }
```

#### restart_requires_human enforcement

The `emergency.restart_requires_human` config value is hardcoded to `true`. The config loader rejects any attempt to set it to `false`:
- If the YAML sets `restart_requires_human: false`, the config loader logs an error and forces it to `true`.
- There is no code path that allows the system to re-enable without human action.

### pause-resume.ts

```typescript
export class PauseResumeController {
  constructor(
    private abortManager: AbortManager,
    private auditTrail: AuditTrail,
  ) {}

  // Pause all pipelines or a specific request
  pause(issuedBy: string, requestId?: string): PauseResumeResult;

  // Resume paused pipelines or a specific request
  resume(issuedBy: string, requestId?: string): PauseResumeResult;

  // Check if a specific request is paused
  isPaused(requestId: string): boolean;

  // Check if all pipelines are paused
  isGloballyPaused(): boolean;
}
```

#### Pause vs Kill Comparison

| Feature | Pause | Kill |
|---------|-------|------|
| Stops execution | At next phase boundary | At atomic boundary (graceful) or immediately (hard) |
| State snapshot | No | Yes |
| HALTED gate | No | Yes (rejects new requests) |
| Re-enable ceremony | No (just `/resume`) | Yes (explicit human action) |
| Escalation cancellation | No | Yes |
| Scope | Global or per-request | Global only |
| Audit events | `pause_issued`, `resume_issued` | `kill_issued`, `system_reenabled` |

#### Pause implementation

Pause signals are conveyed through the abort mechanism with a `"PAUSE"` reason. Pipeline executors should check the signal and the reason: `PAUSE` means stop at next boundary and wait for resume; `KILL_*` means stop and do not resume automatically.

Internal state tracks paused requests:
```typescript
private pausedRequests: Set<string>;   // Per-request pauses
private globallyPaused: boolean;        // Global pause
```

#### Resume implementation

Resume clears the pause state and allows executors to continue:
- For per-request pause: remove from `pausedRequests` set.
- For global pause: set `globallyPaused = false`.
- Signal the executor to check again (via a resume event or callback).

### emergency-config.ts

```typescript
export class EmergencyConfigLoader {
  constructor(private configProvider: ConfigProvider) {}
  load(): EmergencyConfig;
}

export interface EmergencyConfig {
  kill_default_mode: KillMode;              // Default: "graceful"
  restart_requires_human: true;             // Immutable: always true
}
```

Validation rules:
- `kill_default_mode` must be `"graceful"` or `"hard"`. Invalid -> `"graceful"`.
- `restart_requires_human` is always `true`. If set to `false` in config, log error and force `true`.

## Acceptance Criteria

1. HALTED gate rejects requests with `SYSTEM_HALTED` error when system is halted.
2. Error message includes who issued the kill and when.
3. HALTED gate allows requests when system is running.
4. `restart_requires_human` is always `true`; config override rejected with logged error.
5. Pause stops execution at next phase boundary without triggering HALTED state.
6. Resume continues from the pause point.
7. Pause/resume can be global or per-request.
8. Pause does not cancel pending escalations.
9. Pause does not capture state snapshot.
10. Audit events `pause_issued` and `resume_issued` emitted.
11. Config: valid emergency config loads correctly.
12. Config: invalid `kill_default_mode` falls back to `"graceful"`.

## Test Cases

### HALTED Gate

1. **Running: access allowed** -- System running; `checkAccess("req-1")` returns `{ allowed: true }`.
2. **Halted: access denied** -- After kill; `checkAccess("req-1")` returns `{ allowed: false }` with SYSTEM_HALTED error.
3. **Error includes context** -- Error message contains `killedBy`, `killedAt`, and `killMode`.
4. **Re-enabled: access allowed again** -- After kill then reenable; `checkAccess` returns allowed.

### Pause/Resume

5. **Global pause pauses all** -- `pause("admin")`. `isGloballyPaused()` returns `true`.
6. **Global resume resumes all** -- After global pause, `resume("admin")`. `isGloballyPaused()` returns `false`.
7. **Per-request pause** -- `pause("admin", "req-1")`. `isPaused("req-1")` returns `true`. `isPaused("req-2")` returns `false`.
8. **Per-request resume** -- After per-request pause, `resume("admin", "req-1")`. `isPaused("req-1")` returns `false`.
9. **Pause does not trigger HALTED** -- After pause, `killSwitch.isHalted()` still returns `false`.
10. **Pause emits audit event** -- `pause_issued` event with `issuedBy` and affected requests.
11. **Resume emits audit event** -- `resume_issued` event.
12. **Pause does not cancel escalations** -- Pending escalation chains remain active after pause.

### Emergency Config

13. **Valid config loads** -- `{ kill_default_mode: "hard" }` loads as `KillMode = "hard"`.
14. **Invalid mode defaults to graceful** -- `{ kill_default_mode: "nuclear" }` loads as `"graceful"`.
15. **restart_requires_human forced true** -- `{ restart_requires_human: false }` loads as `true`, error logged.
16. **Missing config uses defaults** -- Empty config -> `{ kill_default_mode: "graceful", restart_requires_human: true }`.
