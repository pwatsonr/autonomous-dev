# SPEC-009-3-4: Human Response Handler Facade and Tests

## Metadata
- **Parent Plan**: PLAN-009-3
- **Tasks Covered**: Task 8 (HumanResponseHandler facade), Task 9 (Unit tests), Task 10 (Integration tests)
- **Estimated effort**: 20 hours

## Description

Implement the HumanResponseHandler facade that orchestrates parsing, validation, action resolution, and pipeline resumption into a single `handleResponse()` entry point. Deliver the complete unit and integration test suites covering all parsing paths, validation edge cases, action resolution, re-escalation with loop detection, and the full escalation-response-resume lifecycle.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/escalation/human-response-handler.ts` | Create | Main facade class |
| `src/escalation/__tests__/response-parser.test.ts` | Create | Parser unit tests |
| `src/escalation/__tests__/response-validator.test.ts` | Create | Validator unit tests |
| `src/escalation/__tests__/action-resolver.test.ts` | Create | Action resolver unit tests |
| `src/escalation/__tests__/re-escalation-manager.test.ts` | Create | Re-escalation unit tests |
| `src/escalation/__tests__/human-response-handler.test.ts` | Create | Facade unit tests |
| `src/escalation/__tests__/response-handler.integration.test.ts` | Create | Integration tests |

## Implementation Details

### human-response-handler.ts

```typescript
export class HumanResponseHandler {
  constructor(
    private parser: ResponseParser,
    private validator: ResponseValidator,
    private actionResolver: ActionResolver,
    private resumption: PipelineResumptionCoordinator,
    private reEscalation: ReEscalationManager,
    private auditTrail: AuditTrail,
  ) {}

  handleResponse(rawInput: string, escalationId: string, responder: string): HandleResult;
}

export type HandleResult =
  | { success: true; action: ResolvedAction; resumeResult: ResumeResult }
  | { success: false; error: ResponseValidationError };
```

#### handleResponse algorithm

```
function handleResponse(rawInput, escalationId, responder):
  1. parseResult = parser.parse(rawInput, escalationId, responder)
  2. if (!parseResult.success) return { success: false, error: parseResult.error }

  3. validationResult = validator.validate(parseResult.response)
  4. if (!validationResult.valid) return { success: false, error: validationResult.error }

  5. escalation = escalationStore.getEscalation(escalationId)
  6. action = actionResolver.resolve(validationResult.response, escalation)

  7. auditTrail.append({
       type: "escalation_response_received",
       escalationId, responder, responseType, action
     })

  8. resumeResult = resumption.resume(escalation, action, responder)

  9. if (!resumeResult.success):
       // Pipeline didn't resume; escalation remains active
       // Human can retry their response
       return { success: false, error: { code: "RESUME_FAILED", message: resumeResult.error } }

  10. return { success: true, action, resumeResult }
```

Errors at any step produce clear, actionable feedback:
- Parse failures: indicate what format was expected.
- Validation failures: include available options or known targets.
- Resumption failures: include the error message and suggest retrying.

### Error Feedback Messages

| Error Code | Human-Facing Message |
|-----------|---------------------|
| `ESCALATION_NOT_FOUND` | `"Escalation {id} not found. It may have been resolved or expired."` |
| `ESCALATION_ALREADY_RESOLVED` | `"Escalation {id} has already been resolved."` |
| `INVALID_OPTION_ID` | `"Option {id} is not valid. Available options: {list}"` |
| `UNKNOWN_DELEGATE_TARGET` | `"Target {target} is not recognized. Known targets: {list}"` |
| `REQUEST_CANCELLED` | `"Request has been cancelled. No action can be taken."` |
| `RESUME_FAILED` | `"Failed to resume pipeline: {error}. Please try again."` |

## Acceptance Criteria

1. `handleResponse` orchestrates the full parse -> validate -> resolve -> resume flow.
2. Parse failures return structured error with `success: false`.
3. Validation failures return structured error with actionable feedback.
4. Successful responses return the resolved action and resume result.
5. Resumption failures leave the escalation active for retry.
6. Audit event `escalation_response_received` emitted before resumption attempt.
7. All error messages are human-readable and actionable.
8. All unit tests pass with 100% branch coverage.
9. All integration tests pass.
10. All dependencies injectable via constructor.

## Test Cases

### Unit: human-response-handler.test.ts

1. **Happy path: option approve** -- `handleResponse("opt-1", escId, "user")` with approve option; returns `{ success: true, action: { action: "approve" } }`.
2. **Happy path: freetext** -- `handleResponse("Use v2 API", escId, "user")`; returns retry_with_changes.
3. **Happy path: delegate** -- `handleResponse("delegate:tech-lead", escId, "user")`; returns delegate action.
4. **Parse failure: empty string** -- Returns validation error for empty freetext.
5. **Validation failure: unknown escalation** -- Returns `ESCALATION_NOT_FOUND` error.
6. **Validation failure: invalid option** -- Returns `INVALID_OPTION_ID` with available options.
7. **Validation failure: cancelled request** -- Returns `REQUEST_CANCELLED`.
8. **Resumption failure** -- Mock pipeline executor throws; returns `RESUME_FAILED` error; escalation remains active.
9. **Audit event emitted** -- Verify `escalation_response_received` emitted with correct fields.
10. **Override logs human_override** -- `handleResponse("opt-override", ...)` triggers `human_override` audit event via resumption.

### Integration: response-handler.integration.test.ts

11. **Full lifecycle: Escalation -> human responds -> pipeline resumes** --
    a. Raise an escalation (via EscalationEngine) for a quality failure.
    b. Verify escalation is pending with options.
    c. Call `handleResponse("opt-1", escalationId, "pm-lead")` to approve.
    d. Verify pipeline resumed (mock executor's `markGatePassed` and `resumePipeline` called).
    e. Verify escalation status changed to `"resolved"`.
    f. Verify audit trail contains: `escalation_raised`, `escalation_response_received`, `escalation_resolved`.

12. **Full lifecycle: Re-escalation when guidance fails** --
    a. Raise an escalation for a technical failure.
    b. Respond with freetext guidance: `"Try batch size 10"`.
    c. Pipeline resumes; phase re-executes but fails again.
    d. `reEscalation.handlePostGuidanceFailure()` raises a linked re-escalation.
    e. Verify new escalation has `previous_escalation_id` set.
    f. Verify re-escalation context includes the original guidance and new failure reason.
    g. Respond to re-escalation with `"Cancel request"`.
    h. Verify pipeline terminated.

13. **Full lifecycle: Escalation chain timeout -> secondary target responds** --
    a. Raise an escalation with primary and secondary targets.
    b. Advance mock timer past primary timeout.
    c. Verify secondary target received the escalation (via mock delivery adapter).
    d. Respond as secondary target: `"opt-1"` (approve).
    e. Verify pipeline resumes.
    f. Verify audit trail contains timeout event and resolution.
