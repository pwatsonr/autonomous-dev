# SPEC-009-4-1: Kill Switch Types and Abort Controller Manager

## Metadata
- **Parent Plan**: PLAN-009-4
- **Tasks Covered**: Task 1 (Define kill switch type system), Task 2 (Implement Global AbortController Manager)
- **Estimated effort**: 6 hours

## Description

Define the type system for the kill switch and emergency controls subsystem, and implement the abort controller manager that provides the signaling mechanism for both global kills and per-request cancellations. The abort manager is the bridge between the kill switch and pipeline executors: executors register to get an `AbortSignal`, and the kill switch triggers the abort when needed.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/emergency/types.ts` | Create | Kill switch types and interfaces |
| `src/emergency/abort-manager.ts` | Create | Global and per-request abort controller management |

## Implementation Details

### types.ts

```typescript
export type KillMode = "graceful" | "hard";

export type SystemState = "running" | "halted" | "paused";

export interface KillResult {
  mode: KillMode;
  issuedBy: string;
  issuedAt: Date;
  haltedRequests: StateSnapshot[];
  totalActiveRequests: number;
}

export interface StateSnapshot {
  requestId: string;
  pipelinePhase: string;
  phaseStatus: "running" | "completed" | "pending";
  artifacts: string[];              // Paths to generated artifacts
  pendingEscalationIds: string[];
  trustLevel: number;
}

export interface CancelResult {
  requestId: string;
  cancelledBy: string;
  cancelledAt: Date;
  snapshot: StateSnapshot;
}

export interface PauseResumeResult {
  requestId?: string;               // Undefined = all requests
  action: "paused" | "resumed";
  issuedBy: string;
  issuedAt: Date;
  affectedRequests: string[];
}

export type AbortReason = "KILL_GRACEFUL" | "KILL_HARD" | "CANCEL" | "PAUSE";

export interface TimerHandle {
  id: number | NodeJS.Timeout;
}
```

### abort-manager.ts

```typescript
export class AbortManager {
  private globalController: AbortController;
  private requestControllers: Map<string, AbortController>;

  constructor() {
    this.globalController = new AbortController();
    this.requestControllers = new Map();
  }

  // Pipeline executors call this to register and get a signal to check
  registerRequest(requestId: string): AbortSignal;

  // Called when a request completes normally
  deregisterRequest(requestId: string): void;

  // Abort all registered requests (kill switch)
  abortAll(reason: AbortReason): void;

  // Abort a specific request (cancel command)
  abortRequest(requestId: string, reason: AbortReason): void;

  // Get the list of currently registered (active) request IDs
  getActiveRequestIds(): string[];

  // Reset after re-enable: create fresh global controller
  reset(): void;

  // Check if the global signal is aborted
  isAborted(): boolean;
}
```

#### Key Behaviors

**registerRequest(requestId)**:
1. If `globalController.signal.aborted` is `true` (system is halted), return an already-aborted signal. This prevents new requests from starting during HALTED state.
2. Create a new `AbortController` for this request.
3. Store in `requestControllers` map.
4. Return a composite signal that aborts when EITHER the global controller OR the per-request controller is aborted. Implementation: create a derived `AbortController` that listens to both signals.

**Composite signal implementation**:
```typescript
function createCompositeSignal(global: AbortSignal, request: AbortSignal): AbortSignal {
  const composite = new AbortController();

  const onAbort = () => composite.abort();
  global.addEventListener('abort', onAbort, { once: true });
  request.addEventListener('abort', onAbort, { once: true });

  // If either is already aborted, abort immediately
  if (global.aborted || request.aborted) composite.abort();

  return composite.signal;
}
```

**abortAll(reason)**:
1. Set the reason on the global controller (via `abort(reason)`).
2. All composite signals derived from it are automatically aborted.
3. Does NOT clear the `requestControllers` map -- snapshots may need to reference them.

**abortRequest(requestId, reason)**:
1. Look up the per-request controller.
2. Call `abort(reason)` on it.
3. The composite signal for that request is aborted; other requests are unaffected.

**deregisterRequest(requestId)**:
1. Remove from `requestControllers` map.
2. No abort is triggered (request completed normally).

**reset()**:
1. Create a fresh `globalController`.
2. Clear `requestControllers` map.
3. Called after re-enable to allow new requests.

## Acceptance Criteria

1. All types exported from `types.ts` covering all states from TDD Section 3.3.
2. `SystemState` has exactly 3 members: `"running"`, `"halted"`, `"paused"`.
3. `KillMode` has exactly 2 members: `"graceful"`, `"hard"`.
4. `registerRequest` returns a signal that can be checked by pipeline executors.
5. `abortAll` aborts every registered request's signal.
6. `abortRequest` aborts only the target request's signal.
7. Registering after `abortAll` returns an already-aborted signal.
8. `deregisterRequest` cleans up without triggering an abort.
9. `reset()` creates a fresh global controller; new registrations get non-aborted signals.
10. `getActiveRequestIds()` returns only currently registered requests.

## Test Cases

1. **Register and get signal** -- `registerRequest("req-1")` returns an `AbortSignal` with `aborted === false`.
2. **Global abort signals all requests** -- Register 3 requests. `abortAll("KILL_HARD")`. All 3 signals have `aborted === true`.
3. **Per-request abort is scoped** -- Register `req-1` and `req-2`. `abortRequest("req-1", "CANCEL")`. `req-1` signal aborted; `req-2` signal NOT aborted.
4. **Register after global abort** -- `abortAll(...)`, then `registerRequest("req-new")` returns signal with `aborted === true`.
5. **Deregister removes request** -- `registerRequest("req-1")`, `deregisterRequest("req-1")`. `getActiveRequestIds()` does not include `"req-1"`.
6. **Deregister does not abort** -- `registerRequest("req-1")`. Save signal. `deregisterRequest("req-1")`. Signal still has `aborted === false`.
7. **Reset creates fresh state** -- `abortAll(...)`, `reset()`. `registerRequest("req-new")` returns signal with `aborted === false`. `isAborted() === false`.
8. **getActiveRequestIds** -- Register `req-1`, `req-2`, deregister `req-1`. Returns `["req-2"]`.
9. **Abort reason propagated** -- `abortAll("KILL_GRACEFUL")`. Signal's abort reason is `"KILL_GRACEFUL"`.
10. **Double abort is idempotent** -- `abortAll(...)` twice; no error; signals still aborted.
11. **Abort unknown request is no-op** -- `abortRequest("nonexistent", "CANCEL")` does not throw.
