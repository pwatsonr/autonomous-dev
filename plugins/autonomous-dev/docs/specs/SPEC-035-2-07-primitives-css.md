# SPEC-035-2-07: `primitives.css` — Primitive Class Styles, `@keyframes pulse`, Focus-Visible Outline

## Metadata
- **Parent Plan**: PLAN-035-2 (Primitive Components)
- **Parent TDD**: TDD-035, §6.5.1–§6.5.6, §15 (CSS Class Inventory)
- **Parent PRD**: PRD-018, R-08, R-09, R-10, R-11, R-12, R-15, R-15a; NG-07 (preserve focus-visible affordance)
- **Tasks Covered**: PLAN-035-2 Task 8 (primitive CSS) — all rules except `.tbl*` (covered by SPEC-035-2-06) and `.ks-*` (PLAN-035-3).
- **Depends on**: PLAN-034-1 (`design-tokens.css` providing all `--bg-*`, `--fg-*`, `--brand*`, `--err*`, `--phase-*`, font, motion tokens).
- **Estimated effort**: 0.7 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Author the CSS file (`server/static/primitives.css`) that styles the six primitives plus their state matrices. Includes the `.btn` / `.btn.{primary,ghost,destructive,sm}` rules and the four-state matrix (default/hover/active/focus-visible) per R-09; `.chip` and `.chip.{tone}`; `.chip-phase` and `.chip-phase.{phase}` with the `::before` 6px dot pseudo-element; `.dot` and `.dot.{tone}` and `.dot.live` plus the canonical `@keyframes pulse` animation (R-15); the `.score-*` family; the `.ring` placeholder; `.card` / `.card-h` / `.card-b` (1px border, 3px radius, no shadow per R-15a). All transitions use the motion tokens established in PLAN-034-1.

## Acceptance Criteria

1. **File location**: `plugins/autonomous-dev-portal/server/static/primitives.css`. Loaded after `design-tokens.css` on every page that uses primitives. Imported by the shell layout (PLAN-035-1).
2. **Buttons (R-09 four-state matrix)**:
   - `.btn` base: `display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; font: 500 13px/1 var(--font-sans); background: var(--bg-1); color: var(--fg-0); border: 1px solid var(--line-2); border-radius: 3px; cursor: pointer; transition: background var(--motion-fast) ease, border-color var(--motion-fast) ease;`
   - `.btn.sm`: `height: 24px; padding: 0 8px; font-size: 12px;`
   - `.btn.primary`: `background: var(--brand); color: #fff; border-color: var(--brand);`
   - `.btn.primary:hover`: `background: var(--brand-hover);`
   - `.btn.primary:active`: `background: var(--brand-press);`
   - `.btn:hover` (secondary fallback): `background: var(--bg-2);`
   - `.btn:active`: `background: var(--bg-3);`
   - `.btn.ghost`: `background: transparent; border-color: transparent;`
   - `.btn.ghost:hover`: `background: var(--bg-2);`
   - `.btn.destructive`: `border-color: var(--err-line); color: var(--err); background: var(--bg-1);`
   - `.btn.destructive:hover`: `background: var(--err-tint);`
   - `.btn.destructive:active`: `background: var(--err-tint); border-color: var(--err);`
   - `.btn[disabled]`: `opacity: 0.5; cursor: not-allowed;`
   - `.btn:focus-visible`: `outline: 2px solid var(--brand); outline-offset: 2px;`
3. **Chips**:
   - `.chip`: `display: inline-flex; align-items: center; gap: 4px; height: 18px; padding: 0 8px; border-radius: 999px; font: 700 11px/1 var(--font-mono); text-transform: uppercase; letter-spacing: 0.04em; background: var(--bg-2); color: var(--fg-1);`
   - Per-tone modifiers: `.chip.ok`, `.chip.warn`, `.chip.err`, `.chip.info`, `.chip.muted`, `.chip.brand` set `background: var(--{tone}-tint); color: var(--{tone});` using the design-tokens palette (`--ok`, `--ok-tint`, etc.).
4. **Phase chips (R-10, R-11)**:
   - `.chip-phase`: same shape as `.chip`, plus `position: relative; padding-left: 18px;` to make room for the dot.
   - `.chip-phase::before`: `content: ""; position: absolute; left: 8px; top: 50%; transform: translateY(-50%); width: 6px; height: 6px; border-radius: 50%; background: currentColor;`
   - `.chip-phase.{prd,tdd,plan,spec,code,review,deploy,observe}`: `background: var(--phase-{phase}-tint); color: var(--phase-{phase});` — 8 selectors total.
5. **Dots (R-15)**:
   - `.dot`: `display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--muted);`
   - `.dot.ok` / `.warn` / `.err` / `.info` / `.muted`: `background: var(--{tone});`
   - `.dot.live`: `background: var(--ok); animation: pulse 1.6s infinite;`
   - **`@keyframes pulse`** (canonical, R-15):
     ```css
     @keyframes pulse {
         0%   { box-shadow: 0 0 0 0 rgba(47, 122, 62, 0.45); }
         70%  { box-shadow: 0 0 0 6px rgba(47, 122, 62, 0); }
         100% { box-shadow: 0 0 0 0 rgba(47, 122, 62, 0); }
     }
     ```
6. **Score**:
   - `.score-inline`: `display: inline-flex; align-items: center; gap: 6px;`
   - `.score-track`: `display: inline-block; width: 80px; height: 4px; background: var(--bg-3); border-radius: 999px; overflow: hidden;`
   - `.score-fill`: `display: block; height: 100%; border-radius: 999px;` (width and background are inline-styled by the JSX).
   - `.score-num`: `font: 700 12px/1 var(--font-mono); color: var(--fg-0);`
   - `.score-label`: `font: 500 10px/1 var(--font-mono); color: var(--fg-2); text-transform: uppercase;`
7. **Ring**:
   - `.ring`: no special styling — sizing is on the SVG element. Reserved selector for future hooks.
8. **Cards (R-12, R-15a)**:
   - `.card`: `background: var(--bg-1); border: 1px solid var(--line-1); border-radius: 3px;` — **no `box-shadow` declaration** (R-15a).
   - `.card-h`: header sub-region — `padding: 12px 16px; border-bottom: 1px solid var(--line-1); font: 600 14px/1.2 var(--font-sans);`
   - `.card-b`: body sub-region — `padding: 16px;`
9. **Focus-visible outline (NG-07 / R-09)**: every interactive primitive (`.btn`, `.chip[tabindex]`) carries `outline: 2px solid var(--brand); outline-offset: 2px;` under `:focus-visible`.
10. **Motion tokens**: all `transition:` declarations use `var(--motion-fast)` (or the equivalent token from PLAN-034-1). No raw `0.15s` or `200ms` literals.
11. **Lint cleanliness**:
    - No `box-shadow:` outside the `.dot.live` `@keyframes` block (which uses spec values for the ripple — exempted; documented in CSS comment).
    - No hex literals; all colors via tokens.
    - No emoji anywhere in the file.

## Implementation

**File**: `plugins/autonomous-dev-portal/server/static/primitives.css`. Organized by component in this exact order, each preceded by a `/* === Component === */` banner comment:

```css
/* === Buttons (R-09) ============================================= */
/* … rules per AC-2 … */

/* === Chips (R-10) =============================================== */
/* … rules per AC-3 … */

/* === Phase Chips (R-10, R-11) =================================== */
/* … rules per AC-4 … */

/* === Dots + pulse (R-15) ======================================== */
/* … rules per AC-5 + @keyframes pulse … */

/* === Score ======================================================= */
/* … rules per AC-6 … */

/* === Ring ======================================================== */
/* … rules per AC-7 … */

/* === Card (R-12, R-15a) ========================================= */
/* … rules per AC-8 … */
```

The rules in the Acceptance Criteria are exhaustive — implementer pastes them in order. No additional selectors are introduced in this spec. Table rules (SPEC-035-2-06) and KillSwitch rules (PLAN-035-3) are appended later.

## Tests

| Test | Assertion |
|------|-----------|
| Btn primary computed style | `background-color` resolves to `var(--brand)` value in computed CSS |
| Btn ghost hover | hovering toggles `background` to `var(--bg-2)` value |
| Btn focus-visible | tabbing to a `.btn` yields `outline: 2px solid var(--brand)` |
| Btn `[disabled]` | disabled `<button>` has `opacity: 0.5` and `cursor: not-allowed` |
| Chip phase `::before` | computed `width` and `height` of `.chip-phase::before` are `6px` |
| Dot live keyframe | `getAnimations()` on `<span class="dot live">` returns one entry with `animationName === "pulse"` and `duration ≈ 1600ms` |
| Pulse animation period | CSS rule `animation: pulse 1.6s infinite` resolves to the keyframes block above |
| Score track size | `.score-track` is exactly 80px × 4px |
| Card no shadow | computed `box-shadow` of `.card` is `none` (R-15a) |
| Card border | computed `border` of `.card` is `1px solid var(--line-1)` resolved value |
| No raw hex | `grep -E "#[0-9a-fA-F]{3,6}\b" primitives.css` returns zero matches outside the documented `pulse` keyframe ripple values (which use rgba spec values per R-15) |

CSS regression: covered by Playwright goldens on `/design-system` (PLAN-035-4 / M-03).

## Verification

- File loads on every page that imports the shell (PLAN-035-1).
- All TDD §15 "Primitives" inventory selectors except `.ks-*` are present and styled.
- `@keyframes pulse` is defined exactly once in the file; `.dot.live` references it.
- M-02 contrast script (TDD-035 §10.3) passes for all chip and phase-chip token pairs.
- Visual: a sample page rendering `<Btn kind="primary" />`, `<Chip variant="phase" tone="code" />`, `<Dot live />`, `<Score value={88} />`, `<CostRing spent={50} cap={100} />`, `<Card leftBar="code" />` matches the kit's screenshots (`screenshots/*.png`) at the 0.1% pixel-diff threshold.
- TDD §10.1 visual rows (any pixel-driven assertions) pass; functional rows pass via SPEC-035-2-02..-05 unit tests.
