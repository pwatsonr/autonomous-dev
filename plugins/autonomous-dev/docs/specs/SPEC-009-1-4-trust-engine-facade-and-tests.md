# SPEC-009-1-4: Trust Engine Facade, Module Wiring, and Tests

## Metadata
- **Parent Plan**: PLAN-009-1
- **Tasks Covered**: Task 5 (Implement TrustEngine class), Task 7 (Barrel exports and module wiring), Task 8 (Unit tests), Task 9 (Integration tests)
- **Estimated effort**: 19 hours

## Description

Implement the TrustEngine facade class that orchestrates the resolver, gate matrix, and change manager into a unified entry point. Wire all trust module dependencies via constructor injection with barrel exports. Deliver comprehensive unit tests covering all resolution paths, gate matrix enforcement, security invariants, and mid-pipeline changes, plus integration tests for full pipeline gate check sequences at L0, L1, and mid-pipeline downgrade.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/trust/trust-engine.ts` | Create | Main TrustEngine facade class |
| `src/trust/index.ts` | Create | Barrel exports and module wiring |
| `src/trust/__tests__/trust-resolver.test.ts` | Create | Unit tests for resolver |
| `src/trust/__tests__/gate-matrix.test.ts` | Create | Unit tests for gate matrix |
| `src/trust/__tests__/trust-change-manager.test.ts` | Create | Unit tests for change manager |
| `src/trust/__tests__/trust-engine.test.ts` | Create | Unit tests for engine facade |
| `src/trust/__tests__/trust-engine.integration.test.ts` | Create | Integration tests |

## Implementation Details

### trust-engine.ts

```typescript
export class TrustEngine {
  constructor(
    private resolver: TrustResolver,
    private changeManager: TrustChangeManager,
    private configLoader: TrustConfigLoader,
    private auditTrail: AuditTrail,
  ) {}

  checkGate(gate: PipelineGate, context: TrustResolutionContext): GateCheckResult;
  requestTrustChange(change: TrustLevelChangeRequest): void;
  getEffectiveLevel(context: TrustResolutionContext): TrustLevel;
}
```

#### checkGate algorithm (matches TDD Section 5 pseudocode)

```
function checkGate(gate, context):
  1. config = configLoader.load()
  2. baseLevel = resolver.resolve(context, config)
  3. effectiveLevel = changeManager.resolveAtGateBoundary(context.requestId, baseLevel)
  4. authority = lookupGateAuthority(effectiveLevel, gate)

  // Security invariant enforcement (defense-in-depth)
  5. if gate === "security_review" AND authority !== "human":
       auditTrail.append({ type: "security_override_rejected", ... })
       authority = "human"
       securityOverrideRejected = true

  6. auditTrail.append({ type: "gate_decision", gate, authority, effectiveLevel, ... })
  7. return { gate, authority, effectiveLevel, pendingChangeApplied, securityOverrideRejected }
```

The security invariant at step 5 is defense-in-depth: the matrix already returns `"human"` for `security_review` at all levels, and `lookupGateAuthority` also enforces it. This third layer catches any future bug that might bypass the first two.

### index.ts

```typescript
export { TrustEngine } from './trust-engine';
export { TrustResolver } from './trust-resolver';
export { TrustChangeManager } from './trust-change-manager';
export { TrustConfigLoader } from './trust-config';
export { lookupGateAuthority, TRUST_GATE_MATRIX } from './gate-matrix';
export * from './types';
```

Factory function for convenience:

```typescript
export function createTrustEngine(configProvider: ConfigProvider, auditTrail: AuditTrail): TrustEngine {
  const configLoader = new TrustConfigLoader(configProvider);
  const resolver = new TrustResolver();
  const changeManager = new TrustChangeManager(auditTrail);
  return new TrustEngine(resolver, changeManager, configLoader, auditTrail);
}
```

All dependencies are injectable via constructor -- no hard-coded singletons.

### Test Structure

**Unit tests** use mocked dependencies (mock AuditTrail, mock ConfigProvider).

**Integration tests** wire real sub-components (TrustResolver, TrustChangeManager, gate-matrix) with a mock AuditTrail.

## Acceptance Criteria

1. `TrustEngine.checkGate()` returns the correct authority for all 28 gate/level combinations.
2. Security invariant: `checkGate("security_review", ...)` always returns `{ authority: "human" }` regardless of trust level or config manipulation. If a code path somehow bypasses the matrix, a `security_override_rejected` audit event is emitted.
3. Pending trust changes are applied at gate boundaries within `checkGate`.
4. `requestTrustChange` delegates to the change manager correctly.
5. `getEffectiveLevel` resolves the level without performing a gate check.
6. `import { TrustEngine } from './trust'` works (barrel export).
7. `createTrustEngine` factory wires all dependencies correctly.
8. All dependencies are injectable (AuditTrail, ConfigProvider).
9. No circular dependencies between trust module files.
10. Unit tests achieve 100% branch coverage on all trust engine code.
11. Integration tests pass for L0, L1, and mid-pipeline downgrade scenarios.
12. All tests complete in under 5 seconds.

## Test Cases

### Unit: trust-engine.test.ts

1. **checkGate at L0 returns human for prd_approval** -- Mock resolver returns 0, verify authority is "human".
2. **checkGate at L3 returns system for code_review** -- Mock resolver returns 3, verify authority is "system".
3. **checkGate applies pending trust change** -- Mock change manager returns a different level than resolver, verify the changed level is used.
4. **checkGate emits gate_decision audit event** -- Verify audit trail receives event with correct fields.
5. **security_review override defense-in-depth** -- Force `lookupGateAuthority` to hypothetically return "system" for security_review (via monkey-patching in test only), verify engine catches it, emits `security_override_rejected`, and returns "human".
6. **requestTrustChange delegates to change manager** -- Verify change manager receives the request.
7. **getEffectiveLevel resolves without gate check** -- Returns level without emitting gate_decision event.

### Unit: trust-resolver.test.ts

(See SPEC-009-1-2 test cases)

### Unit: gate-matrix.test.ts

(See SPEC-009-1-1 test cases)

### Unit: trust-change-manager.test.ts

(See SPEC-009-1-3 test cases)

### Integration: trust-engine.integration.test.ts

1. **Full pipeline at L0: every gate pauses for human** -- Create TrustEngine with config set to L0. Call `checkGate` for all 7 gates. All return `{ authority: "human" }`. Verify 7 `gate_decision` audit events emitted.

2. **Full pipeline at L1: PRD and code gates pause, others auto** -- Config set to L1. Call `checkGate` for all 7 gates. Assert: `prd_approval` = human, `code_review` = human, `test_review` = system, `deployment_approval` = human, `security_review` = human, `cost_approval` = human, `quality_gate` = system. Verify audit events.

3. **Mid-pipeline downgrade from L2 to L0** -- Start with L2 config. Check first 2 gates (should use L2 authorities). Request downgrade to L0. Check remaining 5 gates (should use L0 authorities -- all human). Verify the `trust_level_changed` audit event is emitted at the gate boundary where the change takes effect. Verify earlier gates are NOT retroactively affected.
