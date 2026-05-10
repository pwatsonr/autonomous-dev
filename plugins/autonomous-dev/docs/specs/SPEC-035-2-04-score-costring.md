# SPEC-035-2-04: `Score` and `CostRing` Primitives — Numeric Visualizations

## Metadata
- **Parent Plan**: PLAN-035-2 (Primitive Components)
- **Parent TDD**: TDD-035, §6.5.4 (`Score`), §6.5.5 (`CostRing`)
- **Parent PRD**: PRD-018, R-08
- **Tasks Covered**: PLAN-035-2 Task 5 (Score), Task 6 (CostRing); §10.1 rows for Score color thresholds, CostRing arc-offset math, CostRing 80% warning threshold.
- **Depends on**: SPEC-035-2-01 (skeleton), SPEC-035-2-07 (CSS — `.score-*`, `.ring`).
- **Estimated effort**: 0.9 day combined
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement the two numeric primitives. `Score` renders a 0..100 horizontal bar with a threshold-driven color (`--ok`/`--warn`/`--err`). `CostRing` renders an 80×80 SVG donut showing `spent/cap` with a center percentage and optional label. Both use the R-08 prop names (`value` not `n`) and are SVG/CSS-driven for crispness at any device pixel ratio.

## Acceptance Criteria

### Score

1. **Prop signature is exactly R-08**:
   ```ts
   export interface ScoreProps {
       value: number;       // 0..100
       threshold?: number;  // default 85
       label?: string;
   }
   export const Score: FC<ScoreProps>;
   ```
   The kit's `n` prop is NOT supported (TDD §6.5.0).
2. **Color logic** (TDD §6.5.4):
   - `value >= threshold` → `var(--ok)`
   - `value >= threshold * 0.8` → `var(--warn)`
   - else → `var(--err)`
3. **Rendered HTML**: `<span class="score-inline">` containing:
   - Optional `<span class="score-label">{label}</span>` when `label` is truthy.
   - `<span class="score-track"><span class="score-fill" style="width: {value}%; background: {color}"></span></span>`
   - `<span class="score-num meta-mono">{value}</span>` (the integer value as text).
4. **Boundary cases** (verifiable):
   - `value=85`, default `threshold=85` → fill is `var(--ok)`.
   - `value=70`, default `threshold=85` (70 ≥ 68 = 85·0.8) → fill is `var(--warn)`.
   - `value=50`, default `threshold=85` → fill is `var(--err)`.
   - `value=100` → `width: 100%`.
   - `value=0` → `width: 0%`, fill is `var(--err)`.

### CostRing

5. **Prop signature is exactly R-08**:
   ```ts
   export interface CostRingProps {
       spent: number;
       cap: number;
       label?: string;  // e.g. "TODAY" | "MONTH"
   }
   export const CostRing: FC<CostRingProps>;
   ```
6. **Math** (TDD §6.5.5 — exact):
   - `pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;`
   - `circumference = 2 * Math.PI * 34;` (radius 34)
   - `offset = circumference - (circumference * pct) / 100;`
   - `color = pct >= 80 ? "var(--warn)" : "var(--brand)";`
7. **Rendered SVG**:
   - Root `<svg class="ring" viewBox="0 0 80 80" width="80" height="80" aria-label="{label ?? 'Cost'}: {pct.toFixed(0)}%">`.
   - Track circle: `<circle cx="40" cy="40" r="34" fill="none" stroke="var(--bg-3)" stroke-width="8" />`.
   - Arc circle: same geometry plus `stroke={color}`, `stroke-dasharray={circumference.toFixed(1)}`, `stroke-dashoffset={offset.toFixed(1)}`, `stroke-linecap="round"`, `transform="rotate(-90 40 40)"`.
   - Center text: `<text x="40" y="38" text-anchor="middle" font-family="var(--font-mono)" font-weight="700" font-size="14" fill="var(--fg-0)">{pct.toFixed(0)}%</text>`.
   - Optional label text (when `label` truthy): `<text x="40" y="52" text-anchor="middle" font-family="var(--font-mono)" font-size="9" fill="var(--fg-2)">{label}</text>`.
8. **Edge cases**:
   - `cap=0` → `pct=0`, no `NaN` in `stroke-dashoffset` (offset equals circumference).
   - `spent > cap` → `pct=100` (clamped), color is `var(--warn)`.
   - `spent=80, cap=100` → `pct=80`, color is `var(--warn)` (boundary inclusive).
   - `spent=79, cap=100` → `pct=79`, color is `var(--brand)`.

## Implementation

**File**: `plugins/autonomous-dev-portal/server/components/primitives.tsx` (under the `// Score, CostRing — see SPEC-035-2-04` placeholder).

```tsx
export interface ScoreProps {
    value: number;
    threshold?: number;
    label?: string;
}

export const Score: FC<ScoreProps> = ({ value, threshold = 85, label }) => {
    const ok = value >= threshold;
    const color = ok
        ? "var(--ok)"
        : value >= threshold * 0.8
        ? "var(--warn)"
        : "var(--err)";
    return (
        <span class="score-inline">
            {label && <span class="score-label">{label}</span>}
            <span class="score-track">
                <span
                    class="score-fill"
                    style={`width: ${value}%; background: ${color}`}
                ></span>
            </span>
            <span class="score-num meta-mono">{value}</span>
        </span>
    );
};

export interface CostRingProps {
    spent: number;
    cap: number;
    label?: string;
}

export const CostRing: FC<CostRingProps> = ({ spent, cap, label }) => {
    const pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0;
    const circumference = 2 * Math.PI * 34;
    const offset = circumference - (circumference * pct) / 100;
    const color = pct >= 80 ? "var(--warn)" : "var(--brand)";

    return (
        <svg class="ring" viewBox="0 0 80 80" width="80" height="80"
             aria-label={`${label ?? "Cost"}: ${pct.toFixed(0)}%`}>
            <circle cx="40" cy="40" r="34" fill="none"
                    stroke="var(--bg-3)" stroke-width="8" />
            <circle cx="40" cy="40" r="34" fill="none"
                    stroke={color} stroke-width="8"
                    stroke-dasharray={circumference.toFixed(1)}
                    stroke-dashoffset={offset.toFixed(1)}
                    stroke-linecap="round"
                    transform="rotate(-90 40 40)" />
            <text x="40" y="38" text-anchor="middle"
                  font-family="var(--font-mono)" font-weight="700"
                  font-size="14" fill="var(--fg-0)">
                {pct.toFixed(0)}%
            </text>
            {label && (
                <text x="40" y="52" text-anchor="middle"
                      font-family="var(--font-mono)" font-size="9"
                      fill="var(--fg-2)">
                    {label}
                </text>
            )}
        </svg>
    );
};
```

`toFixed(1)` on the dash math and `toFixed(0)` on the percentage text keep float drift sub-pixel — well below the 0.1% visual-regression threshold.

## Tests

| Test | Assertion |
|------|-----------|
| Score `value=88, threshold=85` | inline style includes `background: var(--ok)` |
| Score `value=85, threshold=85` (boundary) | style includes `var(--ok)` (≥, inclusive) |
| Score `value=70, threshold=85` (within 80%) | style includes `var(--warn)` |
| Score `value=50, threshold=85` | style includes `var(--err)` |
| Score `value=88` | `<span class="score-num meta-mono">88</span>` present |
| Score `label="PRD"` | `<span class="score-label">PRD</span>` rendered |
| Score no label | no `.score-label` element rendered |
| Score width | `style` substring `"width: 88%"` present for `value=88` |
| CostRing `spent=80, cap=100` | `aria-label` includes `"80%"`; arc stroke is `var(--warn)` |
| CostRing `spent=79, cap=100` | arc stroke is `var(--brand)` |
| CostRing `spent=200, cap=100` (clamp) | `aria-label` includes `"100%"`; offset = 0 |
| CostRing `cap=0` | `aria-label` includes `"0%"`; no NaN in `stroke-dashoffset` |
| CostRing offset math | for `spent=50, cap=100`: `circumference = 2π·34`, `offset = circumference·0.5`, `toFixed(1)` matches |
| CostRing `label="TODAY"` | second `<text>` element present with `"TODAY"` content |

## Verification

- TDD §10.1 rows for Score color thresholds, CostRing arc-offset math, CostRing 80% threshold all pass.
- `ScoreProps` and `CostRingProps` are exported as types.
- Manual: render `<CostRing spent={50} cap={100} label="TODAY" />` in `/design-system` (PLAN-035-4) — center reads "50%", arc fills exactly half clockwise.
- No `box-shadow:` declarations introduced; rings are flat per R-15a.
