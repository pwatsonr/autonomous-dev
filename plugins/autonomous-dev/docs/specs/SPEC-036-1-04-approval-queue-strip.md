# SPEC-036-1-04: Approval Queue Strip — v1.1 Region (Top 3 Gate-Blocked Requests)

## Metadata
- **Parent Plan**: PLAN-036-1 (Dashboard Surface Re-skin)
- **Parent TDD**: TDD-036, §6.1 (Dashboard, Approval queue strip — v1.1 addition)
- **Parent PRD**: PRD-018, R-16 (v1.1)
- **Tasks Covered**: PLAN-036-1 Task 5 (`fragments/approval-queue.tsx`)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-035-2-02 (`Chip` primitive — `variant: 'phase'|'status'`, tones), SPEC-035-2-03 (`Btn` primitive — `kind`, `size`, `href`), SPEC-036-1-06 (`DashboardRequest` extensions: `gateType`, `waitedMin`).
- **Priority**: P0 (v1.1 region added late in PRD-018 review pass; required for first-flip surface).
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement `fragments/approval-queue.tsx` — a horizontal strip rendered between the repo card grid and the standards-drift summary, showing the next 3 gate-blocked requests across all repos sorted by `waitedMin` descending (longest wait first). Each gate row has a phase chip, repo name, request ID (mono), gate-type chip with tone-mapped semantics, age in minutes, and a primary `Review` button linking to the request detail page.

## Acceptance Criteria

1. **Prop signature**:
   ```ts
   export interface ApprovalQueueStripProps {
       gates: DashboardRequest[]; // already filtered to status==='gate' by route
       totalCount?: number;       // total gates across all repos (for the meta-mono header)
   }
   export const ApprovalQueueStrip: FC<ApprovalQueueStripProps>;
   ```
2. **Sort + slice contract**: the route handler MUST pre-sort by `waitedMin` desc and slice to the first 3 before passing in. The fragment does not re-sort. (This separation keeps the fragment pure and lets the route apply other filters in future.)
3. **Empty state**: when `gates.length === 0`, the fragment renders nothing (returns `null`). The entire `<section class="sec approval-queue">` is absent from the DOM. Per TDD-036 §6.1: "When 0 gates exist, the entire approval queue section is not rendered."
4. **Gate-row markup** (per TDD-036 §6.1 verbatim): `<div class="gate-row">` containing in order: phase `Chip`, `<span class="gate-repo">`, `<span class="gate-id meta-mono">`, gate-type `Chip`, `<span class="gate-age meta-mono dim">{waitedMin}m</span>`, `<Btn size="sm" kind="primary" href="/repo/{repo}/request/{id}">Review</Btn>`.
5. **Gate-type tone mapping** (helper `gateTypeTone(type)`):
   - `reviewer-chain` → `warn`
   - `standards-violation` → `err`
   - `cost-cap` → `info`
   - any other / undefined → `muted`
6. **Gate-type label mapping** (helper `gateTypeLabel(type)`): renders human-readable text — `reviewer-chain` → `"Reviewer"`, `standards-violation` → `"Standards"`, `cost-cap` → `"Cost cap"`, fallback → the raw type string.
7. **Section container**: `<section id="approval-queue" class="sec approval-queue">` with `id` exposed for the `dashboard:gates` SSE OOB channel; section head `<h2>Awaiting approval</h2>` + `<span class="meta-mono dim">{totalCount} total</span>`.
8. **Review button** uses the `Btn` primitive (R-08) with `kind="primary"`, `size="sm"`, and `href` (the `Btn` primitive already supports rendering as `<a>` when `href` is set per PLAN-035-2).

## Implementation

**File**: `plugins/autonomous-dev-portal/server/templates/fragments/approval-queue.tsx`

```tsx
import type { FC } from "hono/jsx";
import { Btn, Chip } from "../../components/primitives";
import type { DashboardRequest } from "../../types/render";

const gateTypeTone = (t?: string) =>
    t === "reviewer-chain" ? "warn"
    : t === "standards-violation" ? "err"
    : t === "cost-cap" ? "info"
    : "muted";

const gateTypeLabel = (t?: string) =>
    t === "reviewer-chain" ? "Reviewer"
    : t === "standards-violation" ? "Standards"
    : t === "cost-cap" ? "Cost cap"
    : (t ?? "Gate");

export interface ApprovalQueueStripProps {
    gates: DashboardRequest[];
    totalCount?: number;
}

export const ApprovalQueueStrip: FC<ApprovalQueueStripProps> = ({ gates, totalCount }) => {
    if (gates.length === 0) return null;
    return (
        <section id="approval-queue" class="sec approval-queue">
            <div class="sec-head">
                <h2>Awaiting approval</h2>
                <span class="meta-mono dim">{totalCount ?? gates.length} total</span>
            </div>
            <div class="gate-strip">
                {gates.map((g) => (
                    <div class="gate-row" key={g.id}>
                        <Chip variant="phase" tone={g.phase}>{g.phase.toUpperCase()}</Chip>
                        <span class="gate-repo">{g.repo}</span>
                        <span class="gate-id meta-mono">{g.id}</span>
                        <Chip variant="status" tone={gateTypeTone(g.gateType)}>
                            {gateTypeLabel(g.gateType)}
                        </Chip>
                        <span class="gate-age meta-mono dim">{g.waitedMin ?? 0}m</span>
                        <Btn kind="primary" size="sm" href={`/repo/${g.repo}/request/${g.id}`}>
                            Review
                        </Btn>
                    </div>
                ))}
            </div>
        </section>
    );
};
```

## Tests

| Test | Assertion |
|------|-----------|
| 5 gates, 3 rendered | route slices `[0..3)`; fragment renders 3 `.gate-row` |
| Sort respected | first row's `waitedMin` is the largest of the input |
| 0 gates | `gates: []` → fragment returns null; no `.approval-queue` in DOM |
| Tone mapping | `reviewer-chain` → warn; `standards-violation` → err; `cost-cap` → info; unknown → muted |
| Label mapping | `reviewer-chain` → "Reviewer"; fallback echoes raw type |
| Phase chip uppercase | rendered phase text matches `/^[A-Z]+$/` |
| Review button href | `href="/repo/{repo}/request/{id}"` exact match |
| Section id | outer `<section>` has `id="approval-queue"` for SSE OOB |
| `totalCount` override | `totalCount: 12` shown when 3 gates rendered |

## Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/approval-queue.test.tsx` passes (sort, slice, tone/label maps, empty-state null path).
- `bun test plugins/autonomous-dev-portal/tests/integration/dashboard.test.ts` asserts `.approval-queue` present when gates exist and absent when empty.
- Visual regression: the strip's row layout matches the kit's `Dashboard.jsx` lines 95-130 in light + dark themes.
- `grep -rn "#[0-9a-f]" server/templates/fragments/approval-queue.tsx` returns zero matches (PRD-018 M-01).
