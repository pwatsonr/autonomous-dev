# SPEC-037-5-06: Shared Modal Overlay Helper

## Metadata
- **Parent Plan**: PLAN-037-5-settings-tab-layouts
- **Parent TDD**: TDD-037-portal-kit-parity
- **Parent PRD**: PRD-018-portal-visual-redesign
- **Tasks Covered**: PLAN-037-5 Task 7 (shared `<Modal>` + `<ConfirmModal>` overlay helpers); consumed by PLAN-037-7 (RequestDetail)
- **Estimated effort**: 0.5 day
- **Dependencies**: none (foundational); SPEC-037-5-04 and SPEC-037-5-05 consume the output
- **Status**: Draft
- **Author**: Specification Author
- **Date**: 2026-05-09

## Objective

Introduce two reusable Hono JSX helpers — `<Modal>` and
`<ConfirmModal>` — that render the kit's `.modal-bg` + `.modal` overlay
pattern (`Settings.jsx:203-280`). Both helpers replace ad-hoc
`<dialog>` markup in Settings (and later RequestDetail per PLAN-037-7),
and ship a small `modal-overlay.js` module for dismissal behaviour.

## Acceptance Criteria

| ID    | Criterion |
|-------|-----------|
| AC-01 | New fragment `templates/fragments/modal.tsx` exports `<Modal>` and `<ConfirmModal>` FCs. The file does **not** delete the existing `confirm-modal.tsx` (which is the typed-reject modal); it adds overlay-styled variants. |
| AC-02 | `<Modal title body eyebrow? wide? footer?>` renders `<div class="modal-bg" data-modal-overlay><div class={"modal" + (wide ? " modal-wide" : "")}><div class="modal-head"><div>{eyebrow && <div class="modal-eyebrow">{eyebrow}</div>}<h3>{title}</h3></div><button class="modal-close" data-modal-close>✕</button></div>{body}{footer && <div class="modal-foot">{footer}</div>}</div></div>`. |
| AC-03 | `<ConfirmModal title body confirmLabel cancelLabel="Cancel" hxPost? danger?>` is a thin wrapper around `<Modal>` with a fixed footer of `<button class="btn sm" data-modal-close>{cancelLabel}</button><button class={"btn sm " + (danger ? "destructive" : "primary")} hx-post={hxPost} hx-target="#modal-slot" hx-swap="outerHTML">{confirmLabel}</button>`. |
| AC-04 | `views/settings.tsx` adds `<div id="modal-slot"></div>` as a sibling of the panel grid (hoisted top-level per SPEC-036-4-01 AC-05) so HTMX swaps land there. |
| AC-05 | New module `server/static/js/modal-overlay.js` attaches global listeners that close any element matching `[data-modal-overlay]` when (a) the user clicks the backdrop itself (not a `.modal` child), (b) the user clicks `[data-modal-close]`, or (c) `Escape` is pressed while a modal is open. "Close" means removing the overlay node from the DOM. |
| AC-06 | The module rebinds on `htmx:afterSwap` so newly swapped modals get listeners. |
| AC-07 | The helper is consumed by SPEC-037-5-04 (Install plugin), SPEC-037-5-05 (Edit standard), and PLAN-037-7 (RequestDetail artifact viewer). The Agents Inspect modal in PLAN-037-5 Task 5 also adopts this helper. |
| AC-08 | KillSwitch and the existing typed `<ConfirmModal>` (`fragments/confirm-modal.tsx`) keep their current `<dialog>` markup — they are explicitly out of scope to avoid regression; documented in module file header. |

## Implementation

- File: `server/templates/fragments/modal.tsx` exporting:

  ```tsx
  export const Modal: FC<{
    title: string; body: any; eyebrow?: string;
    wide?: boolean; footer?: any;
  }> = (...) => (...);

  export const ConfirmModal: FC<{
    title: string; body: any; confirmLabel: string;
    cancelLabel?: string; hxPost: string; danger?: boolean;
  }> = (...) => (...);
  ```

- File: `server/static/js/modal-overlay.js`. Pseudocode:

  ```js
  document.addEventListener('click', e => {
    const overlay = e.target.closest('[data-modal-overlay]');
    if (!overlay) return;
    const close = e.target.closest('[data-modal-close]');
    if (close || e.target === overlay) overlay.remove();
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    document.querySelectorAll('[data-modal-overlay]').forEach(n => n.remove());
  });
  ```

- Wire the module via a `<script src="/static/js/modal-overlay.js" defer>` tag in the shared layout (`ShellLayout`) so every page benefits.
- The helper does NOT include built-in focus trapping in this spec; that is a follow-up (track as `data-todo="modal-focus-trap"` on `[data-modal-overlay]`).

## Tests

- **Snapshot (`tests/snapshot/modal-helper.test.ts`)**: render `<Modal title="Foo" body={<p>x</p>} wide eyebrow="EYE" footer={<button>Go</button>}/>` and assert structure (`.modal-bg > .modal.modal-wide > .modal-head .modal-eyebrow / h3, .modal-close, …, .modal-foot`).
- **Snapshot (`tests/snapshot/confirm-modal-overlay.test.ts`)**: assert `<ConfirmModal danger>` emits a `.btn.sm.destructive` confirm button and `hx-post` carries through.
- **Clientside (`tests/clientside/modal-overlay.test.ts`)**: jsdom — mount a `data-modal-overlay`, click the backdrop → removed; mount another, click a child `.modal` → still present; press Escape → removed.

## Verification

- `bun test tests/snapshot/modal-helper.test.ts tests/snapshot/confirm-modal-overlay.test.ts tests/clientside/modal-overlay.test.ts` passes.
- Manual smoke: open `/settings`, trigger any helper-consumer (Install plugin, Edit standard, Inspect agent); observe overlay, backdrop click closes, ESC closes, ✕ button closes.
