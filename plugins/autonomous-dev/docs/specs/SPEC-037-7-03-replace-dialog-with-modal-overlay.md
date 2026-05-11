# SPEC-037-7-03: Replace `<dialog>` with `.modal-bg` overlay

## Metadata
- **Parent Plan**: PLAN-037-7
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-7 §Scope item 5
- **Dependencies**: PLAN-037-5 (shared modal helper); kit
  `RequestDetail.jsx:190-206`
- **Estimated effort**: 0.5 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Refactor the phase-artifact modal from a native `<dialog>` element to
the kit's `.modal-bg`+`.modal` overlay pattern so the kit's CSS classes
resolve and the modal participates in the shared overlay stacking
context. Consume the shared modal helper introduced by PLAN-037-5.

## Acceptance Criteria

1. `server/templates/fragments/phase-artifact-modal.tsx` no longer emits
   `<dialog>`. It now emits:
   ```
   <div class="modal-bg" data-modal="artifact-{phase}" hidden>
     <div class="modal modal-wide" role="dialog" aria-modal="true"
          aria-labelledby="artifact-modal-{phase}-title">
       <div class="modal-head">…</div>
       <div class="artifact-body">…</div>
     </div>
   </div>
   ```
   The wrapper is `hidden` by default; the shared modal helper toggles
   the attribute on `data-modal-open` / `data-modal-close` clicks.
2. The shared modal helper (from PLAN-037-5) lives at
   `server/static/modal.js`. It exports `openModal(id)` / `closeModal(id)`
   and binds:
   - click on `[data-modal-open="<id>"]` → `openModal(id)`
   - click on `.modal-bg` (target is the backdrop itself) → close
   - click on `[data-modal-close]` inside a modal → close
   - `Escape` key while a modal is open → close the top-most modal
   The helper traps focus inside the open modal and restores focus to
   the prior `:focus` target on close.
3. The phase-artifact pipe-step buttons in `pipeline-vis.tsx` are
   updated from their existing trigger to
   `data-modal-open="artifact-{phase}"` so the shared helper drives
   the open transition. The close button keeps `data-modal-close`.
4. `static/phase-artifact-modal.js` is deleted; its responsibilities
   move into `static/modal.js`. The shell page includes `modal.js`
   once and only once.
5. `aria-modal="true"`, `role="dialog"`, and `aria-labelledby` are set
   on the inner `.modal` element. The close button retains
   `aria-label="Close"`.
6. Visual: backdrop matches kit (`.modal-bg` with token-driven backdrop
   color), modal aligns to `.modal-wide` width.

## Implementation

**Files**
- `server/templates/fragments/phase-artifact-modal.tsx` — rewrite
  markup; drop `<dialog>`.
- `server/templates/fragments/pipeline-vis.tsx` — update trigger
  attribute to `data-modal-open`.
- `server/static/modal.js` — consumes PLAN-037-5 helper; if not yet
  landed, this SPEC blocks on it. Document the contract in the file
  header.
- `server/static/phase-artifact-modal.js` — delete.
- Shell template — ensure `modal.js` is included.

## Tests

- `tests/fragments/phase-artifact-modal.test.ts`: emits `.modal-bg`
  wrapper with `hidden`; no `<dialog>` element; `data-modal` id matches
  phase; close button has `data-modal-close`.
- `tests/static/modal.test.ts` (or jsdom integration):
  `openModal` / `closeModal` toggle `hidden`; backdrop click closes;
  Escape closes top-most; focus trap stays inside.
- `tests/fragments/pipeline-vis.test.ts`: pipe-step button has
  `data-modal-open` attribute.

## Verification

- `bun test tests/fragments/phase-artifact-modal.test.ts tests/static/modal.test.ts tests/fragments/pipeline-vis.test.ts` passes.
- Manual: open modal via pipeline click, dismiss via Escape, backdrop,
  and close button.
