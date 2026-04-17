# PLAN-009-1: Trust Ladder Engine

## Metadata
- **Parent TDD**: TDD-009-trust-escalation
- **Estimated effort**: 8 days
- **Dependencies**: Plugin config loader (existing)
- **Blocked by**: None (this is the foundation plan)
- **Priority**: P0

## Objective

Implement the Trust Engine subsystem that resolves, stores, and enforces trust levels (L0--L3) at pipeline gates. This is the governance backbone: every other subsystem depends on the trust engine to determine whether a gate requires human approval or system-agent review. The engine must enforce the Trust Gate Matrix, support mid-pipeline trust level changes applied at gate boundaries, and provide the data model for Phase 3 trust scoring and promotion.

## Scope

### In Scope

- Trust level resolution hierarchy (per-request override > per-repo default > system global default)
- `TRUST_GATE_MATRIX` constant encoding the full L0--L3 gate authority map (7 gates x 4 levels)
- Gate check function that resolves trust level, looks up authority, and returns `"human"` or `"system"`
- Hardcoded `security_review = "human"` invariant with override rejection and audit logging
- Trust level change request mechanism with pending-change state machine
- Gate-boundary application of pending changes (downgrade always allowed; upgrade requires confirmation in Phase 1)
- Trust configuration data model (`trust.yaml` schema: `system_default_level`, `repositories.<repo>.default_level`, `auto_demotion`, `promotion`)
- Hot-reload support for trust configuration changes
- Phase 3 forward-compatible data model for `TrustScore` (interface only, no scoring logic)
- Unit tests for all resolution paths, gate matrix enforcement, mid-pipeline changes, and security invariant

### Out of Scope

- Trust scoring computation and promotion/demotion logic (Phase 3, will be added as a follow-up)
- Escalation routing when a gate requires human approval (covered by PLAN-009-2)
- Human response handling when a gate pauses (covered by PLAN-009-3)
- Audit trail event emission (covered by PLAN-009-5; this plan uses an injected `AuditTrail` interface)
- Notification delivery (covered by PLAN-009-5)

## Tasks

1. **Define core type system** -- Create TypeScript types and interfaces for the trust subsystem.
   - Files to create: `src/trust/types.ts`
   - Types: `TrustLevel` (0 | 1 | 2 | 3), `PipelineGate` (union of 7 gate names), `GateAuthority` ("human" | "system"), `TrustLevelChangeRequest`, `TrustScore` (Phase 3 forward-compatible interface), `TrustConfig` (YAML schema type)
   - Acceptance criteria: All types exported; no runtime code; fully documents the TDD Section 3.1 contracts
   - Estimated effort: 3 hours

2. **Implement Trust Gate Matrix constant** -- Encode the authoritative 4x7 gate matrix as a readonly data structure.
   - Files to create: `src/trust/gate-matrix.ts`
   - The matrix must match TDD Section 3.1.4 exactly. `security_review` must be `"human"` at all levels.
   - Include a `lookupGateAuthority(level: TrustLevel, gate: PipelineGate): GateAuthority` function.
   - Acceptance criteria: Matrix matches TDD table; lookup function returns correct authority for all 28 combinations; attempting to override `security_review` via any path is rejected
   - Estimated effort: 2 hours

3. **Implement Trust Level Resolver** -- Three-tier resolution: per-request > per-repo > system default.
   - Files to create: `src/trust/trust-resolver.ts`
   - Implements the `resolve(request, repo, systemConfig)` algorithm from TDD Section 3.1.2
   - Must handle: missing per-request override, missing per-repo default, missing system default (falls back to L1)
   - Acceptance criteria: Resolver returns correct level for all 3 tiers; defaults to L1 when no config present; resolution is per-gate-check (not cached across gates)
   - Estimated effort: 3 hours

4. **Implement Trust Level Change State Machine** -- Support mid-pipeline trust level changes applied at gate boundaries.
   - Files to create: `src/trust/trust-change-manager.ts`
   - Implements `requestChange()` and `resolveAtGateBoundary()` per TDD Section 3.1.3
   - State machine: CURRENT_LEVEL --[change requested]--> CHANGE_PENDING --[gate boundary]--> NEW_LEVEL
   - Rules: downgrade always allowed; upgrade requires confirmation step (Phase 1); last-write-wins for concurrent changes; in-flight phases unaffected
   - Emits audit events via injected `AuditTrail` interface: `trust_level_change_requested`, `trust_level_changed`
   - Acceptance criteria: Downgrade applies at next gate; upgrade prompts confirmation; concurrent changes resolved by last-write-wins; both changes logged; in-flight phase not retroactively affected
   - Estimated effort: 6 hours

5. **Implement TrustEngine class (main facade)** -- Orchestrates resolver, gate matrix, and change manager into a single entry point.
   - Files to create: `src/trust/trust-engine.ts`
   - Public API: `checkGate(gate, request): GateCheckResult`, `requestTrustChange(change): void`, `getEffectiveLevel(request): TrustLevel`
   - `checkGate` implements the gate check pseudocode from TDD Section 5: resolve level, apply pending change at boundary, lookup matrix, return authority
   - Enforces security_review invariant: if anyone attempts to set `security_review` to `"system"`, log `security_override_rejected` and return `"human"`
   - Acceptance criteria: Full gate check flow works for L0-L3; security invariant enforced; pending changes applied at boundary; all operations emit appropriate audit events
   - Estimated effort: 6 hours

6. **Implement Trust Configuration loader** -- Parse and validate the `trust:` section of plugin config YAML with hot-reload support.
   - Files to create/modify: `src/trust/trust-config.ts`, integrate with existing plugin config loader
   - Schema validation: `system_default_level` (0-3, default 1), `repositories.<repo>.default_level` (0-3), `auto_demotion` settings, `promotion` settings
   - Invalid values rejected with validation error logged (TDD Section 6: "Trust level set to invalid value")
   - Hot-reload: config changes take effect at next gate boundary (same as trust level changes)
   - Acceptance criteria: Valid config loads correctly; invalid config falls back to hardcoded defaults (L1); hot-reload triggers re-resolution at next gate; `trust.promotion.require_human_approval` cannot be set to false
   - Estimated effort: 4 hours

7. **Implement barrel exports and module wiring** -- Create module index and wire dependencies.
   - Files to create: `src/trust/index.ts`
   - Export all public APIs; wire TrustEngine with its dependencies via constructor injection
   - Acceptance criteria: `import { TrustEngine } from './trust'` works; all dependencies are injectable (no hard-coded singletons)
   - Estimated effort: 1 hour

8. **Unit tests for Trust Engine** -- Comprehensive test suite covering TDD Section 8.1 Trust Engine test focus areas.
   - Files to create: `src/trust/__tests__/trust-resolver.test.ts`, `src/trust/__tests__/gate-matrix.test.ts`, `src/trust/__tests__/trust-change-manager.test.ts`, `src/trust/__tests__/trust-engine.test.ts`
   - Test focus (per TDD 8.1): Resolution hierarchy (per-request > per-repo > global); gate matrix enforcement for all 28 combinations; mid-pipeline change at gate boundary; security invariant enforcement; upgrade confirmation in Phase 1; concurrent change last-write-wins; config validation and fallback
   - Acceptance criteria: 100% branch coverage on trust engine code; all TDD Section 8.1 Trust Engine scenarios covered; tests run in <5 seconds
   - Estimated effort: 8 hours

9. **Integration test: L0 and L1 full pipeline gate checks** -- Validate end-to-end gate enforcement for L0 (all human) and L1 (mixed) trust levels.
   - Files to create: `src/trust/__tests__/trust-engine.integration.test.ts`
   - Scenarios from TDD Section 8.2: "Full pipeline at L0: every gate pauses for human", "Full pipeline at L1: PRD and code gates pause, others auto", "Mid-pipeline downgrade from L2 to L0"
   - Uses mock AuditTrail to verify event emission
   - Acceptance criteria: All 3 integration scenarios pass; audit events verified
   - Estimated effort: 4 hours

## Dependencies & Integration Points

- **Config loader**: The trust engine reads from the plugin's YAML configuration. It needs a config provider interface (or uses the existing plugin config system).
- **Audit Trail (interface only)**: The trust engine emits events via an injected `AuditTrail` interface. The concrete implementation is in PLAN-009-5. For this plan, tests use a mock.
- **Pipeline Orchestrator**: The orchestrator calls `trustEngine.checkGate()` at each pipeline gate. This plan defines the contract; the orchestrator integration is separate.
- **PLAN-009-2 (Escalation)**: When `checkGate()` returns `"human"`, the pipeline must pause and raise an escalation. The trust engine signals this; the escalation engine handles it.
- **PLAN-009-3 (Response Handler)**: When a human responds to a gate approval, the response handler marks the gate as resolved. The trust engine provides the gate check; the handler provides the resolution.

## Testing Strategy

- **Unit tests**: Every public method of every class has direct unit tests. Mock the `AuditTrail` interface. Test all edge cases from TDD Section 8.1.
- **Integration tests**: Wire TrustEngine with its real sub-components (resolver, gate matrix, change manager) and a mock audit trail. Run full pipeline gate sequences for L0, L1, and mid-pipeline downgrade.
- **Property-based testing**: For the gate matrix, assert that `security_review` returns `"human"` for ALL trust levels (exhaustive, not sampled).
- **Configuration testing**: Test with valid configs, invalid configs, missing configs, and partial configs to ensure fallback behavior.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Gate matrix hardcoded as constant may need to become configurable in future | Low | Medium | The matrix is behind a lookup function. Replacing the constant with a config-driven lookup is a localized change. |
| Mid-pipeline trust change race conditions | Medium | High | Last-write-wins semantics are explicit. All changes are logged. Integration tests cover concurrent change scenarios. |
| Config hot-reload could introduce inconsistency mid-gate-check | Low | Medium | Trust level is resolved once per gate check (snapshot semantics). Config changes take effect at the next gate boundary, not mid-resolution. |

## Definition of Done

- [ ] All 7 source files created and passing TypeScript compilation with strict mode
- [ ] `TrustEngine.checkGate()` correctly enforces the full 4x7 gate matrix
- [ ] `security_review` returns `"human"` at all trust levels; override attempts are rejected and logged
- [ ] Trust level resolution follows per-request > per-repo > global hierarchy
- [ ] Mid-pipeline trust changes apply at the next gate boundary only
- [ ] Downgrade is always allowed; upgrade requires confirmation in Phase 1
- [ ] Config validation rejects invalid trust levels (outside 0-3)
- [ ] Config hot-reload takes effect at next gate boundary
- [ ] All unit tests pass with 100% branch coverage
- [ ] All 3 integration test scenarios pass
- [ ] AuditTrail interface is injected (not hard-coded) for testability
- [ ] No circular dependencies between trust module and other subsystems
