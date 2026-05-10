# SPEC-035-2-03: `Chip` and `Dot` Primitives — Status / Phase Chips and Live Indicator

## Metadata
- **Parent Plan**: PLAN-035-2 (Primitive Components)
- **Parent TDD**: TDD-035, §6.5.2 (`Chip`), §6.5.3 (`Dot`)
- **Parent PRD**: PRD-018, R-08, R-10, R-11, R-15
- **Tasks Covered**: PLAN-035-2 Task 3 (Chip), Task 4 (Dot); §10.1 rows for Chip status, Chip phase uppercase, Dot tone, Dot live.
- **Depends on**: SPEC-035-2-01 (file skeleton + `StatusTone` + `PhaseName`), SPEC-035-2-07 (CSS, `@keyframes pulse`).
- **Estimated effort**: 0.5 day combined
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement two stateless primitives: `Chip` (status or phase classification badge) and `Dot` (8px state indicator with optional pulse animation). Both must use the R-08 prop names — not the kit's. `Chip`'s `variant` prop replaces the kit's `kind`. `Dot`'s `live` flag triggers the canonical pulsing indicator that supersedes all spinners (R-15).

## Acceptance Criteria

### Chip

1. **Prop signature is exactly R-08** (TDD §6.5.0 supersedes kit):
   ```ts
   export interface ChipProps {
       variant: "status" | "phase";
       tone?: StatusTone | PhaseName;
       children?: unknown;
   }
   export const Chip: FC<ChipProps>;
   ```
   The kit's `kind` prop is NOT supported. TypeScript rejects `<Chip kind="…">`.
2. **Phase variant** (`variant === "phase"` and `tone` truthy): render
   `<span class="chip-phase {tone}">{tone.toUpperCase()}</span>`. The label is the *uppercased phase name*, regardless of any `children` passed (R-11).
3. **Status variant** (otherwise): render `<span class="chip {tone ?? ''}">{children}</span>`. Children are rendered verbatim; consumers are responsible for uppercase per R-10 conventions.
4. **No JSX dot**: the 6px colored dot on phase chips is delivered by the CSS `::before` pseudo-element (SPEC-035-2-07), never injected in JSX.
5. **Rendered HTML examples**:
   - `<Chip variant="status" tone="ok">RUNNING</Chip>` → `<span class="chip ok">RUNNING</span>`
   - `<Chip variant="status" tone="err">TRIPPED</Chip>` → `<span class="chip err">TRIPPED</span>`
   - `<Chip variant="phase" tone="code" />` → `<span class="chip-phase code">CODE</span>`
   - `<Chip variant="phase" tone="prd" />` → `<span class="chip-phase prd">PRD</span>`

### Dot

6. **Prop signature is exactly R-08**:
   ```ts
   type DotTone = "ok" | "warn" | "err" | "info" | "muted";
   export interface DotProps {
       tone?: DotTone;        // default "muted"
       live?: boolean;        // default false
   }
   export const Dot: FC<DotProps>;
   ```
   Note: `Dot.tone` does NOT include `"brand"` — only the five base tones (TDD §6.5.3).
7. **Class composition**:
   - When `live === true`: render `<span class="dot live"></span>` — the live state is visually canonical and overrides the tone.
   - Otherwise: render `<span class="dot {tone}"></span>` (default `"dot muted"`).
8. **Rendered HTML examples**:
   - `<Dot live />` → `<span class="dot live"></span>`
   - `<Dot tone="ok" />` → `<span class="dot ok"></span>`
   - `<Dot tone="err" />` → `<span class="dot err"></span>`
   - `<Dot />` → `<span class="dot muted"></span>`
9. The `.dot.live` class triggers the `pulse` keyframe animation (defined in SPEC-035-2-07; this spec only authors the component).

## Implementation

**File**: `plugins/autonomous-dev-portal/server/components/primitives.tsx` (under the `// Chip, Dot — see SPEC-035-2-03` placeholder; consumes `StatusTone`/`PhaseName` from SPEC-035-2-01).

```tsx
type ChipVariant = "status" | "phase";

export interface ChipProps {
    variant: ChipVariant;
    tone?: StatusTone | PhaseName;
    children?: unknown;
}

export const Chip: FC<ChipProps> = ({ variant, tone, children }) => {
    if (variant === "phase" && tone) {
        return (
            <span class={`chip-phase ${tone}`}>
                {(tone as string).toUpperCase()}
            </span>
        );
    }
    return (
        <span class={`chip ${tone ?? ""}`.trimEnd()}>
            {children}
        </span>
    );
};

type DotTone = "ok" | "warn" | "err" | "info" | "muted";

export interface DotProps {
    tone?: DotTone;
    live?: boolean;
}

export const Dot: FC<DotProps> = ({ tone = "muted", live = false }) => (
    <span class={`dot ${live ? "live" : tone}`}></span>
);
```

The `.trimEnd()` on the status-chip class string keeps the rendered HTML clean when `tone` is undefined (`"chip"`, not `"chip "`).

## Tests

| Test | Assertion |
|------|-----------|
| Chip status `tone="ok"` | class equals `"chip ok"`, text content equals children |
| Chip status no tone | class equals `"chip"` (trimmed) |
| Chip phase `tone="code"` | class equals `"chip-phase code"`, text content equals `"CODE"` |
| Chip phase `tone="prd"` | text content equals `"PRD"` |
| Chip phase ignores children | `<Chip variant="phase" tone="code">override</Chip>` text is `"CODE"` |
| Chip phase no tone | falls through to status branch (defensive — class is `"chip"`) |
| Dot default | class equals `"dot muted"` |
| Dot `tone="ok"` | class equals `"dot ok"` |
| Dot `live` | class equals `"dot live"` (NOT `"dot live ok"` even if tone passed) |
| Dot `live` + `tone="ok"` | class equals `"dot live"` (live wins) |

## Verification

- TDD §10.1 rows for Chip (status + phase uppercase) and Dot (tone + live) all pass.
- `Chip` does not accept a `kind` prop (TypeScript build error if attempted) — confirms R-08 supersession.
- Phase-chip text is uppercase regardless of input casing (R-11).
- Visual: load a page with `<Dot live />`, observe the 1.6s pulse ripple from `rgba(47,122,62,0.45)` to transparent over 6px (animation in SPEC-035-2-07).
- `ChipProps`, `DotProps` are exported as `import type` consumers.
