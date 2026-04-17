# SPEC-009-2-4: Escalation Engine Facade, Config, and Tests

## Metadata
- **Parent Plan**: PLAN-009-2
- **Tasks Covered**: Task 6 (EscalationEngine facade), Task 7 (Escalation config loader), Task 8 (Barrel exports), Task 9 (Unit tests), Task 10 (Integration tests)
- **Estimated effort**: 24 hours

## Description

Implement the EscalationEngine facade that orchestrates the classifier, formatter, routing engine, and chain manager into a unified `raise()` entry point. Includes the configuration loader for the `escalation:` YAML section, barrel exports with dependency injection wiring, and the complete test suite covering all TDD Section 8.1 and 8.2 escalation scenarios.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/escalation/escalation-engine.ts` | Create | Main EscalationEngine facade |
| `src/escalation/escalation-config.ts` | Create | Config parsing and validation |
| `src/escalation/index.ts` | Create | Barrel exports and factory |
| `src/escalation/__tests__/classifier.test.ts` | Create | Classifier unit tests |
| `src/escalation/__tests__/formatter.test.ts` | Create | Formatter unit tests |
| `src/escalation/__tests__/routing-engine.test.ts` | Create | Routing engine unit tests |
| `src/escalation/__tests__/chain-manager.test.ts` | Create | Chain manager unit tests |
| `src/escalation/__tests__/escalation-engine.test.ts` | Create | Facade unit tests |
| `src/escalation/__tests__/escalation-engine.integration.test.ts` | Create | Integration tests |

## Implementation Details

### escalation-engine.ts

```typescript
export class EscalationEngine {
  constructor(
    private classifier: EscalationClassifier,
    private formatter: EscalationFormatter,
    private routingEngine: RoutingEngine,
    private chainManager: EscalationChainManager,
    private auditTrail: AuditTrail,
  ) {}

  raise(failureContext: FailureContext, requestContext: RequestContext): EscalationMessage;
  cancelPending(requestId: string): void;
  cancelAllPending(): void;
}

export interface RequestContext {
  requestId: string;
  repository: string;
  pipelinePhase: string;
  previousEscalationId?: string;
  retryCount: number;
}
```

#### raise() algorithm

```
function raise(failureContext, requestContext):
  1. { type, urgency } = classifier.classify(failureContext)
  2. options = buildOptionsForType(type, urgency)
  3. message = formatter.format({ ...requestContext, escalationType: type, urgency, options, ... })
  4. route = routingEngine.resolveRouting(type)
  5. chainManager.startChain(message, route)

  // Pipeline behavior enforcement per TDD Section 3.2.1:
  6. pipelineBehavior = resolvePipelineBehavior(type)
     // security -> HALT_IMMEDIATELY
     // infrastructure -> PAUSE_IMMEDIATELY
     // cost -> PAUSE_BEFORE_INCURRING
     // product | technical | quality -> PAUSE_AT_GATE_BOUNDARY

  7. return message  // Caller (pipeline orchestrator) acts on pipelineBehavior
```

#### Pipeline Behavior Enum

```typescript
export type PipelineBehavior =
  | "halt_immediately"       // security: stop all execution now
  | "pause_immediately"      // infrastructure: stop at current point
  | "pause_before_incurring" // cost: stop before the costly operation
  | "pause_at_boundary";     // product/technical/quality: stop at next gate
```

### escalation-config.ts

```typescript
export class EscalationConfigLoader {
  constructor(private configProvider: ConfigProvider) {}
  load(): EscalationConfig;
}
```

Validation rules:
- `routing.mode` must be `"default"` or `"advanced"`. Invalid -> `"default"`.
- `routing.default_target` must be present with `target_id` and `channel`. Missing -> error, system cannot start.
- `routing.advanced` per-type entries: `timeout_minutes` must be positive integer (default: 60). `timeout_behavior` must be one of the 4 valid values (default: `"pause"`).
- **Security invariant**: `routing.advanced.security.timeout_behavior` is forced to `"pause"` regardless of config value. If configured otherwise, log a warning and override.
- `verbosity` must be `"terse"`, `"standard"`, or `"verbose"` (default: `"standard"`).
- `retry_budget` must be positive integer (default: 3).

### index.ts

```typescript
export { EscalationEngine } from './escalation-engine';
export { EscalationClassifier } from './classifier';
export { EscalationFormatter, EscalationIdGenerator } from './formatter';
export { RoutingEngine } from './routing-engine';
export { EscalationChainManager } from './chain-manager';
export * from './types';
export * from './response-types';  // Forward reference for PLAN-009-3

export function createEscalationEngine(
  configProvider: ConfigProvider,
  deliveryAdapter: DeliveryAdapter,
  auditTrail: AuditTrail,
  timer: Timer,
  statePath: string,
): EscalationEngine;
```

## Acceptance Criteria

1. `raise()` produces a schema-valid `EscalationMessage`, dispatches it to the correct target, and starts a chain timer.
2. Pipeline behavior matches escalation type: security halts, infrastructure pauses, cost pauses before incurring, others pause at boundary.
3. Re-escalation links via `previous_escalation_id` when provided.
4. `cancelPending(requestId)` cancels all chains for that request.
5. `cancelAllPending()` cancels all chains globally.
6. Config: valid escalation config loads correctly.
7. Config: invalid routing mode falls back to `"default"`.
8. Config: missing default_target prevents system start (fatal error).
9. Config: security timeout behavior forced to `"pause"`.
10. All unit tests pass with 100% branch coverage.
11. All integration test scenarios pass.
12. All dependencies injectable via constructor.

## Test Cases

### Unit: escalation-engine.test.ts

1. **raise() classifies and formats** -- Verify classifier and formatter called with correct inputs.
2. **raise() routes and starts chain** -- Verify routing engine and chain manager called.
3. **Security type halts immediately** -- `raise()` with security failure returns `halt_immediately` behavior.
4. **Infrastructure pauses immediately** -- Returns `pause_immediately`.
5. **Cost pauses before incurring** -- Returns `pause_before_incurring`.
6. **Product/technical/quality pause at boundary** -- Returns `pause_at_boundary`.
7. **Re-escalation links previous ID** -- `previousEscalationId` propagated to formatter.
8. **cancelPending delegates to chain manager** -- Verify `cancelAllPendingForRequest` called.

### Unit: escalation-config.test.ts

9. **Valid config loads** -- Full config with all fields parses correctly.
10. **Invalid routing mode defaults** -- `mode: "unknown"` -> `"default"`.
11. **Missing default_target throws** -- Config without default_target raises fatal error.
12. **Security timeout forced to pause** -- `security.timeout_behavior: "cancel"` overridden to `"pause"`, warning logged.
13. **Default verbosity is standard** -- Missing verbosity field -> `"standard"`.

### Integration: escalation-engine.integration.test.ts

14. **Quality escalation after 3 retries** -- Create failure context with review gate failure at retry 3/3. Verify: classified as `quality`, formatted with correct message, routed to configured target, chain started with timer. Audit events: `escalation_raised`.

15. **Escalation chain timeout to secondary** -- Raise an escalation with primary and secondary targets configured. Advance mock timer past primary timeout. Verify: secondary target receives the escalation. Advance timer past secondary timeout. Verify: timeout behavior (`pause`) applied. Audit events: `escalation_raised`, `escalation_timeout` (primary), `escalation_timeout` (secondary).

16. **Security escalation halts immediately** -- Raise a security escalation. Verify: urgency is `immediate`, pipeline behavior is `halt_immediately`, timeout behavior is `pause` (immutable). Chain started with `pause` behavior regardless of config.
