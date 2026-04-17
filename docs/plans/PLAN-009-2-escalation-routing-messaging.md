# PLAN-009-2: Escalation Routing & Messaging

## Metadata
- **Parent TDD**: TDD-009-trust-escalation
- **Estimated effort**: 10 days
- **Dependencies**: [PLAN-009-1 (trust engine types and gate matrix)]
- **Blocked by**: [PLAN-009-1 (needs TrustLevel, PipelineGate, and GateAuthority types)]
- **Priority**: P0

## Objective

Implement the Escalation Engine subsystem responsible for classifying failures into the six escalation types, formatting structured escalation messages conforming to the v1 JSON schema, routing escalations to the correct human target with timeout chains and secondary routing, and applying timeout behaviors when no response is received. This is the system's primary mechanism for requesting human intervention.

## Scope

### In Scope

- Escalation taxonomy classifier: classify pipeline failures into one of 6 types (`product`, `technical`, `infrastructure`, `security`, `cost`, `quality`)
- Escalation message formatter producing v1 JSON schema-compliant structured messages
- Three verbosity modes: `terse`, `standard` (default), `verbose`
- Routing engine with two modes: `default` (all to PM Lead) and `advanced` (per-type primary/secondary targets)
- Escalation chains with configurable timeouts and secondary target dispatch
- Four timeout behaviors: `pause` (default), `retry`, `skip`, `cancel`
- Hardcoded constraints: `security` always halts pipeline; `security` timeout behavior always `pause`
- Re-escalation support with `previous_escalation_id` linking (basic wiring; full re-escalation loop in PLAN-009-3)
- Escalation configuration data model (`escalation:` YAML section)
- Escalation ID generation (`esc-YYYYMMDD-NNN` format)
- Unit tests for classifier, formatter, routing engine, and timeout behaviors

### Out of Scope

- Human response parsing and pipeline resumption (covered by PLAN-009-3)
- Actual notification delivery to Slack/Discord/CLI (covered by PLAN-009-5; this plan uses a `DeliveryAdapter` interface)
- Audit trail event emission implementation (covered by PLAN-009-5; this plan uses an injected `AuditTrail` interface)
- Kill switch integration (covered by PLAN-009-4)
- Trust scoring and auto-demotion (Phase 3)

## Tasks

1. **Define escalation type system** -- Create TypeScript types and interfaces for the escalation subsystem.
   - Files to create: `src/escalation/types.ts`
   - Types: `EscalationType` (6-member union), `EscalationUrgency` ("immediate" | "soon" | "informational"), `EscalationMessage` (full v1 schema), `EscalationOption`, `RoutingTarget`, `RoutingMode`, `TimeoutBehavior`, `EscalationConfig`
   - Include the full v1 JSON schema as a TypeScript type (matching TDD Section 3.2.2)
   - Acceptance criteria: All types exported; `EscalationMessage` type matches every field in the v1 JSON schema; types are reusable by PLAN-009-3
   - Estimated effort: 3 hours

2. **Implement Escalation Classifier** -- Classify pipeline failures into one of the 6 escalation types based on failure context.
   - Files to create: `src/escalation/classifier.ts`
   - Input: failure context (pipeline phase, error type, error details, retry count, cost data)
   - Output: `EscalationType` and default `EscalationUrgency`
   - Classification rules per TDD Section 3.2.1: security findings -> `security`; CI/CD or env failures -> `infrastructure`; cost threshold exceeded -> `cost`; review gate failed after max retries -> `quality`; implementation failure after retry budget -> `technical`; ambiguous requirements -> `product`
   - Edge case: ambiguous failures that could match multiple types. Priority order: `security` > `infrastructure` > `cost` > `quality` > `technical` > `product`
   - Acceptance criteria: Each of the 6 types correctly classified from representative inputs; ambiguous inputs resolve by priority; `security` type always sets urgency to `immediate`
   - Estimated effort: 4 hours

3. **Implement Escalation Message Formatter** -- Construct v1 schema-compliant escalation messages.
   - Files to create: `src/escalation/formatter.ts`
   - Generates: `escalation_id` (format: `esc-YYYYMMDD-NNN` with monotonic counter), all required fields per v1 schema
   - Three verbosity modes per TDD Section 4.2: `terse` (summary + options only), `standard` (all required fields), `verbose` (all fields including `technical_details` and full `artifacts`)
   - Security constraint: never include raw secrets in `summary`, `failure_reason`, or `options` fields; `technical_details` references file path and line number but NOT the secret value
   - External path sanitization: delivery to Slack/Discord strips absolute file system paths, keeping only workspace-relative paths
   - Acceptance criteria: Output validates against v1 JSON schema; all 3 verbosity modes produce valid output; security-type messages do not leak secrets; escalation IDs are unique and monotonic
   - Estimated effort: 8 hours

4. **Implement Routing Engine** -- Determine who receives an escalation based on configuration mode.
   - Files to create: `src/escalation/routing-engine.ts`
   - Two modes per TDD Section 3.2.3: `default` (all to `escalation.routing.default_target`) and `advanced` (per-type primary/secondary/timeout from config)
   - `resolveRouting(escalationType, config): RoutingTarget` function
   - Fallback: if advanced mode has no config for a type, fall back to `default_target`
   - Fallback: if routing target is unknown, fall back to `default_target` and log warning
   - Acceptance criteria: Default mode routes all types to configured default target; advanced mode routes each type to its specific target; missing type config falls back to default; unknown target falls back with warning logged
   - Estimated effort: 4 hours

5. **Implement Escalation Chain Manager** -- Handle timeout-based escalation chains with secondary routing.
   - Files to create: `src/escalation/chain-manager.ts`
   - Implements the chain flow from TDD Section 3.2.3: dispatch to primary -> timeout -> dispatch to secondary -> timeout -> apply timeout behavior
   - Timeout tracking: each dispatched escalation starts a timer. On expiry, chain to secondary (if exists) or apply timeout behavior
   - Four timeout behaviors: `pause` (pipeline stays paused indefinitely), `retry` (re-execute failed phase with different approach), `skip` (proceed past gate -- only for `informational` urgency), `cancel` (terminate request, preserve state)
   - Constraint: `security` timeout behavior is hardcoded to `pause`, cannot be overridden
   - Emits audit events: `escalation_raised`, `escalation_timeout`
   - Acceptance criteria: Primary dispatched first; secondary dispatched after primary timeout; timeout behavior applied after chain exhausted; security always pauses; timers are cancellable (for when response arrives before timeout)
   - Estimated effort: 8 hours

6. **Implement EscalationEngine class (main facade)** -- Orchestrates classifier, formatter, routing, and chain manager.
   - Files to create: `src/escalation/escalation-engine.ts`
   - Public API: `raise(failureContext): EscalationMessage` -- classifies, formats, routes, and starts the chain
   - Pipeline behavior enforcement per TDD Section 3.2.1: `security` -> halt immediately; `infrastructure` -> pause immediately; `cost` -> pause before incurring; `product`/`technical`/`quality` -> pause at gate/phase boundary
   - Re-escalation: accepts `previous_escalation_id` for linked re-escalations
   - Acceptance criteria: Full raise flow produces schema-valid message, dispatches to correct target, starts chain timer, and emits audit events; pipeline behavior matches the type
   - Estimated effort: 6 hours

7. **Implement Escalation Configuration loader** -- Parse and validate the `escalation:` section of plugin config YAML.
   - Files to create/modify: `src/escalation/escalation-config.ts`
   - Schema validation for all fields in TDD Section 4.2: routing mode, default target, advanced per-type routing, timeout behaviors, retry limits, verbosity
   - Immutability enforcement: `security` timeout behavior cannot be set to anything other than `pause`
   - Invalid config falls back to hardcoded defaults per TDD Section 6
   - Acceptance criteria: Valid config loads correctly; invalid config falls back to defaults; security timeout behavior override is rejected
   - Estimated effort: 3 hours

8. **Implement barrel exports and module wiring** -- Create module index.
   - Files to create: `src/escalation/index.ts`
   - Export all public APIs; wire EscalationEngine dependencies via constructor injection
   - Acceptance criteria: Clean imports; all dependencies injectable
   - Estimated effort: 1 hour

9. **Unit tests for Escalation Engine** -- Cover TDD Section 8.1 test focus areas.
   - Files to create: `src/escalation/__tests__/classifier.test.ts`, `src/escalation/__tests__/formatter.test.ts`, `src/escalation/__tests__/routing-engine.test.ts`, `src/escalation/__tests__/chain-manager.test.ts`, `src/escalation/__tests__/escalation-engine.test.ts`
   - Test focus per TDD 8.1: Each of 6 types correctly classified; ambiguous failures resolved by priority; message schema validation for all 3 verbosity modes; artifact attachment; default and advanced routing; fallback routing; all 4 timeout behaviors; security invariants
   - Acceptance criteria: 100% branch coverage; all TDD 8.1 Escalation scenarios covered
   - Estimated effort: 10 hours

10. **Integration test: Escalation lifecycle** -- End-to-end from failure to dispatched message.
    - Files to create: `src/escalation/__tests__/escalation-engine.integration.test.ts`
    - Scenarios: quality escalation after 3 retries (TDD 8.2); escalation chain timeout to secondary target (TDD 8.2); security escalation halts immediately
    - Acceptance criteria: All scenarios pass; audit events verified; messages schema-valid
    - Estimated effort: 4 hours

## Dependencies & Integration Points

- **PLAN-009-1 (Trust Engine)**: Uses `TrustLevel`, `PipelineGate` types. The escalation engine is invoked when a system-reviewed gate fails after retry budget is exhausted, or when a gate requires human approval.
- **PLAN-009-3 (Response Handler)**: The response handler resolves escalations that this plan raises. This plan provides the `EscalationMessage` and chain state; PLAN-009-3 consumes them.
- **PLAN-009-4 (Kill Switch)**: The kill switch can cancel pending escalations. This plan exposes a `cancelPending(requestId)` method for the kill switch to call.
- **PLAN-009-5 (Audit & Notifications)**: The escalation engine emits audit events and notification payloads. This plan uses injected interfaces for both; concrete implementations are in PLAN-009-5.
- **Delivery Adapters**: The escalation engine produces structured payloads but does not deliver them. It calls `deliveryAdapter.deliver(payload)` via the injected interface.

## Testing Strategy

- **Unit tests**: Each component (classifier, formatter, routing engine, chain manager) tested in isolation with mock dependencies. Schema validation of formatter output against the v1 JSON schema definition.
- **Integration tests**: Wire real components together with mock delivery adapter and audit trail. Run escalation lifecycle scenarios.
- **Contract testing**: Validate that every `EscalationMessage` produced by the formatter can be round-tripped through JSON serialization and deserialization without data loss.
- **Security testing**: Verify that security-type escalation messages never contain raw secrets in human-facing fields.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Escalation message schema may need to evolve before Phase 2 | Medium | Medium | Schema is versioned (`v1`). New fields can be added as optional without breaking consumers. Breaking changes increment the version. |
| Timer-based chain management is complex to test | Medium | Medium | Use a mock clock/timer in tests. Chain manager accepts a `Timer` interface that can be replaced with a deterministic test timer. |
| Ambiguous failure classification may produce incorrect escalation types | Medium | Low | Priority ordering provides deterministic resolution. Misclassification is logged and can be corrected by human response (PLAN-009-3). |
| Escalation ID counter rollover or collision across restarts | Low | Medium | Counter is persisted to state file. On restart, counter resumes from last persisted value. Format supports 3+ digit sequence numbers. |

## Definition of Done

- [ ] All source files created and passing TypeScript compilation with strict mode
- [ ] Classifier correctly identifies all 6 escalation types with priority-based ambiguity resolution
- [ ] Formatter produces v1 JSON schema-compliant messages in all 3 verbosity modes
- [ ] Escalation messages for security type never contain raw secrets in human-facing fields
- [ ] Routing engine handles both `default` and `advanced` modes with fallback
- [ ] Escalation chains dispatch to primary, then secondary on timeout, then apply timeout behavior
- [ ] `security` timeout behavior is hardcoded to `pause` and cannot be overridden
- [ ] Escalation IDs are unique and follow the `esc-YYYYMMDD-NNN` format
- [ ] All unit tests pass with 100% branch coverage
- [ ] All integration test scenarios pass
- [ ] Dependencies are injected (AuditTrail, DeliveryAdapter, Timer) for testability
