# SPEC-009-3-3: Re-Escalation Manager and Gate Approval Templates

## Metadata
- **Parent Plan**: PLAN-009-3
- **Tasks Covered**: Task 6 (Implement Re-Escalation Manager), Task 7 (Implement Gate Approval Response Templates)
- **Estimated effort**: 9 hours

## Description

Implement the re-escalation manager that handles the case where a phase fails again after incorporating human guidance, with loop detection after 3+ re-escalations. Also implement the predefined gate approval response templates that provide structured options for common gate approval scenarios (PRD approval, code review, deployment approval, security review). These templates are used by the formatter when constructing gate-level escalation messages.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/escalation/re-escalation-manager.ts` | Create | Re-escalation tracking and loop detection |
| `src/escalation/gate-approval-templates.ts` | Create | Predefined option sets for gate approvals |

## Implementation Details

### re-escalation-manager.ts

```typescript
export class ReEscalationManager {
  constructor(
    private escalationEngine: EscalationEngine,
    private auditTrail: AuditTrail,
  ) {}

  // Called when a phase fails after human guidance was applied
  handlePostGuidanceFailure(
    originalEscalationId: string,
    failureContext: FailureContext,
    requestContext: RequestContext,
    guidanceApplied: string,
  ): EscalationMessage;

  // Get the re-escalation count for an escalation chain
  getReEscalationCount(originalEscalationId: string): number;
}
```

#### Internal State

```typescript
// Tracks the chain of re-escalations from an original escalation
private chains: Map<string, ReEscalationChain>;

interface ReEscalationChain {
  originalEscalationId: string;
  escalationIds: string[];           // Chronological list of all IDs in chain
  count: number;                     // Number of re-escalations
  guidanceHistory: GuidanceAttempt[];
}

interface GuidanceAttempt {
  escalationId: string;
  guidanceApplied: string;
  failureReason: string;
  timestamp: Date;
}
```

#### handlePostGuidanceFailure algorithm

```
function handlePostGuidanceFailure(originalId, failureContext, requestContext, guidance):
  1. chain = getOrCreateChain(originalId)
  2. chain.count++
  3. chain.guidanceHistory.push({ guidance, failureReason: failureContext.errorMessage })

  4. if chain.count >= 3:
       // Loop detection triggered
       return raiseLoopDetectedEscalation(chain, failureContext, requestContext)

  5. // Normal re-escalation
  6. enrichedContext = {
       ...requestContext,
       previousEscalationId: chain.escalationIds[chain.escalationIds.length - 1],
     }
  7. message = escalationEngine.raise(failureContext, enrichedContext)
  8. chain.escalationIds.push(message.escalation_id)
  9. return message
```

#### Loop Detection Escalation (count >= 3)

When re-escalation count reaches 3 or more:

1. **Route to secondary target** (not primary). This is a meta-escalation that bypasses the normal primary routing.
2. **Enhanced summary**: `"[LOOP DETECTED] This issue has been escalated {N} times without resolution."`
3. **Include full guidance history** in `technical_details`: what guidance was applied at each attempt and what happened.
4. **Include cancellation as a suggested option**: one of the options must be `{ option_id: "opt-cancel", label: "Cancel this request", action: "cancel", description: "Stop attempting to resolve this issue" }`.
5. **Emit `re_escalation_loop_detected` audit event** with `{ originalEscalationId, count, guidanceHistory }`.

### gate-approval-templates.ts

```typescript
export type GateTemplateType =
  | "prd_approval"
  | "code_review"
  | "deployment_approval"
  | "security_review";

export function getGateApprovalTemplate(gateType: GateTemplateType): EscalationOption[];
```

#### Template Definitions

**PRD Approval (`prd_approval`)**:
```typescript
[
  { option_id: "opt-1", label: "Approve PRD", action: "approve", description: "Approve the PRD as-is and proceed to implementation" },
  { option_id: "opt-2", label: "Approve with conditions", action: "approve_with_conditions", description: "Approve with specified modifications" },
  { option_id: "opt-3", label: "Reject PRD", action: "reject", description: "Reject the PRD; pipeline will be cancelled" },
]
```

**Code Review (`code_review`)**:
```typescript
[
  { option_id: "opt-1", label: "Approve code", action: "approve", description: "Code passes review; proceed to next phase" },
  { option_id: "opt-2", label: "Request changes", action: "retry_with_changes", description: "Code needs modifications; provide feedback for retry" },
  { option_id: "opt-3", label: "Reject code", action: "reject", description: "Code is fundamentally flawed; cancel the request" },
]
```

**Deployment Approval (`deployment_approval`)**:
```typescript
[
  { option_id: "opt-1", label: "Approve deployment", action: "approve", description: "Proceed with deployment" },
  { option_id: "opt-2", label: "Reject deployment", action: "reject", description: "Do not deploy; cancel the request" },
  { option_id: "opt-3", label: "Defer deployment", action: "cancel", description: "Defer deployment to a later time" },
]
```

**Security Review (`security_review`)**:
```typescript
[
  { option_id: "opt-1", label: "Approve (no findings)", action: "approve", description: "Security review passed; no issues found" },
  { option_id: "opt-2", label: "Remediate and retry", action: "retry_with_changes", description: "Security issues found; provide remediation guidance" },
  { option_id: "opt-3", label: "Reject (critical findings)", action: "reject", description: "Critical security issues; cancel the request" },
]
```

All templates:
- Have at least 2 options (minimum per v1 schema).
- Include at least one resolution option (approve or retry) and one cancel/abort option.
- Are configurable: a `getCustomTemplate(gateType, config)` function allows config overrides to add/remove/modify options. If no custom config, the defaults above are used.

## Acceptance Criteria

1. Re-escalation links new escalation to previous via `previous_escalation_id`.
2. Context includes what guidance was applied and what happened when it failed.
3. Loop detection triggers at exactly 3 re-escalations (not before).
4. Loop-detected escalation routes to secondary target (bypasses primary).
5. Loop-detected summary includes the escalation count.
6. Loop-detected options include a cancellation suggestion.
7. Full guidance history included in technical_details for loop-detected escalation.
8. `re_escalation_loop_detected` audit event emitted with chain details.
9. Templates for all 4 gate types have at least 2 options each.
10. Each template has at least one approve/retry option and one cancel/reject option.
11. Templates are configurable via custom config overrides.
12. Default templates match the definitions above.

## Test Cases

### Re-Escalation Manager

1. **First re-escalation links to previous** -- `handlePostGuidanceFailure` with originalId `esc-001`; new message has `previous_escalation_id: "esc-001"`.
2. **Re-escalation includes failure context** -- New escalation's `failure_reason` describes what happened after guidance was applied.
3. **Count increments correctly** -- After 2 calls, `getReEscalationCount(originalId)` returns `2`.
4. **Loop NOT triggered at count 2** -- Two re-escalations; normal routing used (primary target).
5. **Loop triggered at count 3** -- Third re-escalation triggers loop detection.
6. **Loop routes to secondary** -- Loop-detected escalation dispatched to secondary target, not primary.
7. **Loop summary includes count** -- Summary contains `"escalated 3 times"`.
8. **Loop includes cancel option** -- Options contain `{ action: "cancel" }`.
9. **Loop includes guidance history** -- `technical_details` contains all 3 guidance attempts and their outcomes.
10. **Loop at count 5** -- Fifth re-escalation still triggers loop detection (count >= 3).
11. **Audit: re_escalation_loop_detected** -- Emitted at count 3 with `{ originalEscalationId, count: 3, guidanceHistory }`.
12. **Separate chains tracked independently** -- Re-escalations for different original IDs have independent counts.

### Gate Approval Templates

13. **PRD template has 3 options** -- `getGateApprovalTemplate("prd_approval").length === 3`.
14. **PRD template includes approve** -- At least one option with `action: "approve"`.
15. **PRD template includes reject** -- At least one option with `action: "reject"`.
16. **Code review template** -- Has approve, request_changes, reject.
17. **Deployment template** -- Has approve, reject, defer.
18. **Security review template** -- Has approve, remediate, reject.
19. **All templates have >= 2 options** -- Parameterized test over all 4 gate types.
20. **Custom config overrides defaults** -- Configure custom options; `getCustomTemplate` returns the custom set.
21. **Missing custom config uses defaults** -- No custom config for a gate type; default template returned.
