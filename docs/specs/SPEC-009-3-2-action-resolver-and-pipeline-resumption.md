# SPEC-009-3-2: Action Resolver and Pipeline Resumption

## Metadata
- **Parent Plan**: PLAN-009-3
- **Tasks Covered**: Task 4 (Implement Action Resolver), Task 5 (Implement Pipeline Resumption Coordinator)
- **Estimated effort**: 12 hours

## Description

Implement the action resolver that maps validated human responses to one of five pipeline actions, and the pipeline resumption coordinator that incorporates the resolved action into the pipeline execution context and resumes or terminates the pipeline. The resumption coordinator is transactional: either the pipeline fully resumes or it remains paused -- partial resumption is not possible.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/escalation/action-resolver.ts` | Create | Response-to-action mapping |
| `src/escalation/pipeline-resumption.ts` | Create | Pipeline resume/terminate coordination |

## Implementation Details

### action-resolver.ts

```typescript
export class ActionResolver {
  resolve(response: EscalationResponse, escalation: StoredEscalation): ResolvedAction;
}
```

Mapping rules:

| Response Type | Condition | Resolved Action |
|---------------|-----------|-----------------|
| `option` | Option's `action === "approve"` | `{ action: "approve" }` |
| `option` | Option's `action === "retry"` or `action === "retry_with_changes"` | `{ action: "retry_with_changes", guidance: option.description \|\| "" }` |
| `option` | Option's `action === "cancel"` or `action === "reject"` | `{ action: "cancel" }` |
| `option` | Option's `action === "override"` | `{ action: "override_proceed", justification: option.description \|\| "No justification provided" }` |
| `option` | Option's `action === "approve_with_conditions"` | `{ action: "retry_with_changes", guidance: option.description }` |
| `freetext` | Always | `{ action: "retry_with_changes", guidance: response.freetext }` |
| `delegate` | Always | `{ action: "delegate", target: response.delegate_target }` |

Key distinction: `approve` and `override_proceed` both allow the pipeline to continue, but `override_proceed` is logged as a `human_override` audit event. `override_proceed` is used when the human explicitly overrides a system recommendation (e.g., system recommended blocking, human says proceed anyway).

### pipeline-resumption.ts

```typescript
export class PipelineResumptionCoordinator {
  constructor(
    private pipelineExecutor: PipelineExecutor,
    private escalationChainManager: EscalationChainManager,
    private auditTrail: AuditTrail,
  ) {}

  resume(escalation: StoredEscalation, action: ResolvedAction, responder: string): ResumeResult;
}

// Minimal interface for pipeline control
export interface PipelineExecutor {
  markGatePassed(requestId: string, gate: string): void;
  markGateOverridden(requestId: string, gate: string, justification: string): void;
  injectGuidance(requestId: string, guidance: string): void;
  reExecutePhase(requestId: string): void;
  terminateRequest(requestId: string, reason: string): void;
  resumePipeline(requestId: string): void;
}

export interface ResumeResult {
  success: boolean;
  action: string;
  requestId: string;
  error?: string;
}
```

#### resume() action handling

| Action | Steps |
|--------|-------|
| `approve` | 1. Cancel escalation chain timer. 2. `pipelineExecutor.markGatePassed(requestId, gate)`. 3. `pipelineExecutor.resumePipeline(requestId)`. 4. Emit `escalation_resolved` audit event. |
| `retry_with_changes` | 1. Cancel chain timer. 2. `pipelineExecutor.injectGuidance(requestId, guidance)`. 3. `pipelineExecutor.reExecutePhase(requestId)`. 4. Emit `escalation_resolved` audit event. |
| `cancel` | 1. Cancel chain timer. 2. `pipelineExecutor.terminateRequest(requestId, "Cancelled by human")`. 3. Emit `escalation_resolved` audit event with `{ resolution: "cancelled" }`. |
| `override_proceed` | 1. Cancel chain timer. 2. `pipelineExecutor.markGateOverridden(requestId, gate, justification)`. 3. `pipelineExecutor.resumePipeline(requestId)`. 4. Emit `human_override` audit event with `{ responder, justification, gate }`. 5. Emit `escalation_resolved` audit event. |
| `delegate` | 1. Cancel chain timer for current target. 2. Re-dispatch escalation to new target via chain manager (call `startChain` with updated routing). 3. Emit `escalation_resolved` audit event with `{ resolution: "delegated", newTarget }`. Note: the escalation is NOT fully resolved; it's re-routed. |

#### Transactional Semantics

The `resume()` method wraps pipeline executor calls in a try-catch. If any step fails:
- The pipeline remains paused (no partial resumption).
- The escalation chain is NOT cancelled (response not consumed).
- The error is logged and returned in `ResumeResult`.
- The human can retry their response.

## Acceptance Criteria

1. All 5 action types correctly resolved from corresponding response types.
2. `approve` maps from options with `action === "approve"`.
3. `retry_with_changes` maps from freetext responses and retry/approve_with_conditions options.
4. `cancel` maps from options with `action === "cancel"` or `"reject"`.
5. `override_proceed` maps from options with `action === "override"`.
6. `delegate` maps from delegate responses.
7. `override_proceed` is logged as `human_override` audit event -- distinct from `approve`.
8. `approve` resumes pipeline at the gate; gate marked as passed.
9. `retry_with_changes` injects guidance and re-executes the phase.
10. `cancel` terminates the request with state preserved.
11. `override_proceed` marks gate as overridden with justification; resumes pipeline.
12. `delegate` re-dispatches to new target without resolving the escalation.
13. Failed resumption leaves pipeline paused; escalation remains active; error returned.
14. Escalation chain timer cancelled on every successful action except delegate (which starts a new chain).

## Test Cases

### Action Resolver

1. **Option approve -> approve action** -- Option `{ action: "approve" }` resolves to `{ action: "approve" }`.
2. **Option retry -> retry_with_changes** -- Option `{ action: "retry", description: "Use smaller batches" }` resolves to `{ action: "retry_with_changes", guidance: "Use smaller batches" }`.
3. **Option cancel -> cancel action** -- Option `{ action: "cancel" }` resolves to `{ action: "cancel" }`.
4. **Option reject -> cancel action** -- Option `{ action: "reject" }` also resolves to `{ action: "cancel" }`.
5. **Option override -> override_proceed** -- Option `{ action: "override", description: "Risk accepted" }` resolves to `{ action: "override_proceed", justification: "Risk accepted" }`.
6. **Option override with no description** -- Justification defaults to `"No justification provided"`.
7. **Freetext -> retry_with_changes** -- Freetext `"Try using the v2 API instead"` resolves to `{ action: "retry_with_changes", guidance: "Try using the v2 API instead" }`.
8. **Delegate -> delegate action** -- Delegate `"security-lead"` resolves to `{ action: "delegate", target: "security-lead" }`.
9. **Option approve_with_conditions -> retry_with_changes** -- Conditions treated as guidance for retry.

### Pipeline Resumption

10. **Approve resumes pipeline** -- Verify `markGatePassed` and `resumePipeline` called; chain timer cancelled; `escalation_resolved` emitted.
11. **Retry injects guidance and re-executes** -- Verify `injectGuidance` and `reExecutePhase` called with correct args.
12. **Cancel terminates request** -- Verify `terminateRequest` called; state preserved.
13. **Override marks gate as overridden** -- Verify `markGateOverridden` called with justification; `human_override` audit event emitted WITH responder and justification.
14. **Delegate re-dispatches** -- Verify old chain cancelled, new chain started with new target.
15. **Failed resumption: pipeline stays paused** -- `pipelineExecutor.resumePipeline` throws; result has `success: false`; chain NOT cancelled.
16. **Failed resumption: escalation remains active** -- After failure, escalation status still `"pending"`.
17. **Audit: escalation_resolved emitted for approve** -- Verify event payload.
18. **Audit: human_override emitted for override** -- Verify event includes `responder`, `justification`, `gate`.
19. **Audit: escalation_resolved with delegation** -- Resolution type is `"delegated"`, includes new target.
