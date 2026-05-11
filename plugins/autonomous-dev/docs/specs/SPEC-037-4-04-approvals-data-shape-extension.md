# SPEC-037-4-04: `ApprovalItem` data-shape extension + stubs

## Metadata
- **Parent Plan**: PLAN-037-4 (Approvals surface rebuild)
- **Parent TDD**: TDD-037 (Portal kit parity)
- **Tasks Covered**: PLAN-037-4 Scope item (6) data-shape extension + stub update
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-036-1-06 (`DashboardRequest` `gateType` / `waitedMin` already exists; this extends the **approvals** type to match)
- **Priority**: P1 (blocker for SPEC-037-4-01 / -03)
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Extend `ApprovalItem` (in `server/types/render.ts`) with the fields the kit's gate-row uses (`gateType`, `phase`, `variant`, `repo`, `waitedMin`, `cost`, `detail`) and rebuild `server/stubs/approvals.ts` to emit 3-5 example rows spanning all three gate types. The legacy `riskLevel` / `costImpactUsd` fields are removed in the same PR (schema break; see PLAN-037-4 risk row 1).

## Acceptance Criteria

1. **Type** in `server/types/render.ts`:
   ```ts
   export interface ApprovalItem {
       id: string;
       summary: string;
       repo: string;
       gateType: "reviewer-chain" | "standards-violation" | "cost-cap";
       phase: "prd" | "tdd" | "plan" | "spec" | "build" | "review" | "deploy";
       variant: string;          // e.g. "deep-research", "vanilla", "fast-iter"
       waitedMin: number;        // integer minutes
       cost: number;             // USD, may be 0
       detail: string;           // human-readable gate-detail line
       actions: { id: string; label: string; confirm: string | null }[];
   }
   ```
   `riskLevel` and `costImpactUsd` are **removed**. Any callers (grep `riskLevel`, `costImpactUsd`) updated in the same PR.
2. **`phase` reuses** the same union string set as `DashboardRequest.phase` (cross-check via `keyof typeof PHASE_TONES` or the existing `Phase` type if exported). If a shared `Phase` type doesn't exist, lift it into `render.ts` and re-export.
3. **Stub data** in `server/stubs/approvals.ts`: produce 4 rows minimum, covering each gate type at least once. Example shape:
   ```ts
   {
     id: "REQ-2041", summary: "Migrate auth module to OIDC",
     repo: "acme-api", gateType: "reviewer-chain", phase: "review",
     variant: "deep-research", waitedMin: 42, cost: 3.14,
     detail: "security-reviewer raised 2 blocking findings",
     actions: [{ id: "approve", … }, { id: "reject", … }],
   },
   { id: "REQ-2042", …, gateType: "standards-violation", … },
   { id: "REQ-2043", …, gateType: "cost-cap", … },
   { id: "REQ-2044", …, gateType: "reviewer-chain", … },
   ```
4. **Route handler** (`server/routes/approvals.ts` or equivalent) passes `costCapDailyUsd` into the view (default `25` if config not yet wired) so SPEC-037-4-01 KPI sub-line has a value.
5. No test or fragment references `riskLevel` after this spec lands (grep clean).

## Implementation

**Files**:
- `plugins/autonomous-dev-portal/server/types/render.ts` — replace `ApprovalItem` per AC-1; update `RenderProps.approvals` to `{ items: ApprovalItem[]; costCapDailyUsd: number }`.
- `plugins/autonomous-dev-portal/server/stubs/approvals.ts` — rewrite `STUB` array per AC-3; `loadApprovalsStub()` returns `{ items, costCapDailyUsd: 25 }`.
- `plugins/autonomous-dev-portal/server/routes/approvals.ts` (or `index.ts` route registration) — propagate `costCapDailyUsd` to the view.
- Grep + remove legacy references:
  ```bash
  grep -rn 'riskLevel\|costImpactUsd\|risk-high\|risk-med\|risk-low' plugins/autonomous-dev-portal
  ```

## Tests

| Test | Assertion |
|------|-----------|
| Type compiles | `bun run check` / `tsc --noEmit` passes after rename |
| Stub shape | `loadApprovalsStub()` returns ≥3 items; every item has `gateType ∈ {reviewer-chain, standards-violation, cost-cap}` |
| All gate types present | At least one stub per gate type |
| Required fields | Every stub item has non-empty `phase`, `variant`, `detail`; numeric `waitedMin >= 0`, `cost >= 0` |
| Cost cap propagated | View receives `costCapDailyUsd > 0` |
| No legacy fields | `grep -rn 'riskLevel' plugins/autonomous-dev-portal` → 0 matches |

## Verification

- `bun run typecheck` (or `tsc -p plugins/autonomous-dev-portal --noEmit`) passes.
- `bun test plugins/autonomous-dev-portal/tests/unit/stubs-approvals.test.ts` passes.
- `curl -s http://127.0.0.1:19280/api/approvals | jq '.items[0] | keys'` lists the new fields.
- `grep -rn 'risk-high\|risk-med\|risk-low\|riskLevel\|costImpactUsd' plugins/autonomous-dev-portal` returns zero.
