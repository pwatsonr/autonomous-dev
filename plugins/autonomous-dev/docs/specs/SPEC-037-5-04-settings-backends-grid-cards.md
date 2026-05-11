# SPEC-037-5-04: Settings Backends Grid + Cards

## Metadata
- **Parent Plan**: PLAN-037-5-settings-tab-layouts
- **Parent TDD**: TDD-037-portal-kit-parity
- **Parent PRD**: PRD-018-portal-visual-redesign (PRD-014 — deploy backends)
- **Tasks Covered**: PLAN-037-5 Task 4 (Backends tab rebuild)
- **Estimated effort**: 0.5 day
- **Dependencies**: SPEC-036-4-01 (Settings route + tab shell), SPEC-037-5-06 (shared Modal helper for Install)
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Render the Backends tab as a responsive `.backend-grid` of
`.backend-card`s. Each card shows the backend name, a kind chip
(`bundled` → `chip ok`, `plugin` → `chip info`), a cost line, a row
of `.cap-chip`s for capabilities, and an action footer that renders
Configure + Set default for `available` backends or `Install plugin`
otherwise (`Settings.jsx:143-172`).

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | A new fragment `templates/fragments/settings-backends.tsx` exports `<BackendsPanel data={data}/>`. |
| AC-02 | Root is `<section class="sec"><div class="sec-head"><h2>Deploy backends</h2><span class="meta-mono dim">PRD-014</span></div><p class="dim">…</p><div class="backend-grid">…</div></section>`. |
| AC-03 | For each `b` in `data.backends`, render `<div class={"backend-card " + b.status}>` (`available`, `not-installed`, etc.). |
| AC-04 | Card top: `<div class="backend-top"><div class="backend-name">{b.name}</div><span class={"chip " + (b.kind === 'bundled' ? 'ok' : 'info') + " sm"}>{b.kind}</span></div>`. |
| AC-05 | Cost line: `<div class="backend-cost meta-mono">{b.cost}</div>`. |
| AC-06 | Caps row: `<div class="backend-caps">{b.caps.map(c => <span class="cap-chip">{c}</span>)}</div>`. |
| AC-07 | Actions for `available` backends: `<div class="backend-actions"><button class="btn sm">Configure</button><button class="btn sm primary" hx-post="/api/settings/default-backend" hx-vals={JSON.stringify({id: b.id})}>Set default</button></div>`. |
| AC-08 | Actions for non-`available` backends: `<div class="backend-actions"><button class="btn sm primary" hx-get={"/api/backends/" + b.id + "/install"} hx-target="#modal-slot">Install plugin</button></div>`. The endpoint returns the Install modal fragment defined by SPEC-037-5-06. |
| AC-09 | If `b.id === data.defaultBackend`, the "Set default" button renders `disabled` and the card carries an extra class `default`. |
| AC-10 | The panel slot in `views/settings.tsx` swaps the previous flat list to call `<BackendsPanel data={data}/>`. |

## Implementation

- New fragment `server/templates/fragments/settings-backends.tsx`.
- The Install action does **not** open a `<dialog>`; it loads the
  shared `Modal` overlay fragment into `#modal-slot` (the modal slot
  is hoisted in `views/settings.tsx` as a sibling of the panel grid
  per SPEC-037-5-06).
- `.backend-card.not-installed` already renders dashed border via
  `app.css:587` — no CSS changes required.
- Render backends in source order from `data.backends`; tests rely on
  that ordering.
- Concrete JSX for a single `available` backend:

  ```tsx
  <div class="backend-card available">
    <div class="backend-top">
      <div class="backend-name">{b.name}</div>
      <span class="chip ok sm">{b.kind}</span>
    </div>
    <div class="backend-cost meta-mono">{b.cost}</div>
    <div class="backend-caps">
      {b.caps.map(c => <span class="cap-chip">{c}</span>)}
    </div>
    <div class="backend-actions">
      <button class="btn sm">Configure</button>
      <button class="btn sm primary" hx-post="/api/settings/default-backend"
              hx-vals={JSON.stringify({id: b.id})}>Set default</button>
    </div>
  </div>
  ```

## Tests

- **Snapshot (`tests/snapshot/settings-backends-panel.test.ts`)**:
  render with a mix of `bundled+available`, `plugin+available`, and
  `plugin+not-installed` backends. Assert kind-chip class flips
  (`ok` vs `info`), action footer variants, and `.cap-chip` count
  equals `b.caps.length`.
- **Unit (`tests/unit/backends-default-disabled.test.ts`)**: when
  `b.id === data.defaultBackend`, the "Set default" button is
  `disabled` and the card has class `default`.

## Verification

- `bun test tests/snapshot/settings-backends-panel.test.ts tests/unit/backends-default-disabled.test.ts` passes.
- Manual smoke: open `/settings?tab=backends`; observe responsive
  grid; click "Install plugin" on a non-installed backend, observe
  the shared Modal overlay open via HTMX swap.
