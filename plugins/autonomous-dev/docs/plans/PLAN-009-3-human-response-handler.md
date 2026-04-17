# PLAN-009-3: Human Response Handler

## Metadata
- **Parent TDD**: TDD-009-trust-escalation
- **Estimated effort**: 8 days
- **Dependencies**: [PLAN-009-1 (trust engine), PLAN-009-2 (escalation engine)]
- **Blocked by**: [PLAN-009-2 (needs EscalationMessage type, chain manager, and routing state)]
- **Priority**: P0

## Objective

Implement the Human Response Handler that parses, validates, and incorporates human responses to escalations, then resumes pipeline execution from the escalation point. This subsystem closes the escalation loop: PLAN-009-2 raises the question, this plan handles the answer. It supports structured option responses, free-text guidance, delegation to other targets, and re-escalation when human guidance does not resolve the underlying issue.

## Scope

### In Scope

- Response parsing for three response types: `option` (structured selection), `freetext` (guidance), `delegate` (re-route to another target)
- Response validation: option still valid, delegate target known, escalation not already resolved
- Five resolved actions: `approve`, `retry_with_changes`, `cancel`, `override_proceed`, `delegate`
- Pipeline resumption after response incorporation
- Gate resolution flow: human approves or rejects at a trust-gated checkpoint
- Re-escalation mechanism: when the phase fails again after incorporating guidance, raise a linked re-escalation with context about what happened
- Re-escalation loop detection: after 3+ re-escalations for the same issue, escalate to secondary target with meta-context suggesting cancellation
- Human override logging: when a human overrides a system decision, record it as a `human_override` audit event
- Structured response options for common gate approval scenarios (approve, reject, approve with conditions)
- Unit tests for parsing, validation, action mapping, and re-escalation
- Integration tests for full escalation-response-resume cycle

### Out of Scope

- Escalation message creation and routing (covered by PLAN-009-2)
- Notification delivery of the escalation to the human (covered by PLAN-009-5)
- Kill switch / cancel commands (covered by PLAN-009-4)
- Trust level changes triggered by responses (the handler can return a trust change request, but the TrustEngine in PLAN-009-1 processes it)
- Audit trail engine implementation (covered by PLAN-009-5; this plan uses the injected interface)

## Tasks

1. **Define response type system** -- Create TypeScript types for human responses and resolved actions.
   - Files to create: `src/escalation/response-types.ts`
   - Types: `EscalationResponse` (per TDD Section 3.2.4: `escalation_id`, `responder`, `timestamp`, `response_type`, `option_id?`, `freetext?`, `delegate_target?`), `ResolvedAction` (5-member discriminated union: `approve`, `retry_with_changes`, `cancel`, `override_proceed`, `delegate`), `ResponseValidationError`, `ReEscalationContext`
   - Acceptance criteria: All types match TDD Section 3.2.4 contracts; discriminated union covers all 5 action types
   - Estimated effort: 2 hours

2. **Implement Response Parser** -- Parse raw human input into a typed `EscalationResponse`.
   - Files to create: `src/escalation/response-parser.ts`
   - Structured response: input matches an option ID (e.g., "opt-2") -> `response_type: "option"`
   - Delegate response: input matches `delegate:<target>` pattern -> `response_type: "delegate"`
   - Free-text response: any other input -> `response_type: "freetext"`
   - Acceptance criteria: Option IDs parsed correctly; delegate pattern recognized; all other input treated as freetext; parser never throws (returns typed result or validation error)
   - Estimated effort: 3 hours

3. **Implement Response Validator** -- Validate that a parsed response is actionable.
   - Files to create: `src/escalation/response-validator.ts`
   - Validations: (1) escalation exists and is pending (not already resolved or cancelled); (2) if option response, selected option ID exists in the original escalation's options list; (3) if delegate response, target is a known routing target in config; (4) if the request has been cancelled (e.g., via kill switch), response is rejected
   - Error handling per TDD Section 6: "Human response references invalid option -> Return validation error to human with available options. Do not resume pipeline."
   - Acceptance criteria: Valid responses pass; invalid option IDs return error listing available options; unknown delegate targets return error; responses to resolved escalations are rejected; responses to cancelled requests are rejected
   - Estimated effort: 4 hours

4. **Implement Action Resolver** -- Map validated responses to pipeline actions.
   - Files to create: `src/escalation/action-resolver.ts`
   - Mapping per TDD Section 3.2.4 step 4:
     - Option that maps to "approve" -> `{ action: "approve" }`
     - Option that maps to "retry with changes" or freetext -> `{ action: "retry_with_changes", guidance: string }`
     - Option that maps to "cancel" -> `{ action: "cancel" }`
     - Option that explicitly overrides system recommendation -> `{ action: "override_proceed", justification: string }`
     - Delegate response -> `{ action: "delegate", target: string }`
   - Acceptance criteria: All 5 action types correctly resolved from corresponding response types; override is logged distinctly from approve
   - Estimated effort: 4 hours

5. **Implement Pipeline Resumption Coordinator** -- Resume the pipeline from the escalation point based on the resolved action.
   - Files to create: `src/escalation/pipeline-resumption.ts`
   - Per TDD Section 3.2.4 step 5: `approve` -> mark gate as passed, resume; `retry_with_changes` -> inject guidance into phase context, re-execute phase; `cancel` -> terminate request, preserve state; `override_proceed` -> mark gate as overridden (logged as human override), resume; `delegate` -> re-dispatch escalation to new target via PLAN-009-2's chain manager
   - Emits audit events: `escalation_resolved`, `human_override` (for override_proceed)
   - Acceptance criteria: Each action type correctly resumes or terminates the pipeline; state is consistent after resumption; audit events emitted for all actions
   - Estimated effort: 8 hours

6. **Implement Re-Escalation Manager** -- Handle the case where the phase fails again after incorporating human guidance.
   - Files to create: `src/escalation/re-escalation-manager.ts`
   - Per TDD Section 3.2.4 step 6: if phase fails after guidance, increment re-escalation counter, raise new escalation with `previous_escalation_id` set and context about what happened when guidance was applied
   - Loop detection per TDD Section 6: after 3+ re-escalations for the same issue, escalate to secondary target with meta-context: "This issue has been escalated {N} times without resolution." Include cancellation as a suggested option.
   - Acceptance criteria: Re-escalation links to previous escalation; context includes what was tried; loop detection triggers after 3 re-escalations; secondary target receives meta-context
   - Estimated effort: 6 hours

7. **Implement Gate Approval Response Templates** -- Predefined structured response options for common gate approval scenarios.
   - Files to create: `src/escalation/gate-approval-templates.ts`
   - Templates for human-gated gates (from TDD Section 5): PRD approval (approve / reject / approve with conditions), code review (approve / request changes / reject), deployment approval (approve / reject / defer), security review (approve / remediate and retry / reject)
   - Each template provides a set of `EscalationOption` objects that the formatter uses when constructing gate approval escalations
   - Acceptance criteria: Templates cover all human-gated gates; each template has at least 2 options (one resolution, one cancel/abort per v1 schema); templates are configurable
   - Estimated effort: 3 hours

8. **Implement HumanResponseHandler class (main facade)** -- Orchestrates parsing, validation, action resolution, and pipeline resumption.
   - Files to create: `src/escalation/human-response-handler.ts`
   - Public API: `handleResponse(rawInput, escalationId): HandleResult`
   - Full flow: parse -> validate -> resolve action -> record audit -> incorporate into pipeline -> resume -> monitor outcome
   - Acceptance criteria: Full response handling flow works for all 3 response types and all 5 action types; errors at any step produce clear feedback; audit trail records the full lifecycle
   - Estimated effort: 6 hours

9. **Unit tests for Response Handler** -- Cover all parsing, validation, and action resolution paths.
   - Files to create: `src/escalation/__tests__/response-parser.test.ts`, `src/escalation/__tests__/response-validator.test.ts`, `src/escalation/__tests__/action-resolver.test.ts`, `src/escalation/__tests__/re-escalation-manager.test.ts`, `src/escalation/__tests__/human-response-handler.test.ts`
   - Test focus: option parsing with valid/invalid IDs; freetext parsing; delegate parsing with valid/invalid targets; validation of stale escalations; all 5 action types; re-escalation with linked context; loop detection at threshold
   - Acceptance criteria: 100% branch coverage; all edge cases from TDD Section 6 covered
   - Estimated effort: 8 hours

10. **Integration tests: Escalation-Response-Resume cycle** -- End-to-end lifecycle tests.
    - Files to create: `src/escalation/__tests__/response-handler.integration.test.ts`
    - Scenarios from TDD Section 8.2: "Escalation -> human responds -> pipeline resumes"; "Re-escalation when human guidance fails"; "Escalation chain timeout -> secondary target" (response arrives at secondary)
    - Acceptance criteria: All scenarios pass; pipeline state is consistent after each scenario; audit trail contains complete lifecycle events
    - Estimated effort: 6 hours

## Dependencies & Integration Points

- **PLAN-009-1 (Trust Engine)**: The handler may trigger trust level changes (e.g., human requests downgrade during response). It calls `trustEngine.requestTrustChange()` when applicable.
- **PLAN-009-2 (Escalation Engine)**: The handler consumes `EscalationMessage` objects produced by the escalation engine. For delegation and re-escalation, it calls back into the escalation engine's chain manager to re-dispatch.
- **PLAN-009-4 (Kill Switch)**: The kill switch can cancel a request while an escalation is pending. The validator must check for this state. The kill switch also cancels pending escalation timers.
- **PLAN-009-5 (Audit & Notifications)**: The handler emits audit events (`escalation_resolved`, `human_override`) and triggers notifications (e.g., re-escalation notification). Uses injected interfaces.
- **Pipeline Orchestrator**: The handler resumes the pipeline after incorporating the response. It needs a `PipelineExecutor` interface to signal resume, inject guidance, or terminate.

## Testing Strategy

- **Unit tests**: Each component tested in isolation. Mock the pipeline executor, escalation engine, audit trail, and notification interfaces.
- **Integration tests**: Wire real response handler components with mock pipeline executor. Simulate full escalation -> response -> resume cycles.
- **Error path testing**: Verify behavior for every error scenario in TDD Section 6 (invalid option, unknown delegate target, stale escalation, response to cancelled request).
- **Re-escalation testing**: Verify linked escalation context is correct and loop detection triggers at the right threshold.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Free-text responses are ambiguous and hard to incorporate into pipeline context | Medium | Medium | Free-text is attached as-is to the phase context. The pipeline agent interprets it. If the agent cannot use the guidance, the re-escalation mechanism provides feedback. |
| Re-escalation loops could annoy humans | Medium | Medium | Loop detection after 3 re-escalations explicitly suggests cancellation. The secondary target gets escalated with full history. |
| Race condition: human responds just as timeout fires | Low | High | Response processing acquires a lock on the escalation state. If the timeout already fired and chained to secondary, the late response is logged but not applied (escalation already re-routed). |
| Pipeline state corruption if resumption fails mid-way | Low | High | Resumption is transactional: either the pipeline resumes fully or it remains paused. Partial resumption is not possible by design. |

## Definition of Done

- [ ] All source files created and passing TypeScript compilation with strict mode
- [ ] Response parser correctly handles all 3 response types (option, freetext, delegate)
- [ ] Response validator rejects invalid options, unknown delegates, stale escalations, and cancelled requests
- [ ] All 5 resolved actions (approve, retry_with_changes, cancel, override_proceed, delegate) correctly resume or terminate the pipeline
- [ ] Human override actions are logged as `human_override` audit events
- [ ] Re-escalation links to previous escalation with context about what happened
- [ ] Loop detection triggers after 3 re-escalations with meta-context and cancellation suggestion
- [ ] Gate approval templates cover all human-gated gates with at least 2 options each
- [ ] All unit tests pass with 100% branch coverage
- [ ] All 3 integration test scenarios pass
- [ ] Dependencies are injected for testability
