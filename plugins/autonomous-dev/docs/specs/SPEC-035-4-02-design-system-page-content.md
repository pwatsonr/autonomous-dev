# SPEC-035-4-02: `/design-system` Page Content — 20 Section Components

## Metadata
- **Parent Plan**: PLAN-035-4
- **Parent TDD**: TDD-035-portal-redesign-shell-primitives (§6.8)
- **Parent PRD**: PRD-018-portal-visual-redesign (R-21, M-03)
- **Tasks Covered**: PLAN-035-4 Tasks 2, 3, 4
- **Depends on**: SPEC-035-4-01 (route + skeleton), PLAN-035-2 (Btn/Chip/Dot/Score/CostRing/Card primitives), PLAN-035-3 (KillSwitch)
- **Estimated effort**: 1.4 day
- **Status**: Draft
- **Date**: 2026-05-09

## Objective

Implement the body of all 20 section components stubbed by SPEC-035-4-01. Each section re-implements its corresponding `preview/*.html` reference card using the portal's own primitives (or pure token-driven HTML for foundation-only sections). No `dangerouslySetInnerHTML`, no copied raw HTML — every visible element flows through a primitive or a token variable so that visual regression catches drift in the actual component code.

## Acceptance Criteria

Each section ships in `server/templates/views/design-system/sections/section-{NN}.tsx` per the table:

| #  | Section            | Implementation                                                                                                  |
|----|--------------------|------------------------------------------------------------------------------------------------------------------|
| 01 | Type display       | Six font specimens at 28/20/15/13/12/11px in Inter and JetBrains Mono. Pure HTML using `var(--font-*)` tokens. |
| 02 | Type body          | Body paragraph + mono numerics (`123.45`, `$1,843.20`) + ID specimens (`req-7f3a2b1c`).                          |
| 03 | Colors neutrals    | `.ds-swatch-grid` of `bg-0`, `bg-1`, `bg-2`, `line-1`, `line-2`, `fg-0`, `fg-1`, `fg-2`, `fg-3` swatches with hex labels. |
| 04 | Colors brand       | Brand amber + `--brand-tint` + `--brand-line` companions in a `.ds-swatch-grid`.                                |
| 05 | Colors semantic    | `<Chip variant="status" tone={t}>` for t in `ok|warn|err|info|muted`.                                            |
| 06 | Colors phases      | `<Chip variant="phase" tone={p}>` for p in `prd, tdd, plan, spec, code, review, deploy, observe` in that order. |
| 07 | Spacing and radii  | Visualized scale for `--s-1`..`--s-6` and `--r-1`..`--r-3` as labeled boxes.                                    |
| 08 | Elevation          | Two `<Card>` instances side-by-side: hairline-only and `style={{ boxShadow: 'var(--shadow-pop)' }}`.            |
| 09 | Buttons            | All 4 `kind` × 2 `size` (8 buttons): primary/secondary/ghost/destructive × sm/md.                               |
| 10 | Status chips       | `<Chip variant="status" tone={t}>` for ok, warn, err, info, muted, plus a `brand` variant if available.         |
| 11 | Phase chips        | All 8 phase chips in a single row, canonical order.                                                              |
| 12 | Dots               | All 5 tones (ok/warn/err/info/muted) plus a `<Dot tone="ok" live />` specimen.                                  |
| 13 | Scores             | `<Score value=92 />`, `<Score value=70 />`, `<Score value=45 />` with default threshold=85.                     |
| 14 | Cost ring          | `<CostRing spent=18 cap=120 label="TODAY" />` and `<CostRing spent=1843 cap=2500 label="MONTH" />`.             |
| 15 | Inputs             | Text input, select, error-state input, mono variant input. CSS-only (no primitive).                            |
| 16 | Repo card          | `<Card leftBar="code">` with `<Chip variant="phase" tone="code" />` + `<Score value=88 />` + `<Dot tone="ok" live />`; second variant `leftBar="review"` showing attention state. |
| 17 | Kill switch        | `<KillSwitch engaged={false} onConfirm="/ops/kill-switch" />` and `<KillSwitch engaged={true} onConfirm="/ops/kill-switch" />` side-by-side. Armed state intentionally omitted (see PLAN-035-4 task 4). |
| 18 | Cost panel         | `<Card>` containing `<CostRing spent=1843 cap=2500 />` plus a budget breakdown table (per-phase rows with mono dollar columns). |
| 19 | Timeline           | Eight rows: `<Dot tone="ok" />` + `<Chip variant="phase" tone={p} />` + label per phase in canonical order; the active phase row uses `<Dot tone="ok" live />`. |
| 20 | Brand wordmark     | `<BrandWordmark showBrackets={true} />` plus a wrapping `<div data-theme="dark">` containing a second `<BrandWordmark showBrackets={true} />` to demonstrate dark theme rendering on the same page. |

- AC-1 No section uses `dangerouslySetInnerHTML`.
- AC-2 Token-only sections (01, 02, 03, 04, 07) reference only `var(--*)` values; no hex literals.
- AC-3 Each interactive primitive's section exercises the primitive's full prop surface enumerated in PRD-018 R-08 for that primitive.
- AC-4 Section 17's engaged state renders `.ks-panel.armed` styling without requiring a transient HTMX response (uses the primitive's `engaged={true}` prop directly).
- AC-5 Section 20's dark wordmark is contained in `<div data-theme="dark">` so the rendered cascade switches independently of the page-level theme.
- AC-6 The `.dot.live` instance in sections 12, 16, and 19 carries the `dot live` class combination expected by SPEC-035-4-03's animation-pause stylesheet.

## Implementation

Each section file is a default-export Hono JSX function returning the inner content of its `<section>` (the wrapping `<section id="preview-NN" class="ds-card">` element comes from SPEC-035-4-01's view skeleton). Common pattern:

```tsx
// section-09.tsx — Buttons
import { Btn } from "../../../components/primitives";
export default function Section09() {
  return (
    <>
      <h2>Buttons</h2>
      <div class="ds-row">
        <Btn kind="primary">Primary</Btn>
        <Btn kind="secondary">Secondary</Btn>
        <Btn kind="ghost">Ghost</Btn>
        <Btn kind="destructive">Destructive</Btn>
      </div>
      <div class="ds-row">
        <Btn kind="primary" size="sm">Primary sm</Btn>
        {/* ... */}
      </div>
    </>
  );
}
```

The TOC labels in SPEC-035-4-01 derive from the H2 text in each section component.

## Tests

- **Unit**: per-section render test asserting at minimum one of each expected primitive class is present (e.g., section-09 yields >= 8 `.btn` elements with the correct `kind` modifier classes).
- **Integration** (`tests/integration/design-system-content.test.ts`): `GET /design-system` body contains the substrings the spec promises — 8 `.btn` elements, 8 phase chips, both engaged + disengaged kill-switch states, both wordmark instances.
- **Token-only sections (01, 02, 03, 04, 07)**: regex-asserts that the rendered HTML for each contains `var(--` tokens but no `#[0-9a-fA-F]{3,8}` hex literals.

## Verification

- `bun test tests/integration/design-system-content.test.ts` passes.
- `bun test tests/unit/design-system-section-*.test.ts` passes.
- Manual: visual diff against `autonomous-dev-design-system/project/preview/preview-{NN}.html` for each section — primitives render the same intent (acknowledged variations: actual portal fonts, actual primitive spacing).
- `grep -RE "#[0-9a-fA-F]{3,8}" server/templates/views/design-system/sections/section-0[1234].tsx server/templates/views/design-system/sections/section-07.tsx` returns zero hits.
- `grep -R "dangerouslySetInnerHTML" server/templates/views/design-system/sections/` returns zero hits.
