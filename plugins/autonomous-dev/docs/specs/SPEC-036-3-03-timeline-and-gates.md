# SPEC-036-3-03: Pipeline Timeline + Gate Detail Card

## Metadata
- **Parent Plan**: PLAN-036-3
- **Parent TDD**: TDD-036-portal-redesign-surfaces (§6.2 "Pipeline
  visualization", "Gate detail card")
- **Parent PRD**: PRD-018-portal-visual-redesign (R-17)
- **Tasks Covered**: PLAN-036-3 Tasks 4, 7 (gate-detail), 8
- **Dependencies**: SPEC-035-2 (primitives — `Btn`, `Chip`, `Score`),
  SPEC-035-3 (ConfirmModal helper)
- **Estimated effort**: 1.0 day
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Implement the **pipeline timeline** (always-rendered horizontal phase
strip) and the **gate detail card** (rendered when `status === 'gate'`).
The timeline is the operator's at-a-glance phase tracker and the
clickable launchpad for the phase artifact modal. The gate card is the
warning-tinted block where approve/reject actions live; this SPEC owns
its surface — the action wiring is in SPEC-036-3-06.

## Acceptance Criteria

1. `fragments/pipeline-vis.tsx` renders a horizontal flex container of
   `<button class="pipe-step">` elements, one per phase in the canonical
   pipeline order. Each step exposes `data-phase="${phase}"`.
2. Each step has exactly one of three visual states applied via class:
   `done`, `now`, `pending`. `now` carries a glow ring (CSS `outline`
   token, NOT `box-shadow` — exempt from R-15a per PLAN risk row).
3. The first step has left border-radius; the last has right
   border-radius; all but the last have `border-right: 0`. State per
   step is server-derived from the request's current phase index.
4. Clicking a `pipe-step` calls
   `document.getElementById('artifact-modal-' + phase).showModal()` (the
   client-side wiring lives in `static/js/phase-artifact-modal.js`,
   delivered alongside this SPEC).
5. `fragments/gate-detail.tsx` renders only when `status === 'gate'`. It
   emits a warning-tinted card with: section head `Gate · <gate type
   label>` plus waited time in `meta-mono`; body containing gate detail
   prose; an action row with `Btn kind="primary" size="sm"` (Approve)
   and `Btn kind="destructive" size="sm"` (Reject). Action wiring is
   delegated to SPEC-036-3-06.
6. The phase artifact modal (`<dialog id="artifact-modal-${phase}">`) is
   server-rendered hidden, one per phase that carries an artifact.
   Backdrop click + Escape dismiss it via native `<dialog>` semantics.
7. `static/js/phase-artifact-modal.js` is loaded from the layout shell
   on the request-detail route only.

## Implementation

**Files**
- `server/templates/fragments/pipeline-vis.tsx` — pipeline phase strip.
- `server/templates/fragments/gate-detail.tsx` — gate card surface (no
  action wiring).
- `server/templates/fragments/phase-artifact-modal.tsx` — hidden
  `<dialog>` per phase; consumes the same `RequestArtifact` shape as
  SPEC-036-3-02.
- `server/static/js/phase-artifact-modal.js` — vanilla JS click → open.

## Tests

- `tests/fragments/pipeline-vis.test.ts`: snapshot of 8-phase pipeline
  with `now` at index 3; first/last step border-radius classes; each
  step has `data-phase` attribute.
- `tests/fragments/gate-detail.test.ts`: renders only when
  `status === 'gate'`; warning tone applied; both buttons present.
- `tests/clientside/phase-artifact-modal.test.ts`: jsdom click on
  `.pipe-step` calls `showModal()` on the matching dialog; ESC closes.

## Verification

- `bun test tests/fragments/pipeline-vis.test.ts tests/fragments/gate-detail.test.ts tests/clientside/phase-artifact-modal.test.ts` passes.
- Visual snapshot covered by SPEC-036-3-01's 4-variant suite (one variant
  is `code-with-gate` so the gate card renders).
