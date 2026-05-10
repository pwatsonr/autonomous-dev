# SPEC-036-2-03: Costs Month-End Projection

## Metadata
- **Parent Plan**: PLAN-036-2-costs-and-ops
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.3)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-18)
- **Tasks Covered**: PLAN-036-2 Task 6 (projection sub-region)
- **Dependencies**: PLAN-035-2 primitive `CostRing`, SPEC-036-2-01 (Costs route composition), SPEC-036-2-02 (chart renders alongside)
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Summary

Implement the month-end projection sub-region of the Costs surface. The
projection takes MTD spend, the 30-day series, and the configured monthly
cost cap, and surfaces a forecast month-end total. The headline figure
renders inside the `CostRing` primitive (PLAN-035-2); secondary detail
(daily run-rate, days remaining, projected overage) renders as plain
mono numerics next to the ring.

## 2. Functional Requirements

| ID   | Requirement                                                                                                                          | Task |
|------|--------------------------------------------------------------------------------------------------------------------------------------|------|
| FR-1 | A `projectMonthEnd(series, today)` helper MUST live at `server/lib/costs-projection.ts` and return `{ projected: number, runRateDaily: number, daysRemaining: number, overage: number }`. | T6   |
| FR-2 | The projection algorithm MUST be `runRateDaily = sum(series last 7 days) / 7`; `daysRemaining = daysInMonth - dayOfMonth`; `projected = MTD + runRateDaily * daysRemaining`; `overage = max(0, projected - cap)`. | T6   |
| FR-3 | When `series.length < 7`, the run-rate falls back to `MTD / dayOfMonth` (avoids over-extrapolating from sparse data).                  | T6   |
| FR-4 | When `series.length === 0` or `MTD === 0`, the helper MUST return `{ projected: 0, runRateDaily: 0, daysRemaining, overage: 0 }` and the projection region MUST render the empty state ("No spend yet this month"). | T6   |
| FR-5 | The projection region MUST render a `CostRing` with `spent={projected}`, `cap={costCap}`, `label="Projected"`. The ring's tone MUST follow the primitive contract (warn ≥ 80% of cap, err ≥ 100%). | T6   |
| FR-6 | Adjacent to the ring, a small detail block MUST render three rows: "Run rate / day: $X.XX", "Days left: N", "Forecast overage: $X.XX" (last row hidden when `overage === 0`). | T6   |
| FR-7 | All numerics MUST render via `mono` class with 2-decimal formatting per PRD-018 R-22.                                                  | T6   |
| FR-8 | Negative or NaN inputs MUST be clamped to 0 in the helper before formatting (defense against bad stub data).                           | T6   |

## 3. Acceptance Criteria

```
Given series = [30 days, last 7 averaging $14.20/day], MTD = $312, cap = $500, today = day 22 of 31
When projectMonthEnd is called
Then runRateDaily ≈ 14.20
And daysRemaining = 9
And projected ≈ 312 + 14.20 * 9 = 439.80
And overage = 0
```

```
Given MTD = $480, cap = $500, runRate forecasts projected = $620
When the projection region renders
Then the CostRing receives spent=620, cap=500
And the ring tone is "err" (over cap)
And the detail block shows "Forecast overage: $120.00"
```

```
Given series = [], MTD = 0
When the projection region renders
Then the empty state "No spend yet this month" renders
And no CostRing is mounted
```

## 4. Implementation Notes

- New helper file: `server/lib/costs-projection.ts`. Pure function, no side effects, fully unit-testable.
- New fragment: `server/templates/fragments/cost-projection.tsx` consumes the helper output and `CostRing`.
- `CostRing` primitive prop surface is binding per PRD-018 R-08; do not introduce new props.
- The detail block uses plain `<dl class="kv mono">` — no chip, no card frame (the surrounding section card supplies elevation).
- Do not display percentages on the projection panel (the ring already encodes the ratio); the detail block is absolute numbers only.

## 5. Tests

- **Unit**: `tests/unit/costs-projection.test.ts` — table-driven over the four scenarios (happy path, over-cap, sparse series fallback, empty/zero MTD); plus negative/NaN clamping.
- **Integration**: `tests/integration/costs.test.ts` extension — assert the `cost-ring` element renders with the right `spent`/`cap` data attributes and the detail block contains the run-rate row.
- **Empty state**: zero-MTD feed renders "No spend yet this month" and asserts no `<svg class="cost-ring">` mounts.

## 6. Verification

- `bun test plugins/autonomous-dev-portal/tests/unit/costs-projection.test.ts` passes all cases.
- `bun test plugins/autonomous-dev-portal/tests/integration/costs.test.ts` includes the projection assertions.
- Manual: visit `/costs`, verify ring tone changes when stub MTD is bumped past 80% / 100% of cap.
