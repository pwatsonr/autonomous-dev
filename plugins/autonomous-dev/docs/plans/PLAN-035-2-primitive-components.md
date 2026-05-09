# PLAN-035-2: Primitive Components (Btn, Chip, Dot, Score, CostRing, Card)

## Metadata
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Estimated effort**: 3 days
- **Dependencies**: ["PLAN-034-1", "PLAN-035-1"]
- **Blocked by**: ["PLAN-034-1"] (tokens), ["PLAN-035-1"] (shell layout patterns + CSS pipeline)
- **Priority**: P0 (consumed by PLAN-035-3, PLAN-035-4, and TDD-018-C surface adoption)
- **Stage**: Phase 1 of TDD-035 §11 rollout (primitives — additive, zero surface impact)

## Objective

Land the six non-safety-critical primitive components from R-08 in
`server/components/primitives.tsx` with the prop APIs pinned by TDD-035 §6.5.0
("API Authority"). These components are the binding contract that TDD-018-C
surface authors and the `/design-system` regression page consume. The seventh
primitive — `KillSwitch` — is split into PLAN-035-3 because its surface area
(state machine, route handlers, CSRF, daemon-halt failure handling) is
materially larger than the other six combined.

Concretely this plan delivers:

1. `server/components/primitives.tsx` containing six exported FCs: `Btn`, `Chip`, `Dot`, `Score`, `CostRing`, `Card` — each matching its TDD §6.5.x reference implementation verbatim.
2. The R-08 prop signatures exactly: `Btn({kind?, size?, disabled?, ...rest})`, `Chip({variant, tone?, children})`, `Dot({tone?, live?})`, `Score({value, threshold?, label?})`, `CostRing({spent, cap, label?})`, `Card({leftBar?, padding?, children})`. Per TDD-035 §6.5.0, these names supersede the design kit's original prop names (`kind` → `variant` on Chip, `n` → `value` on Score).
3. The primitive CSS in `portal.css`: `.btn` (+ `.primary`, `.ghost`, `.destructive`, `.sm` modifiers), `.chip` (+ tone modifiers `.ok`, `.warn`, `.err`, `.info`, `.muted`, `.brand`), `.chip-phase` (+ all 8 phase modifiers, `::before` 6px dot pseudo-element), `.dot` (+ tone + `.live` with `@keyframes pulse`), `.score-inline`, `.score-track`, `.score-fill`, `.score-num`, `.score-label`, `.ring`, `.card`, `.card-h`, `.card-b`.
4. The `@keyframes pulse` animation for `.dot.live` (1.6s box-shadow ripple from `rgba(47,122,62,0.45)` to transparent over 6px) — the canonical live-state indicator replacing all spinners (R-15).
5. Unit tests for all six primitives covering every assertion in TDD-035 §10.1 except KillSwitch.
6. Pass-through `...rest` on `Btn` for HTMX attributes (`hx-get`, `hx-post`, `hx-target`, `hx-swap`) so the consumer surfaces can attach HTMX semantics without a wrapper component.

## Scope

### In Scope
- All six non-KillSwitch primitives in a single file with named exports.
- Authoritative prop signatures from R-08 + TDD §6.5.0; the kit's prop names are not supported.
- Primitive CSS classes from TDD-035 §15 "Primitives" (excluding `.ks-*`).
- The `pulse` keyframe animation.
- Unit tests for all six components per TDD-035 §10.1 (rows for Btn/Chip/Dot/Score/CostRing/Card).
- Documentation comment on each component referencing its TDD §6.5.x section and the R-08 requirement.

### Out of Scope
- `KillSwitch` primitive and its server-side state machine — PLAN-035-3.
- The shell, rail, brand wordmark, theme toggle — PLAN-035-1.
- The `/design-system` route and visual regression — PLAN-035-4.
- Surface re-skinning (consuming the primitives in real pages) — TDD-018-C.
- Token vendoring and CI lints — PLAN-034-1.
- Lucide icon vendoring or font self-hosting — PRD-018 NG-03 / NG-04.

## Tasks

1. **Create `server/components/primitives.tsx`.** Single file, six named exports, no default export. Each component is a pure FC with no hooks, no state, no side effects (TDD §6.5 invariant). Effort: 0.1 day.

2. **Implement `Btn` (§6.5.1).** `kind?: "primary"|"secondary"|"ghost"|"destructive"` (default `"secondary"`), `size?: "sm"|"md"` (default `"md"`), `disabled?: boolean`, `children`, plus `[key: string]: unknown` for HTMX pass-through. Class composition: always include `"btn"`; append `kind` only when not `"secondary"`; append `"sm"` when size is `"sm"`. Render as `<button class={...} disabled={disabled} {...rest}>{children}</button>`. Effort: 0.3 day.

3. **Implement `Chip` (§6.5.2).** `variant: "status"|"phase"`, `tone?: StatusTone | PhaseName`, `children?`. When `variant === "phase"`: render `<span class="chip-phase {tone}">` with `(tone as string).toUpperCase()` as the text content (R-11). Otherwise: render `<span class="chip {tone ?? ''}">{children}</span>`. Phase chips use the `::before` 6px dot via CSS — no JSX dot insertion. Effort: 0.3 day.

4. **Implement `Dot` (§6.5.3).** `tone?: "ok"|"warn"|"err"|"info"|"muted"` (default `"muted"`), `live?: boolean`. When `live` is true, class is `"dot live"` (the live indicator overrides the tone visually); otherwise `"dot {tone}"`. Render as `<span class={...}></span>` (self-closing span by convention). Effort: 0.2 day.

5. **Implement `Score` (§6.5.4).** `value: number` (0..100), `threshold?: number` (default `85`), `label?: string`. Color logic: `var(--ok)` when `value >= threshold`, `var(--warn)` when `value >= threshold * 0.8`, `var(--err)` otherwise. Render as `<span class="score-inline">` containing optional label, `.score-track` with inner `.score-fill` styled `width: {value}%; background: {color}`, and a mono `.score-num` showing the integer value. Effort: 0.4 day.

6. **Implement `CostRing` (§6.5.5).** `spent: number`, `cap: number`, `label?: string`. Compute `pct = cap > 0 ? Math.min(100, (spent / cap) * 100) : 0`; circumference = `2 * Math.PI * 34`; offset = `circumference - (circumference * pct) / 100`; color = `var(--warn)` when `pct >= 80` else `var(--brand)`. Render an 80x80 SVG with two `<circle>` elements (track + arc) and two `<text>` elements (percentage + label) using mono font tokens. Include `aria-label="{label ?? 'Cost'}: {pct}%"` on the SVG root. Effort: 0.5 day.

7. **Implement `Card` (§6.5.6).** `leftBar?: PhaseName`, `padding?: "sm"|"md"|"lg"` (default `"md"`), `children?`. Padding map: `sm: 12px, md: 16px, lg: 24px`. When `leftBar` provided, inline style is `border-left: 4px solid var(--phase-{leftBar}); padding: {pad}`; otherwise just `padding: {pad}`. Render `<div class="card" style={style}>{children}</div>`. The 4px phase-colored left bar is the system's one decorative motif (R-12). Effort: 0.2 day.

8. **Add primitive CSS to `portal.css`.** All `.btn` / `.btn.{primary,ghost,destructive,sm}` rules with the four state matrices from TDD §6.5.1 (default, hover, active, focus-visible). All `.chip` and `.chip.{tone}` rules. All `.chip-phase` and `.chip-phase.{phase}` rules including the `::before` 6px dot. All `.dot` / `.dot.{tone}` / `.dot.live` rules. The `@keyframes pulse` definition. `.score-inline`, `.score-track` (80px x 4px, `var(--bg-3)`, 999px radius), `.score-fill`, `.score-num`, `.score-label`. `.ring` (no special styling — sizing is on the SVG element). `.card` (`var(--bg-1)` background, 1px `var(--line-1)` border, 3px radius, NO box-shadow per R-15a), `.card-h`, `.card-b`. Effort: 0.7 day.

9. **Unit tests (`tests/unit/components/primitives.test.tsx`).** All 13 assertion rows from TDD-035 §10.1 except the four KillSwitch / BrandWordmark rows: Btn class composition (one test per kind, plus `sm` size, plus `disabled` attribute, plus `...rest` HTMX pass-through asserting `hx-get` survives), Chip status + phase variants (uppercase text for phase), Dot tone + live, Score color thresholds at three boundaries, CostRing arc-offset math, CostRing 80%-warning threshold, Card with leftBar, Card without leftBar. Effort: 0.5 day.

10. **API authority documentation.** Add a JSDoc comment block at the top of `primitives.tsx` referencing TDD-035 §6.5.0 ("API Authority") and listing the kit-prop → R-08-prop renames (`kind` → `variant` on Chip, `n` → `value` on Score). Surface authors must read this. Effort: 0.1 day.

## Verification

- All 13 non-KillSwitch assertion rows in TDD-035 §10.1 pass.
- Btn HTMX pass-through: `<Btn kind="primary" hx-post="/foo">Save</Btn>` renders with `hx-post="/foo"` attribute on the `<button>`.
- Chip phase variant always renders text in UPPERCASE regardless of input casing (R-11).
- Dot live: presence of `.dot.live` triggers the `pulse` animation (manual: load a page with a live dot, observe pulse).
- Score: at value=85 with default threshold=85, fill is `var(--ok)`; at value=70, fill is `var(--warn)`; at value=50, fill is `var(--err)`.
- CostRing math: spent=80, cap=100 → pct=80, color=`var(--warn)`; spent=200, cap=100 → pct=100 (clamped), color=`var(--warn)`; cap=0 → pct=0, no NaN.
- Card with leftBar: inline style contains `border-left: 4px solid var(--phase-code)` for `leftBar="code"`.
- Card without leftBar: inline style contains only padding, no `border-left`.
- No `box-shadow:` declarations in the new primitive CSS outside `--shadow-*` tokens (R-15a; CI lint from PLAN-034-1 enforces).
- No emoji in any rendered string (R-10; CI lint from PLAN-034-1 enforces).
- TypeScript: every primitive's prop interface is exported so consumers can `import type { BtnProps } from "../components/primitives"`.

## Test Plan

- **Unit (Hono JSX)**: `tests/unit/components/primitives.test.tsx` covers all 13 non-KillSwitch rows from TDD-035 §10.1. Each component test renders the JSX, captures the HTML string, and asserts class membership / attribute presence / text content.
- **CSS regression**: visual-regression coverage for the primitives lives in PLAN-035-4 (`/design-system` page renders all primitives; Playwright golden images detect any rendering drift). This plan's tests do NOT need pixel snapshots.
- **Type check**: `tsc --noEmit` passes; `BtnProps`, `ChipProps`, `DotProps`, `ScoreProps`, `CostRingProps`, `CardProps` are all exported.
- **Manual smoke**: import each primitive into a scratch test view, render a sampler, eyeball the output against the design bundle screenshots. (The `/design-system` page in PLAN-035-4 will replace this manual step.)

## Rollback

The primitives are additive — no existing portal page imports them in this plan. Rollback is `git revert <commit-sha>` of the single commit that adds `primitives.tsx` and the corresponding CSS block. Rollback has zero impact on existing pages because nothing consumes the new components yet (PLAN-035-3 / PLAN-035-4 / TDD-018-C are downstream consumers and will fail builds without this primitive file, which is the intended dependency-ordering signal).

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Surface authors use the kit's original prop names (`kind` on Chip, `n` on Score) instead of the R-08 / §6.5.0 names | High | Medium | API-authority JSDoc block at top of `primitives.tsx`; TypeScript catches the renamed props at build time (kit prop names will not exist on the exported interfaces); reviewer rubric for TDD-018-C PRs explicitly checks prop names. |
| `Btn` `...rest` pass-through accidentally injects React-flavored attributes (e.g., `onClick`) that Hono JSX silently drops | Medium | Low | Test asserts HTMX `hx-*` attributes survive the spread. Document that vanilla DOM attributes are the expected use case; React event handlers are not (PRD-018 §4.5 — no React runtime). |
| `pulse` keyframe animation runs at full GPU on long-lived dashboards and drains battery | Low | Low | The animation is a simple `box-shadow` interpolation, GPU-accelerated, 1.6s period. Monitored by existing portal observability if it ever becomes an issue. R-15 mandates this as the canonical indicator — no alternative. |
| `CostRing` SVG arc math floating-point drift causes 1px wobble on threshold transitions | Low | Low | The `toFixed(1)` rounding on `stroke-dasharray` / `stroke-dashoffset` and `toFixed(0)` on the percentage text means any drift is sub-pixel and below the visual-regression 0.1% threshold. |
| `Card` consumer accidentally passes a non-phase string to `leftBar` | Low | Low | TypeScript `PhaseName` union enforces this at build time; `--phase-{invalid}` would just resolve to nothing in CSS (no border) — visible bug, not a crash. |
| Phase chip `::before` dot color tokens drift from the chip background tokens after a future token update | Low | Low | The `--phase-*` tokens are the single source for both the chip background and the `::before` dot. Any change is symmetric. M-02 contrast script (TDD-034 SS 5.10) is the regression gate. |

## Definition of Done

- [ ] `server/components/primitives.tsx` exports `Btn`, `Chip`, `Dot`, `Score`, `CostRing`, `Card` plus their prop interfaces.
- [ ] Top-of-file JSDoc references TDD-035 §6.5.0 API authority and lists the kit → R-08 prop renames.
- [ ] All R-08 prop signatures match exactly; no kit-original prop names accepted.
- [ ] Primitive CSS classes from TDD-035 §15 (excluding `.ks-*`) added to `portal.css`.
- [ ] `@keyframes pulse` defined; `.dot.live` animates.
- [ ] All 13 non-KillSwitch assertion rows in TDD-035 §10.1 pass.
- [ ] HTMX `hx-*` attributes pass through `Btn` correctly.
- [ ] No `box-shadow:` declarations in new CSS outside `--shadow-*` tokens.
- [ ] No emoji in any default text content.
- [ ] TypeScript build passes; prop interfaces are exported.
