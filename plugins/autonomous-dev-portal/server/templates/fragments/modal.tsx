// SPEC-037-5-06 §Shared Modal Overlay Helper.
//
// Two reusable Hono JSX helpers that render the kit's `.modal-bg` +
// `.modal` overlay pattern (`Settings.jsx:203-280`). They replace ad-hoc
// `<dialog>` markup in Settings (Install plugin, Edit standard, Inspect
// agent) and will be consumed by PLAN-037-7 RequestDetail artifact viewer.
//
// Scope notes:
//   - KillSwitch and the existing typed `<ConfirmModal>` in
//     `fragments/confirm-modal.tsx` keep their current `<dialog>` markup —
//     they are explicitly out of scope to avoid regression.
//   - This file does NOT delete the existing `confirm-modal.tsx` (typed
//     reject confirmation). It adds overlay-styled variants under
//     `Modal` + `ConfirmModal` (the latter is exported as
//     `OverlayConfirmModal` to avoid a symbol clash with the typed modal).
//   - Focus-trapping is intentionally deferred (`data-todo="modal-focus-
//     trap"` on the overlay root) per SPEC-037-5-06 implementation notes.

import type { FC } from "hono/jsx";
import { icon } from "../../lib/icons";

interface ModalProps {
    title: string;
    body: unknown;
    eyebrow?: string;
    wide?: boolean;
    footer?: unknown;
}

/**
 * SPEC-037-5-06 AC-02 — overlay modal.
 *
 * Markup contract (consumed by `static/js/modal-overlay.js`):
 *   - `.modal-bg[data-modal-overlay]` is the dismissal handle (click =
 *     close when target IS the backdrop).
 *   - `.modal-close[data-modal-close]` is the ✕ button.
 *   - `wide` flips the inner `.modal` to `.modal modal-wide`.
 */
export const Modal: FC<ModalProps> = ({
    title,
    body,
    eyebrow,
    wide,
    footer,
}) => (
    <div
        class="modal-bg"
        data-modal-overlay
        data-todo="modal-focus-trap"
    >
        <div class={wide ? "modal modal-wide" : "modal"}>
            <div class="modal-head">
                <div>
                    {eyebrow !== undefined ? (
                        <div class="modal-eyebrow">{eyebrow}</div>
                    ) : null}
                    <h3>{title}</h3>
                </div>
                <button
                    type="button"
                    class="modal-close"
                    data-modal-close
                    aria-label="Close"
                    dangerouslySetInnerHTML={{ __html: icon("x", 16) }}
                ></button>
            </div>
            {body}
            {footer !== undefined ? (
                <div class="modal-foot">{footer}</div>
            ) : null}
        </div>
    </div>
);

interface OverlayConfirmModalProps {
    title: string;
    body: unknown;
    confirmLabel: string;
    cancelLabel?: string;
    hxPost: string;
    danger?: boolean;
    eyebrow?: string;
    wide?: boolean;
}

/**
 * SPEC-037-5-06 AC-03 — thin wrapper around `<Modal>` with a fixed footer.
 *
 * Exported as `OverlayConfirmModal` (the file `confirm-modal.tsx` already
 * owns the unqualified `ConfirmModal` name for the typed-reject modal).
 * The spec text calls this `<ConfirmModal>`; the rename avoids the
 * symbol clash while keeping the helper's role explicit at the call site.
 */
export const OverlayConfirmModal: FC<OverlayConfirmModalProps> = ({
    title,
    body,
    confirmLabel,
    cancelLabel = "Cancel",
    hxPost,
    danger,
    eyebrow,
    wide,
}) => (
    <Modal
        title={title}
        eyebrow={eyebrow}
        wide={wide}
        body={body}
        footer={
            <>
                <button type="button" class="btn sm" data-modal-close>
                    {cancelLabel}
                </button>
                <button
                    type="button"
                    class={`btn sm ${danger ? "destructive" : "primary"}`}
                    hx-post={hxPost}
                    hx-target="#modal-slot"
                    hx-swap="outerHTML"
                >
                    {confirmLabel}
                </button>
            </>
        }
    />
);
