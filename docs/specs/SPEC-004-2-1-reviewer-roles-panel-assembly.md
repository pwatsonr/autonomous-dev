# SPEC-004-2-1: Reviewer Roles, Panel Assembly & Rotation

## Metadata
- **Parent Plan**: PLAN-004-2
- **Tasks Covered**: Task 1, Task 2, Task 3
- **Estimated effort**: 10 hours

## Description

Define all 8 reviewer role configurations with their identities, specializations, and prompt fragments. Build the PanelAssemblyService that composes review panels based on document type and configuration. Implement reviewer rotation logic across iterations with three configurable rotation policies.

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/review-gate/reviewer-roles.ts` | Create | 8 reviewer role configuration objects |
| `src/review-gate/panel-assembly-service.ts` | Create | Panel composition and rotation logic |

## Implementation Details

### 1. Reviewer Role Configurations (`reviewer-roles.ts`)

**Type definition:**
```typescript
interface ReviewerRole {
  role_id: string;
  role_name: string;
  document_types: DocumentType[];
  designation: Map<DocumentType, "primary" | "specialist">;
  specialization_description: string;
  prompt_identity: string;  // the "You are a..." paragraph
}
```

**8 roles defined (from TDD section 3.1.2):**

| role_id | role_name | Primary For | Specialist For | prompt_identity |
|---------|-----------|-------------|----------------|-----------------|
| `product-analyst` | Product Analyst | PRD | -- | "You are a senior product analyst with deep experience in requirements engineering. You evaluate product requirement documents for clarity, completeness, measurability, and internal consistency. You are rigorous about testable acceptance criteria and have zero tolerance for vague requirements." |
| `domain-expert` | Domain Expert | -- | PRD | "You are a domain expert who evaluates product requirements from the perspective of real-world usage. You assess whether user stories are realistic, whether domain constraints are respected, and whether the problem framing captures the full scope of user needs." |
| `architect-reviewer` | Architect Reviewer | TDD | -- | "You are a senior software architect who evaluates technical design documents for architectural soundness, appropriate trade-off analysis, data model integrity, API contract completeness, and integration robustness. You look for scalability gaps, failure mode blindspots, and architectural decisions that contradict their stated requirements." |
| `security-reviewer` | Security Reviewer | -- | TDD | "You are a security architect who evaluates technical designs for threat coverage, authentication/authorization completeness, data protection measures, and secure integration patterns. You identify attack surfaces that the design fails to address and flag security assumptions that are not explicitly validated." |
| `delivery-reviewer` | Delivery Reviewer | Plan | -- | "You are a senior engineering manager who evaluates implementation plans for realistic work decomposition, accurate dependency identification, reasonable effort estimates, comprehensive test strategies, and alignment with the parent technical design. You flag tasks that are too large, dependencies that are missing, and estimates that seem unrealistic." |
| `implementation-reviewer` | Implementation Reviewer | Spec | -- | "You are a senior engineer who evaluates implementation specifications for precise acceptance criteria, accurate file paths, comprehensive test cases, clear code patterns, and alignment with the parent plan. You ensure every criterion is unambiguous enough that any engineer could implement it without further clarification." |
| `code-quality-reviewer` | Code Quality Reviewer | Code | -- | "You are a senior code reviewer who evaluates implementations for spec compliance, test coverage, code quality, documentation completeness, performance characteristics, and maintainability. You look for missed acceptance criteria, insufficient test coverage, code smells, missing error handling, and documentation gaps." |
| `security-code-reviewer` | Security Code Reviewer | -- | Code | "You are a security engineer who reviews code for injection vulnerabilities, authentication bypass risks, authorization gaps, data leakage, insecure defaults, and input validation failures. You evaluate whether security requirements from the spec are correctly implemented." |

**Exported constants:**
```typescript
export const REVIEWER_ROLES: Record<string, ReviewerRole> = { ... };
export const PRIMARY_ROLE_BY_DOC_TYPE: Record<DocumentType, string> = {
  PRD: "product-analyst",
  TDD: "architect-reviewer",
  Plan: "delivery-reviewer",
  Spec: "implementation-reviewer",
  Code: "code-quality-reviewer",
};
export const SPECIALIST_ROLES_BY_DOC_TYPE: Record<DocumentType, string[]> = {
  PRD: ["domain-expert"],
  TDD: ["security-reviewer"],
  Plan: [],
  Spec: [],
  Code: ["security-code-reviewer"],
};
```

### 2. PanelAssemblyService (`panel-assembly-service.ts`)

**Type definitions:**
```typescript
interface ReviewerAssignment {
  reviewer_id: string;       // unique per invocation, e.g. "product-analyst-seed-42"
  role_id: string;           // from REVIEWER_ROLES
  role_name: string;
  agent_seed: number;        // distinct seed for perspective variation
  specialization: "primary" | "specialist";
  prompt_identity: string;
}

interface PanelConfiguration {
  panel_sizes: Record<DocumentType, number>;
  rotation_policy: Record<DocumentType, RotationPolicy>;
}

type RotationPolicy = "rotate_none" | "rotate_specialist" | "rotate_all";

const DEFAULT_PANEL_SIZES: Record<DocumentType, number> = {
  PRD: 2,
  TDD: 2,
  Plan: 1,
  Spec: 1,
  Code: 2,
};

const DEFAULT_ROTATION_POLICY: RotationPolicy = "rotate_specialist";
```

**Class: `PanelAssemblyService`**

**Constructor:**
```typescript
constructor(private config: Partial<PanelConfiguration> = {})
```

**Primary method:**
```typescript
assemblePanel(
  documentType: DocumentType,
  authorId: string,
  iterationNumber: number,
  previousPanel?: ReviewerAssignment[]
): ReviewerAssignment[]
```

**Panel assembly algorithm:**

1. Read `panel_size` from config (or defaults).
2. **Slot 1 (always)**: Create a `ReviewerAssignment` for the primary reviewer role for this document type. Generate a deterministic `agent_seed` based on `documentType + "primary" + iterationNumber` (for reproducibility in tests, but varies by iteration for rotation).
3. **Slots 2..N**: If `panel_size > 1`:
   - Look up specialist roles for this document type.
   - If specialists are available, add them in priority order (first specialist gets slot 2, etc.).
   - If no specialist is defined (e.g., Plan), add a second instance of the primary role with a different `agent_seed`.
4. **Author exclusion**: If any assigned `role_id` matches the `authorId`, replace that assignment with the next available role or a different seed of the same role.
5. Assign each reviewer a unique `reviewer_id` = `"{role_id}-{agent_seed}"`.

**Rotation logic (applied when `iterationNumber > 1`):**

```
rotate_none:
    Return the same panel as iteration 1. Reuse previous agent_seeds.

rotate_specialist (default):
    Primary reviewer: same role, same agent_seed as iteration 1.
    Specialist slots: generate new agent_seed = previous_seed + iterationNumber * 1000.
    If no previous panel is provided, assemble fresh.

rotate_all:
    All slots get new agent_seeds = hash(role_id + iterationNumber).
    All panel members are effectively fresh instances.
```

**Seed generation formula:**
```typescript
function generateSeed(roleId: string, iterationNumber: number, slot: number): number {
  // Simple deterministic hash for reproducibility
  let hash = 0;
  const input = `${roleId}-${iterationNumber}-${slot}`;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash) + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}
```

## Acceptance Criteria

1. All 8 reviewer roles are defined with `role_id`, `role_name`, `document_types`, `designation`, `specialization_description`, and `prompt_identity`.
2. Each role's `prompt_identity` is a substantive paragraph (minimum 40 words) that establishes the reviewer's expertise and evaluation focus.
3. Primary vs specialist designation is explicit per document type.
4. `PRIMARY_ROLE_BY_DOC_TYPE` correctly maps each document type to its primary reviewer.
5. `SPECIALIST_ROLES_BY_DOC_TYPE` correctly maps PRD to `domain-expert`, TDD to `security-reviewer`, Code to `security-code-reviewer`, Plan and Spec to empty arrays.
6. `assemblePanel("PRD", ...)` returns 2 reviewers: `product-analyst` (primary) + `domain-expert` (specialist).
7. `assemblePanel("TDD", ...)` returns 2 reviewers: `architect-reviewer` (primary) + `security-reviewer` (specialist).
8. `assemblePanel("Plan", ...)` returns 1 reviewer: `delivery-reviewer` (primary).
9. `assemblePanel("Spec", ...)` returns 1 reviewer: `implementation-reviewer` (primary).
10. `assemblePanel("Code", ...)` returns 2 reviewers: `code-quality-reviewer` (primary) + `security-code-reviewer` (specialist).
11. When no specialist is defined and panel_size > 1, a second primary instance with a different seed is added.
12. Author is never assigned as a reviewer for their own document.
13. `rotate_none`: same panel returned on iteration 2 as iteration 1.
14. `rotate_specialist`: primary retained, specialist replaced with fresh seed on iteration 2.
15. `rotate_all`: entire panel has new seeds on iteration 2.
16. Every `ReviewerAssignment` has a unique `reviewer_id`.

## Test Cases

### `tests/review-gate/panel-assembly-service.test.ts`

1. **PRD default panel**: `assemblePanel("PRD", "author-1", 1)` returns 2 assignments. First is `product-analyst` primary, second is `domain-expert` specialist.
2. **TDD default panel**: Returns `architect-reviewer` + `security-reviewer`.
3. **Plan single reviewer**: Returns 1 `delivery-reviewer`.
4. **Spec single reviewer**: Returns 1 `implementation-reviewer`.
5. **Code default panel**: Returns `code-quality-reviewer` + `security-code-reviewer`.
6. **Custom panel size 3 for PRD**: Config overrides PRD to panel_size 3. Returns primary + specialist + second primary with different seed.
7. **Custom panel size 1 for TDD**: Config overrides TDD to panel_size 1. Returns only `architect-reviewer`.
8. **Author exclusion**: `assemblePanel("Plan", "delivery-reviewer", 1)` -- author matches the primary role. The service assigns a replacement (e.g., different seed or fallback role).
9. **Unique reviewer IDs**: All assignments in a panel have distinct `reviewer_id` values.
10. **rotate_none iteration 2**: Call for iteration 1, then iteration 2 with `rotate_none`. Panels are identical (same seeds).
11. **rotate_specialist iteration 2**: Call for iteration 1, then iteration 2 with `rotate_specialist`. Primary has same seed. Specialist has different seed.
12. **rotate_specialist iteration 3**: Third iteration. Primary still same seed. Specialist seed differs from both iteration 1 and 2.
13. **rotate_all iteration 2**: Call for iteration 1, then iteration 2 with `rotate_all`. All seeds differ between iterations.
14. **Rotation with single reviewer (Plan)**: `rotate_specialist` on Plan (panel_size 1). Primary is retained (no specialist to rotate). Panel is identical across iterations.
15. **Seed determinism**: Same inputs produce same seeds across multiple calls.
16. **Panel size 0**: Config overrides to panel_size 0. Throws error (minimum panel size is 1).
