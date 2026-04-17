# SPEC-009-1-1: Trust Type System and Gate Matrix

## Metadata
- **Parent Plan**: PLAN-009-1
- **Tasks Covered**: Task 1 (Define core type system), Task 2 (Implement Trust Gate Matrix constant)
- **Estimated effort**: 5 hours

## Description

Establish the foundational type system for the trust subsystem and encode the authoritative 4x7 Trust Gate Matrix as a readonly data structure. The type system defines the vocabulary shared across all trust-related subsystems (TrustLevel, PipelineGate, GateAuthority, TrustConfig, etc.), while the gate matrix encodes the exact authority mapping from TDD Section 3.1.4 that determines whether each gate at each trust level requires human or system approval.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/trust/types.ts` | Create | All trust subsystem types and interfaces |
| `src/trust/gate-matrix.ts` | Create | Gate matrix constant and lookup function |

## Implementation Details

### types.ts

```typescript
// Trust levels: 0 = no trust (all human), 3 = full trust (all system except security)
export type TrustLevel = 0 | 1 | 2 | 3;

// The 7 pipeline gates that can require approval
export type PipelineGate =
  | "prd_approval"
  | "code_review"
  | "test_review"
  | "deployment_approval"
  | "security_review"
  | "cost_approval"
  | "quality_gate";

export type GateAuthority = "human" | "system";

export interface TrustLevelChangeRequest {
  requestId: string;
  fromLevel: TrustLevel;
  toLevel: TrustLevel;
  requestedBy: string;
  requestedAt: Date;
  reason: string;
  status: "pending" | "applied" | "rejected";
}

// Phase 3 forward-compatible interface -- no scoring logic implemented yet
export interface TrustScore {
  repositoryId: string;
  currentLevel: TrustLevel;
  score: number;           // 0.0 - 1.0, used in Phase 3 for promotion/demotion
  lastUpdated: Date;
  factors: TrustScoreFactor[];
}

export interface TrustScoreFactor {
  name: string;
  weight: number;
  value: number;
}

export interface TrustConfig {
  system_default_level: TrustLevel;
  repositories: Record<string, RepositoryTrustConfig>;
  auto_demotion: AutoDemotionConfig;
  promotion: PromotionConfig;
}

export interface RepositoryTrustConfig {
  default_level: TrustLevel;
}

export interface AutoDemotionConfig {
  enabled: boolean;
  failure_threshold: number;
  window_hours: number;
}

export interface PromotionConfig {
  require_human_approval: true; // Immutable -- always true
  min_successful_runs: number;
  cooldown_hours: number;
}

export interface GateCheckResult {
  gate: PipelineGate;
  authority: GateAuthority;
  effectiveLevel: TrustLevel;
  pendingChangeApplied: boolean;
  securityOverrideRejected: boolean;
}
```

### gate-matrix.ts

The `TRUST_GATE_MATRIX` constant is a `Record<TrustLevel, Record<PipelineGate, GateAuthority>>` encoding all 28 cells (4 levels x 7 gates).

Exact matrix values:

| Gate | L0 | L1 | L2 | L3 |
|------|----|----|----|-----|
| prd_approval | human | human | system | system |
| code_review | human | human | human | system |
| test_review | human | system | system | system |
| deployment_approval | human | human | human | system |
| security_review | human | human | human | human |
| cost_approval | human | human | system | system |
| quality_gate | human | system | system | system |

The `lookupGateAuthority` function:
1. Accepts `(level: TrustLevel, gate: PipelineGate)`.
2. Returns `TRUST_GATE_MATRIX[level][gate]`.
3. Before returning, if `gate === "security_review"`, always returns `"human"` regardless of what the matrix says (defense-in-depth; the matrix already says `"human"` for all levels, but the function enforces this programmatically as a second layer).

## Acceptance Criteria

1. All types are exported from `src/trust/types.ts` with no runtime code (pure type declarations and interfaces).
2. `TrustLevel` is a union of literal numbers `0 | 1 | 2 | 3` -- not `number`.
3. `PipelineGate` is a union of exactly 7 string literals matching the gate names above.
4. `PromotionConfig.require_human_approval` is typed as the literal `true`, not `boolean`.
5. `TRUST_GATE_MATRIX` is declared `as const` (deeply readonly).
6. `lookupGateAuthority` returns the correct `GateAuthority` for all 28 combinations.
7. `lookupGateAuthority` returns `"human"` for `security_review` at every trust level, enforced programmatically independent of the matrix constant.
8. Attempting to assign a value other than `"human"` to any `security_review` cell in the matrix is a TypeScript compilation error (enforced by type narrowing or `as const`).

## Test Cases

1. **All 28 matrix cells match the table above** -- Parameterized test iterating over every `(level, gate)` pair, asserting the expected authority.
2. **security_review returns "human" at L0** -- `lookupGateAuthority(0, "security_review")` === `"human"`.
3. **security_review returns "human" at L1** -- `lookupGateAuthority(1, "security_review")` === `"human"`.
4. **security_review returns "human" at L2** -- `lookupGateAuthority(2, "security_review")` === `"human"`.
5. **security_review returns "human" at L3** -- `lookupGateAuthority(3, "security_review")` === `"human"`.
6. **L0 requires human for all gates** -- For every gate, `lookupGateAuthority(0, gate)` === `"human"`.
7. **L3 requires system for all gates except security_review** -- For every gate except `security_review`, `lookupGateAuthority(3, gate)` === `"system"`.
8. **L1 mixed authorities** -- `prd_approval` and `code_review` and `deployment_approval` are `"human"`; `test_review` and `quality_gate` are `"system"`.
9. **Type exhaustiveness** -- TypeScript compiler error if a new gate is added to `PipelineGate` but not to the matrix (verified by CI; manual assertion in test that `Object.keys(TRUST_GATE_MATRIX[0]).length === 7`).
