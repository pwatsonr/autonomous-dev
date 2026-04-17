# SPEC-009-2-3: Routing Engine and Escalation Chain Manager

## Metadata
- **Parent Plan**: PLAN-009-2
- **Tasks Covered**: Task 4 (Implement Routing Engine), Task 5 (Implement Escalation Chain Manager)
- **Estimated effort**: 12 hours

## Description

Implement the routing engine that determines the human target for each escalation type, and the chain manager that handles timeout-based escalation chains with secondary routing and timeout behaviors. Together, these components ensure that escalations reach the right person and that unresponsive targets are handled gracefully with configurable fallback behaviors.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/escalation/routing-engine.ts` | Create | Target resolution for escalation routing |
| `src/escalation/chain-manager.ts` | Create | Timeout chains and escalation lifecycle |

## Implementation Details

### routing-engine.ts

```typescript
export class RoutingEngine {
  constructor(private config: EscalationConfig) {}

  resolveRouting(escalationType: EscalationType): ResolvedRoute;
}

export interface ResolvedRoute {
  primary: RoutingTarget;
  secondary?: RoutingTarget;
  timeoutMinutes: number;
  timeoutBehavior: TimeoutBehavior;
}
```

Resolution algorithm:
1. If `config.routing.mode === "default"`: return `{ primary: config.routing.default_target, secondary: undefined, timeoutMinutes: 60, timeoutBehavior: "pause" }`.
2. If `config.routing.mode === "advanced"`:
   a. Look up `config.routing.advanced[escalationType]`.
   b. If found: return the configured primary, secondary, timeout, and behavior.
   c. If NOT found: fall back to `default_target` for primary, log a warning, use default timeout and behavior.
3. If the resolved primary target is unknown (target_id not in any known channel): fall back to `default_target`, log warning.
4. **Security invariant**: if `escalationType === "security"`, force `timeoutBehavior = "pause"` regardless of config.

### chain-manager.ts

```typescript
export class EscalationChainManager {
  constructor(
    private timer: Timer,              // Injectable timer for testability
    private deliveryAdapter: DeliveryAdapter,
    private auditTrail: AuditTrail,
  ) {}

  // Start an escalation chain: dispatch to primary, start timeout timer
  startChain(escalation: EscalationMessage, route: ResolvedRoute): ChainState;

  // Cancel a chain (e.g., when response arrives or kill switch fires)
  cancelChain(escalationId: string): void;

  // Cancel all pending chains for a request
  cancelAllPendingForRequest(requestId: string): void;

  // Cancel all pending chains globally (for kill switch)
  cancelAllPending(): void;

  // Get chain state for an escalation
  getChainState(escalationId: string): ChainState | null;
}

export interface ChainState {
  escalationId: string;
  requestId: string;
  status: "primary_dispatched" | "secondary_dispatched" | "timeout_behavior_applied" | "resolved" | "cancelled";
  primaryTarget: RoutingTarget;
  secondaryTarget?: RoutingTarget;
  primaryDispatchedAt: Date;
  secondaryDispatchedAt?: Date;
  timeoutBehavior: TimeoutBehavior;
  timeoutMinutes: number;
}

// Injectable timer interface for deterministic testing
export interface Timer {
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}
```

Chain lifecycle:

```
startChain()
  |
  v
[Dispatch to PRIMARY target via deliveryAdapter]
  |-- Emit "escalation_raised" audit event
  |-- Start timeout timer (route.timeoutMinutes * 60 * 1000 ms)
  |
  v (on timeout)
[PRIMARY TIMEOUT]
  |-- If secondary target exists:
  |     |-- Dispatch to SECONDARY target via deliveryAdapter
  |     |-- Emit "escalation_timeout" audit event with { target: "primary", chainedTo: "secondary" }
  |     |-- Start secondary timeout timer (same duration)
  |     |
  |     v (on secondary timeout)
  |   [SECONDARY TIMEOUT]
  |     |-- Apply timeout behavior
  |     |-- Emit "escalation_timeout" audit event with { target: "secondary", behavior: timeoutBehavior }
  |
  |-- If NO secondary target:
        |-- Apply timeout behavior directly
        |-- Emit "escalation_timeout" audit event with { target: "primary", behavior: timeoutBehavior }
```

### Timeout Behavior Application

| Behavior | Action |
|----------|--------|
| `pause` | Pipeline stays paused indefinitely. No further automatic action. Escalation remains open. |
| `retry` | Signal pipeline to re-execute the failed phase with a different approach. Mark escalation as `timeout_behavior_applied`. |
| `skip` | Proceed past the gate. ONLY allowed for `informational` urgency. If urgency is not `informational`, fall back to `pause` and log warning. |
| `cancel` | Terminate the request. Preserve state for forensic analysis. Mark escalation as `timeout_behavior_applied`. |

### Cancellation

- `cancelChain(escalationId)`: Clear the active timer, set status to `"cancelled"`.
- `cancelAllPendingForRequest(requestId)`: Find all chains for the request, cancel each.
- `cancelAllPending()`: Cancel all active chains globally (used by kill switch).
- Cancelling an already-resolved or already-cancelled chain is a no-op (idempotent).

## Acceptance Criteria

1. Default routing mode sends all escalation types to `default_target`.
2. Advanced routing mode sends each type to its configured primary target.
3. Missing type config in advanced mode falls back to `default_target` with logged warning.
4. Unknown primary target falls back to `default_target` with logged warning.
5. Security escalation timeout behavior is always `pause`, regardless of config.
6. Primary target dispatched first via delivery adapter.
7. Secondary target dispatched after primary timeout expires.
8. Timeout behavior applied after chain is fully exhausted.
9. `skip` behavior rejected for non-informational urgency; falls back to `pause`.
10. Timer is cancellable -- response arriving before timeout cancels the timer.
11. `cancelAllPending()` cancels all active chains.
12. Double-cancel is idempotent.
13. Audit events `escalation_raised` and `escalation_timeout` emitted at correct points.

## Test Cases

### Routing Engine

1. **Default mode routes to default_target** -- All 6 types resolve to the same target.
2. **Advanced mode routes product to product target** -- `resolveRouting("product")` returns product-specific target.
3. **Advanced mode routes security to security target** -- With security target configured.
4. **Advanced mode missing type falls back** -- `resolveRouting("cost")` with no cost config returns default_target, warning logged.
5. **Security forces pause timeout** -- `resolveRouting("security")` returns `{ timeoutBehavior: "pause" }` even if config says `"cancel"`.
6. **Unknown target fallback** -- Primary target with unknown `target_id` falls back to default.

### Chain Manager

7. **Start chain dispatches to primary** -- `startChain` calls `deliveryAdapter.deliver` with the escalation message and primary target.
8. **Primary timeout triggers secondary dispatch** -- Advance mock timer by timeout duration; verify secondary dispatch.
9. **Secondary timeout applies behavior** -- Advance timer again; verify timeout behavior applied.
10. **No secondary: timeout applies behavior directly** -- Route with no secondary; primary timeout directly applies behavior.
11. **Cancel clears timer** -- `cancelChain` prevents timeout callback from firing.
12. **Cancel after resolution is no-op** -- Resolve chain, then cancel; no error.
13. **cancelAllPending cancels all** -- Start 3 chains; `cancelAllPending()`; all timers cleared.
14. **cancelAllPendingForRequest scoped** -- Start chains for 2 requests; cancel one request's chains; other's remain active.
15. **Skip rejected for non-informational** -- Timeout behavior `skip` with `soon` urgency falls back to `pause`, warning logged.
16. **Skip allowed for informational** -- Timeout behavior `skip` with `informational` urgency proceeds.
17. **Audit: escalation_raised on start** -- Verify audit event emitted with escalation_id, type, target.
18. **Audit: escalation_timeout on primary timeout** -- Verify event includes `{ target: "primary" }`.
19. **Audit: escalation_timeout on secondary timeout** -- Verify event includes `{ target: "secondary", behavior }`.
