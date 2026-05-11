# SPEC-037-6-01: Rename KPI + repo-card classes; collapse repo-card wrapper

## Metadata
- **Parent Plan**: PLAN-037-6-css-class-drift-fix
- **Parent PRD**: PRD-018-portal-visual-redesign (kit parity)
- **Tasks Covered**: PLAN-037-6 rows 1, 2, 4 of the rename table
- **Dependencies**: none (CSS rules already exist in kit `app.css`)
- **Estimated effort**: 0.25 day
- **Status**: Draft
- **Date**: 2026-05-09

## 1. Objective

Reconcile two fragments to the kit's canonical class names so existing kit
CSS rules actually hit:

1. `templates/fragments/kpi-strip.tsx` emits `.kpi-value` — kit defines
   `.kpi-num` (`app.css:354`). Rename.
2. `templates/fragments/repo-card.tsx` emits `.rc-top, .rc-name, .rc-trust,
   .rc-path, .rc-meta, .rc-footer` — kit defines `.repo-top, .repo-id,
   .repo-trust, .repo-path, .repo-meta-row, .repo-foot` (`app.css:379-386`).
   Rename, and collapse the `<Card><div class="repo-card">` double wrapper
   to a single `<button class="repo-card">` element (kit `Dashboard.jsx`
   shape; `.repo-card:hover` rule on `app.css:377` expects an interactive
   element).

No new CSS rules are added — every target class already exists in the kit
stylesheet bundled into the portal.

## 2. Acceptance Criteria

The following grep counts MUST all return zero after the patch is applied,
run from `plugins/autonomous-dev-portal/`:

```
grep -rnE 'class="kpi-value"|"kpi-value"' server/ static/ tests/      # 0
grep -rnE 'class="rc-(top|name|trust|path|meta|footer)"' server/ tests/  # 0
grep -rnE '"rc-(top|name|trust|path|meta|footer)"' server/ tests/        # 0
grep -rn '<Card[^>]*>\s*<div class="repo-card' server/                # 0
```

Positive assertions:

- `grep -rn 'class="kpi-num"' server/templates/fragments/kpi-strip.tsx`
  returns ≥1.
- `grep -rnE 'class="repo-(top|id|trust|path|meta-row|foot)"'
  server/templates/fragments/repo-card.tsx` returns ≥6 (one per region).
- `repo-card.tsx` contains exactly one `<button` element with
  `class="repo-card"` (or `class="repo-card attn"`); no `<Card` import.

## 3. Implementation

### 3.1 `server/templates/fragments/kpi-strip.tsx`

Edit replacements:
- `<div class="kpi-value">{it.value}</div>` →
  `<div class="kpi-num">{it.value}</div>`
- Update the JSDoc header rendered-HTML example: `<div class="kpi-value">`
  → `<div class="kpi-num">`

### 3.2 `server/templates/fragments/repo-card.tsx`

- Remove the `Card` import; keep `Chip` and `PhaseName`.
- Replace the `<Card leftBar={phaseForBar} padding="md"><div
  class={"repo-card" + ...}>` wrapper with a single
  `<button type="button" class={"repo-card" + (r.attn ? " attn" : "")}
  data-phase={r.phase ?? ""}>`. Pass the phase as a `data-phase` attr; the
  4px left bar comes from the existing `.repo-card { border-left: 4px solid
  var(--phase-...) }` rule pattern in kit CSS (the kit relies on a CSS
  attribute selector or inline custom property — emit `style={"--phase-bar:
  var(--phase-" + r.phase + ")"}` if the kit rule keys off it; pick the
  approach that matches `app.css:370-378` after re-reading the rule).
- Region renames inside the new `<button>`:
  - `rc-top` → `repo-top`
  - `rc-name` → `repo-id`
  - `rc-trust` → `repo-trust`
  - `rc-path` → `repo-path`
  - both `rc-meta` → `repo-meta-row`
  - `rc-footer` → `repo-foot`
- Footer numeric spans receive the kit's `.num` class on the active /
  MTD counts (kit `app.css:385`).

### 3.3 Test fixtures

`tests/unit/repo-card.test.tsx` references the old class names — rename
in lockstep with the fragment (see §4).

## 4. Tests

- `tests/unit/kpi-strip.test.tsx` — replace `kpi-value` literals with
  `kpi-num`; assert `/<div class="kpi-num">\$\d/` on the MTD tile.
- `tests/unit/repo-card.test.tsx` — replace each `rc-*` index lookup with
  the `repo-*` equivalent; add assertion `expect(html).toMatch(/^<button
  [^>]*class="repo-card/)`; assert NO `<Card` wrapper appears in the
  rendered HTML.
- Snapshot diff: the rendered HTML for one fixture repo card before/after
  shows class renames + outer element flip from `<div><div>` to `<button>`.

## 5. Verification

1. `bun test tests/unit/kpi-strip.test.tsx tests/unit/repo-card.test.tsx`
   → green.
2. From `plugins/autonomous-dev-portal/`:
   `grep -rnE 'kpi-value|rc-(top|name|trust|path|meta|footer)' server/
   static/ tests/` → 0 matches.
3. Manual: load `/dashboard` and `/costs` against a portal dev build;
   confirm KPI numbers render in mono 26px (kit rule on `.kpi-num`) and
   each repo card has hoverable phase-tinted left bar.
