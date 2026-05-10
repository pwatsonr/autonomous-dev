# SPEC-035-2-05: `Card` Primitive — Hairline Container with Optional Phase-Colored Left Bar

## Metadata
- **Parent Plan**: PLAN-035-2 (Primitive Components)
- **Parent TDD**: TDD-035, §6.5.6 (`Card`)
- **Parent PRD**: PRD-018, R-08, R-12, R-15a
- **Tasks Covered**: PLAN-035-2 Task 7 (Card); §10.1 rows for Card with `leftBar` and Card without `leftBar`.
- **Depends on**: SPEC-035-2-01 (skeleton, `PhaseName`), SPEC-035-2-07 (CSS — `.card`).
- **Estimated effort**: 0.2 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement the `Card` primitive — the system's one decorative container — to the R-08 prop signature. A card is a 1px-bordered rectangle with 3px corner radius and **no shadow** (R-15a). When `leftBar` is set to a phase name, the card grows a 4px-wide colored left bar — the "system's one decorative motif" (R-12).

## Acceptance Criteria

1. **Prop signature is exactly R-08** (TDD §6.5.0 / §6.5.6):
   ```ts
   export interface CardProps {
       leftBar?: PhaseName;            // from SPEC-035-2-01
       padding?: "sm" | "md" | "lg";   // default "md"
       children?: unknown;
   }
   export const Card: FC<CardProps>;
   ```
   `PhaseName` is the union from SPEC-035-2-01 (eight phases). TypeScript rejects `<Card leftBar="bogus">`.
2. **Padding map** (verbatim per §6.5.6): `sm: "12px"`, `md: "16px"`, `lg: "24px"`.
3. **Inline style composition**:
   - With `leftBar` → `"border-left: 4px solid var(--phase-{leftBar}); padding: {padMap[padding]}"`.
   - Without `leftBar` → `"padding: {padMap[padding]}"` only — no `border-left` declaration at all.
4. **Rendered HTML** (R-12 motif):
   - `<Card leftBar="code">…</Card>` → `<div class="card" style="border-left: 4px solid var(--phase-code); padding: 16px">…</div>`
   - `<Card padding="lg">…</Card>` → `<div class="card" style="padding: 24px">…</div>` (no `border-left`)
   - `<Card>…</Card>` (defaults) → `<div class="card" style="padding: 16px">…</div>`
5. **No shadow** (R-15a): the rendered `<div>` carries no `box-shadow` declaration. Card chrome is the 1px border + 3px radius supplied by `.card` in CSS (SPEC-035-2-07).
6. **Phase token contract**: `leftBar="code"` resolves to `var(--phase-code)`. The eight phase tokens (`--phase-prd`, `--phase-tdd`, `--phase-plan`, `--phase-spec`, `--phase-code`, `--phase-review`, `--phase-deploy`, `--phase-observe`) are defined in `design-tokens.css` (PLAN-034-1 / TDD-034); this primitive only references them.

## Implementation

**File**: `plugins/autonomous-dev-portal/server/components/primitives.tsx` (under the `// Card — see SPEC-035-2-05` placeholder; consumes `PhaseName` from SPEC-035-2-01).

```tsx
type CardPadding = "sm" | "md" | "lg";

export interface CardProps {
    leftBar?: PhaseName;
    padding?: CardPadding;
    children?: unknown;
}

export const Card: FC<CardProps> = ({ leftBar, padding = "md", children }) => {
    const padMap: Record<CardPadding, string> = {
        sm: "12px",
        md: "16px",
        lg: "24px",
    };
    const style = leftBar
        ? `border-left: 4px solid var(--phase-${leftBar}); padding: ${padMap[padding]}`
        : `padding: ${padMap[padding]}`;

    return (
        <div class="card" style={style}>
            {children}
        </div>
    );
};
```

## Tests

| Test | Assertion |
|------|-----------|
| Card default | rendered `<div class="card" style="padding: 16px">…</div>`; no `border-left` substring in style |
| Card `padding="sm"` | style contains `"padding: 12px"` |
| Card `padding="lg"` | style contains `"padding: 24px"` |
| Card `leftBar="code"` | style contains `"border-left: 4px solid var(--phase-code)"` |
| Card `leftBar="prd"` | style contains `"var(--phase-prd)"` |
| Card `leftBar="code", padding="lg"` | style contains both border-left and `"padding: 24px"` |
| Card without `leftBar` | style does NOT contain `"border-left"` |
| Card no shadow | rendered HTML contains no `box-shadow` substring |
| Card children | children appear as-is inside the `<div>` |
| Card invalid leftBar | TypeScript build error (compile-time, not runtime) |

## Verification

- TDD §10.1 rows for Card-with-leftBar and Card-without-leftBar both pass.
- `CardProps` is exported as `import type { CardProps } from "../components/primitives"`.
- A `grep -rn "box-shadow" server/components/primitives.tsx` returns zero matches (R-15a).
- The 4px bar in `var(--phase-{leftBar})` is visible in the design-system page (PLAN-035-4) and matches the kit's screenshot pixel-faithfully.
- M-02 phase-vs-`--bg-0` contrast script (TDD-034 SS 5.10 / TDD-035 §10.3) verifies the 4px bar is visually distinguishable in both themes — this primitive only references the tokens, the contrast gate lives in PLAN-034-1.
