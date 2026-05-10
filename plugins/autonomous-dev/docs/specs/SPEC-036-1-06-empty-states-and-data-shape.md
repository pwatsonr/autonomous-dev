# SPEC-036-1-06: Empty States + `DashboardData` Shape Extensions

## Metadata
- **Parent Plan**: PLAN-036-1 (Dashboard Surface Re-skin)
- **Parent TDD**: TDD-036, §5.3 (Data Shape Extensions), §6.1 (Dashboard empty states), §8.4 (Empty State Tests)
- **Parent PRD**: PRD-018, R-16, NG-02 (no new data fetched)
- **Tasks Covered**: PLAN-036-1 Task 1 (extend `types/render.ts`), Task 2 (populate stub loaders), Task 3 (`fragments/empty-state.tsx`)
- **Estimated effort**: 0.75 day
- **Dependencies**: PLAN-035-1 (page-shell tokens), no primitive deps for `EmptyState`. Sister specs SPEC-036-1-01..05 consume the types defined here.
- **Priority**: P0 (blocks all sister fragments — type extensions and `EmptyState` are referenced by SPEC-036-1-01, -03, -05).
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Land the type extensions and stub population that SPEC-036-1-01..05 depend on, plus the shared `EmptyState` fragment used across Dashboard regions. This spec is the foundation: every other Dashboard spec imports either a type or the `EmptyState` component from here. All new fields on existing types are optional for backward compatibility (TDD-036 §5.3).

## Acceptance Criteria

### Empty-state fragment

1. **Prop signature**:
   ```ts
   export interface EmptyStateProps {
       noun: string;        // "active requests", "repositories allowlisted", etc.
       hint?: string;       // optional secondary line; muted, smaller
   }
   export const EmptyState: FC<EmptyStateProps>;
   ```
2. **Rendered HTML**: `<p class="muted empty-state">No {noun}</p>`. With `hint`: a second `<p class="muted dim empty-state-hint">{hint}</p>` follows.
3. **Per-region empty-state nouns** (canonical strings — sentence case, no terminal period, no emoji per PRD-018 R-22):
   - 0 repos → `"repositories allowlisted"` (parent view substitutes for the entire `RepoCardGrid`).
   - 0 requests → `"active requests"` (active requests table).
   - 0 gates → entire `ApprovalQueueStrip` is omitted (no `EmptyState` rendered) — see SPEC-036-1-04 #3.
   - 0 blocking hits → `"blocking hits"` (within `StandardsDriftSummary`; section header remains).
4. **No JS errors when all data empty**: integration test feeds `{ repos: [], requests: [], standards: [] }` and asserts the page renders, the KPI strip shows zeros, and the three remaining empty-state messages appear.

### `types/render.ts` extensions (TDD-036 §5.3, all new fields optional)

5. **`RepoSummary`** gains: `trust?: string`, `phase?: string`, `variant?: string`, `backend?: string`, `stack?: string`, `gateCount?: number`. Existing fields (`repo`, `activeRequests`, `lastActivity`, `monthlyCostUsd`, `attentionCount`) unchanged. Add `attn?: boolean` (consumed by SPEC-036-1-03 for the warn-line treatment).
6. **`DashboardData`** gains: `requests?: DashboardRequest[]`, `standards?: StandardRule[]`, `variants?: PipelineVariant[]`, `standardsDrift?: StandardsDriftEntry[]`.
7. **New types**:
   ```ts
   export interface DashboardRequest {
       id: string;
       repo: string;
       title: string;
       phase: string;
       status: "running" | "gate";
       cost: number;
       turns: number;
       score: number;
       variant: string;
       gateType?: string;
       stack?: string;
       /** Pre-resolved variant label for display; eliminates client-side lookup. */
       variantLabel?: string;
       /** Minutes spent waiting at a gate (when status === 'gate'). */
       waitedMin?: number;
   }
   export interface StandardsHit {
       ruleId: string;
       severity: "blocking" | "warn" | "advisory";
       hits: number;
   }
   export interface StandardsDriftEntry {
       repo: string;
       hitCount: number;
       severityMax: "blocking" | "warn" | "advisory";
       hits: StandardsHit[];
   }
   export interface StandardRule {
       id: string;
       severity: "blocking" | "warn" | "advisory";
       desc: string;
       applies: string;
       source: string;
       immutable: boolean;
       hits: number;
   }
   export interface PipelineVariant {
       id: string;
       label: string;
       desc: string;
       phases: string[];
       reviewers?: Record<string, string[]>;
   }
   ```
8. **`variantLabel` is server-resolved**: the route handler (or stub loader) MUST populate `request.variantLabel` from `variants.find(v => v.id === request.variant)?.label` before passing to render. Fragments never look up the variants array. Keeps fragments pure and SSE-fragment-self-sufficient.

### Stub loaders

9. **`stubs/repos.ts`** populates the new optional `RepoSummary` fields on every stub repo (`trust: "L1"`, plus a representative `phase`, `variant`, `backend`, `stack`, `gateCount`). Existing tests using these stubs continue to pass.
10. **`stubs/requests.ts`** populates `variant`, `gateType` (for at least one stub gate), `stack`, `variantLabel` (already resolved per #8), and `waitedMin` (for gate-status stubs).
11. **`stubs/standards.ts`** is added (if absent) and exports a `StandardRule[]` of 3+ representative rules covering all three severities, with at least one `hits > 0` to drive the drift table.
12. **Backward compat**: `bun tsc --noEmit` passes; surfaces that did not previously read these fields are unaffected.

## Implementation

**File**: `plugins/autonomous-dev-portal/server/templates/fragments/empty-state.tsx`

```tsx
import type { FC } from "hono/jsx";

export interface EmptyStateProps {
    noun: string;
    hint?: string;
}

export const EmptyState: FC<EmptyStateProps> = ({ noun, hint }) => (
    <>
        <p class="muted empty-state">No {noun}</p>
        {hint && <p class="muted dim empty-state-hint">{hint}</p>}
    </>
);
```

**File**: `plugins/autonomous-dev-portal/server/types/render.ts` — add the seven types and field extensions per §5.3 verbatim. All new fields optional.

**File**: `plugins/autonomous-dev-portal/server/stubs/standards.ts` (new) — minimal hand-written stub set; one rule per severity; `applies` predicate strings keyed off repo names from `stubs/repos.ts`.

## Tests

| Test | Assertion |
|------|-----------|
| `EmptyState` happy | renders `<p class="muted empty-state">No active requests</p>` |
| `EmptyState` with hint | second `<p>` rendered with `empty-state-hint` class |
| All-empty Dashboard | `repos:[], requests:[], standards:[]` → page renders; KPI strip shows zeros; "No repositories allowlisted", "No active requests", "No blocking hits" all present in DOM |
| 0 gates suppression | with empty arrays, `.approval-queue` is absent (per SPEC-036-1-04 contract) |
| Type compatibility | `bun tsc --noEmit` passes after edits |
| Stub `variantLabel` | every stub `DashboardRequest` has `variantLabel` set; integration test asserts the chip rendered with the label, not the id |
| Stub standards | `stubs/standards.ts` exports `StandardRule[]` with at least one of each severity |
| Stub gate fields | at least one stub request has `status: 'gate'`, a `gateType`, and `waitedMin` populated |

## Verification

- `bun tsc --noEmit` passes (PLAN-036-1 Task 1 acceptance).
- `bun test plugins/autonomous-dev-portal/tests/unit/empty-state.test.tsx` passes.
- `bun test plugins/autonomous-dev-portal/tests/integration/dashboard.test.ts` empty-state variant passes (TDD-036 §8.4): no JS errors, all expected `EmptyState` strings appear, no broken layout.
- The `variantLabel` field is referenced only by fragments, never recomputed — `grep -rn "variants.find" server/templates/` returns zero matches outside route handlers / stub loaders.
- Existing surfaces (Costs, Ops, Settings) compile unchanged with the additive type extensions.
