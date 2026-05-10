# SPEC-035-2-02: `Btn` Primitive — Buttons with kind / size / disabled + HTMX Pass-Through

## Metadata
- **Parent Plan**: PLAN-035-2 (Primitive Components)
- **Parent TDD**: TDD-035, §6.5.1 (`Btn`)
- **Parent PRD**: PRD-018, R-08, R-09
- **Tasks Covered**: PLAN-035-2 Task 2 (Btn); test rows from §10.1 for Btn class composition, `sm` size, `disabled`, and HTMX `...rest` pass-through.
- **Depends on**: SPEC-035-2-01 (file skeleton), SPEC-035-2-07 (CSS)
- **Estimated effort**: 0.3 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement the `Btn` primitive in `server/components/primitives.tsx` to the prop signature pinned by R-08 and TDD §6.5.1. The component must compose CSS classes deterministically, forward arbitrary attributes (especially `hx-*`) to the underlying `<button>`, and never collide with the kit's React-flavored prop names.

## Acceptance Criteria

1. **Prop signature is exactly R-08** (TDD §6.5.0 authoritative):
   ```ts
   interface BtnProps {
       kind?: "primary" | "secondary" | "ghost" | "destructive";  // default "secondary"
       size?: "sm" | "md";                                          // default "md"
       disabled?: boolean;                                          // default false
       children?: unknown;
       [key: string]: unknown;  // pass-through for hx-* and DOM attrs
   }
   export const Btn: FC<BtnProps>;
   export type { BtnProps };
   ```
2. **Class composition** (verbatim per §6.5.1):
   - Always include `"btn"`.
   - Append `kind` (the literal value) only when `kind !== "secondary"`.
   - Append `"sm"` when `size === "sm"`. Never append `"md"`.
   - Class string is space-joined in the order `[btn, kind?, sm?]`.
3. **Rendered HTML examples** (must match):
   - `<Btn>` → `<button class="btn"></button>` (secondary md, no children).
   - `<Btn kind="primary">Approve</Btn>` → `<button class="btn primary">Approve</button>`.
   - `<Btn kind="ghost" size="sm">Cancel</Btn>` → `<button class="btn ghost sm">Cancel</button>`.
   - `<Btn kind="destructive" disabled>Engage kill switch</Btn>` → `<button class="btn destructive" disabled>Engage kill switch</button>`.
4. **HTMX pass-through**: any prop not destructured (`kind`, `size`, `disabled`, `children`) is spread onto the `<button>`. The test asserting `<Btn kind="primary" hx-post="/foo" hx-target="#out">Save</Btn>` renders with both `hx-post="/foo"` and `hx-target="#out"` attributes must pass.
5. **Disabled attribute**: when `disabled` is `true`, the rendered `<button>` carries the boolean `disabled` attribute. When `false` (default), it does not.
6. The kit's prop names are not accepted — the `BtnProps` interface omits any kit-only keys; TypeScript catches mistakes at build time per the §6.5.0 contract.
7. CSS state matrix (R-09) is delivered by SPEC-035-2-07 (this spec only authors the component).

## Implementation

**File**: `plugins/autonomous-dev-portal/server/components/primitives.tsx` (insert under the `// Btn — see SPEC-035-2-02` placeholder).

```tsx
type BtnKind = "primary" | "secondary" | "ghost" | "destructive";
type BtnSize = "sm" | "md";

export interface BtnProps {
    kind?: BtnKind;
    size?: BtnSize;
    disabled?: boolean;
    children?: unknown;
    [key: string]: unknown;
}

export const Btn: FC<BtnProps> = ({
    kind = "secondary",
    size = "md",
    disabled = false,
    children,
    ...rest
}) => {
    const classes = ["btn"];
    if (kind !== "secondary") classes.push(kind);
    if (size === "sm") classes.push("sm");
    return (
        <button class={classes.join(" ")} disabled={disabled} {...rest}>
            {children}
        </button>
    );
};
```

Notes:
- `disabled={false}` is the default; Hono JSX serializes `disabled={false}` as no attribute on the rendered element.
- `...rest` does NOT include `kind`, `size`, `disabled`, or `children` — those are destructured out before the spread, preventing them from leaking onto the DOM.

## Tests

**File**: `tests/unit/components/primitives.test.tsx` (or the existing equivalent — see SPEC-035-2-07 for shared harness).

| Test | Assertion |
|------|-----------|
| `Btn` default renders `class="btn"` | exactly one class, no kind suffix |
| `Btn kind="primary"` | class string equals `"btn primary"` |
| `Btn kind="ghost"` | class string equals `"btn ghost"` |
| `Btn kind="destructive"` | class string equals `"btn destructive"` |
| `Btn kind="secondary"` | class string equals `"btn"` (kind suppressed) |
| `Btn size="sm"` | class string includes `"sm"` |
| `Btn size="md"` | class string does NOT include `"md"` |
| `Btn disabled` | rendered HTML includes `disabled` attribute |
| `Btn` HTMX pass-through | `<Btn hx-post="/foo" hx-target="#x">…</Btn>` renders both attributes |
| `Btn` non-leak | `kind`/`size`/`disabled` do NOT appear as DOM attributes |

Each test renders the JSX, captures the HTML string (Hono's `renderToString` or equivalent), and asserts substring/attribute presence.

## Verification

- The four §6.5.1 rendered-HTML examples reproduce byte-identical (modulo whitespace) from the unit tests.
- `grep -nE "kind \?:.*primary.*secondary.*ghost.*destructive" server/components/primitives.tsx` returns one line — the `BtnKind` definition.
- `BtnProps` is exported and importable as `import type { BtnProps } from "../components/primitives"`.
- HTMX integration test (PLAN-035-3 / TDD-018-C downstream) consumes `<Btn hx-get=…>` without a wrapper component.
- TDD §10.1 rows for Btn (4 rows: kind, sm, disabled, HTMX pass-through) all pass.
