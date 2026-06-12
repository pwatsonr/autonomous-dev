// SPEC-015-2-04 §Confirmation Modal
// SPEC-034-2-05 §Voice/copy sweep — heading is sentence case ("Confirm
// rejection"); the typed phrase and the cost value render in mono via
// `<code>` per TDD-034 §5.6 IDs-in-mono rule.
//
// Hono JSX fragment for the typed-CONFIRM modal markup. The modal lives
// hidden in the page DOM at all times; static/js/gate-confirmation.js
// flips its `hidden` attribute and wires the input/cancel/submit listeners
// when the gate panel dispatches `gate:requires-confirm`.
//
// Markup contract (consumed by gate-confirmation.js):
//   - Root id = "confirm-modal" with `hidden`, role="dialog", aria-modal="true".
//   - Backdrop element carries data-dismiss="true" so the script knows to
//     close on backdrop click without a dedicated handler per page.
//   - Title id = "confirm-modal-title" referenced via aria-labelledby.
//   - Body slots filled at runtime: #confirm-modal-request-title,
//     #confirm-modal-cost, #confirm-modal-typed-text.
//   - Input id = "confirm-modal-input"; submit button id =
//     "confirm-modal-submit" (starts disabled).
//   - Cancel button id = "confirm-modal-cancel".
//
// Default phrase shown is "REJECT". The script may rewrite the
// data-required-text attribute for other actions, but spec 04 only uses
// REJECT for high-cost reject.

import type { FC } from "hono/jsx";

interface Props {
    /** Override the default required phrase. Defaults to "REJECT". */
    requiredText?: string;
}

export const ConfirmModal: FC<Props> = ({ requiredText = "REJECT" }) => (
    <div
        id="confirm-modal"
        class="modal"
        hidden
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        data-required-text={requiredText}
    >
        <div class="modal-backdrop" data-dismiss="true"></div>
        <div class="modal-content">
            <h3 id="confirm-modal-title">Confirm rejection</h3>
            <p class="modal-body">
                You are rejecting{" "}
                <strong id="confirm-modal-request-title"></strong> with cost{" "}
                <code id="confirm-modal-cost" class="mono"></code>.
            </p>
            <p>
                Type <code id="confirm-modal-typed-text">{requiredText}</code>{" "}
                to confirm:
            </p>
            <input
                type="text"
                id="confirm-modal-input"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck={false}
                aria-describedby="confirm-modal-help"
            />
            <p id="confirm-modal-help" class="modal-help">
                This action cannot be undone.
            </p>
            <div class="modal-actions">
                <button id="confirm-modal-cancel" type="button">
                    Cancel
                </button>
                <button
                    id="confirm-modal-submit"
                    type="button"
                    disabled
                    class="btn destructive"
                >
                    Reject
                </button>
            </div>
        </div>
    </div>
);
