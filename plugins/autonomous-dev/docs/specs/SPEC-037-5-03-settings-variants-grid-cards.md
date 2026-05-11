# SPEC-037-5-03: Settings Variants Grid + Cards

## Metadata
- **Parent Plan**: PLAN-037-5-settings-tab-layouts
- **Parent TDD**: TDD-037-portal-kit-parity
- **Parent PRD**: PRD-018-portal-visual-redesign (PRD-011 — pipeline variants)
- **Tasks Covered**: PLAN-037-5 Task 2 (Variants tab rebuild)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-036-4-01 (Settings route + tab shell), PLAN-037-2 (`POST /api/settings/default-variant`)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Replace the Variants tab's current flat select/table with the kit's
`.variant-grid` of `.variant-card`s. Each card shows a phase pipeline
of `.phase-tag p-{phase}` chips separated by `→` arrows and a reviewer
chain row per phase (`Settings.jsx:77-112`).

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | A new fragment `templates/fragments/settings-variants.tsx` exports `<VariantsPanel data={data}/>`. |
| AC-02 | Panel root is `<section class="sec"><div class="sec-head"><h2>Pipeline variants</h2><span class="meta-mono dim">PRD-011</span></div><div class="variant-grid">…</div></section>`. |
| AC-03 | For each `v` in `data.variants`, a `<div class={"variant-card" + (v.id === data.defaultVariant ? " on" : "")}>` is rendered. |
| AC-04 | Card top row: `<div class="variant-top"><div class="variant-name">{v.label}</div>{isDefault && <span class="chip ok sm">default</span>}</div>`. |
| AC-05 | Pipeline row: `<div class="variant-pipe">` containing, for each phase in `v.phases`, `<span class={"phase-tag p-" + phase}>{phase}</span>` followed (except after the last) by `<span class="arrow">→</span>`. |
| AC-06 | Reviewer chain row: `<div class="variant-rev">` with one `<div class="rev-line">` per `(phase, reviewers[])` entry in `v.reviewers`, where each line is `<span class="rev-phase meta-mono">{phase}:</span><span>{reviewers.join(' · ')}</span>`. |
| AC-07 | Card actions: `<div class="variant-actions"><button class="btn sm">Edit</button><button class="btn sm primary" hx-post={"/api/settings/default-variant"} hx-vals={JSON.stringify({id: v.id})}>Set default</button></div>`. The current-default card omits the "Set default" button (or renders it `disabled`). |
| AC-08 | Description below the title: `<div class="variant-desc">{v.desc}</div>`. |
| AC-09 | The panel matches `<SettingsPanel id="variants">` semantics (carries `hidden` when not the active tab per SPEC-036-4-01). |

## Implementation

- New fragment file `server/templates/fragments/settings-variants.tsx`
  exporting the `VariantsPanel` FC. `views/settings.tsx` swaps the
  current Variants slot to call it.
- All `phase-tag p-{name}` colours are pre-defined in `app.css:569-578`
  for `prd|tdd|plan|spec|code|review|deploy|observe|threat|write`. No
  CSS changes are required for the supported phase set.
- HTMX targets the same `#settings-root` swap target used by the Save
  flow so the panel re-renders after a successful "Set default" POST.
- Render variants in deterministic order (by `id` ASC) so snapshots
  are stable.
- Reviewer chain row is read-only in this spec; editing is the Edit
  modal's job (out of scope, the button is a stub that opens nothing
  yet — leave a `data-todo="edit-variant"` attribute so the follow-up
  spec can wire it).

## Tests

- **Snapshot (`tests/snapshot/settings-variants-panel.test.ts`)**:
  render with three variants where one is the default. Assert
  `.variant-grid` exists, exactly three `.variant-card`, the
  default card has `.on`, the pipeline row contains
  `phase-tag p-prd` … `phase-tag p-deploy` separated by `→`, and the
  reviewer chain renders one `.rev-line` per phase with reviewers.
- **Unit (`tests/unit/variants-panel-empty.test.ts`)**: with
  `data.variants = []` the panel still renders the section + sec-head
  and an empty `.variant-grid`.

## Verification

- `bun test tests/snapshot/settings-variants-panel.test.ts tests/unit/variants-panel-empty.test.ts` passes.
- Manual smoke: open `/settings?tab=variants`; observe two-up cards
  with coloured phase chips and reviewer lines; click "Set default"
  on a non-default card, observe the `.on` outline move.
