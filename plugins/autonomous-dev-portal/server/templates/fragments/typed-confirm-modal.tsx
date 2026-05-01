// SPEC-015-4-01 §typed-confirm-modal — Hono JSX fragment for the
// destructive-action confirmation modal used by the /ops dashboard.
//
// Markup contract (consumed by static/js/ops-confirm.js):
//   - Root id `ops-confirm-modal` with role="dialog", aria-modal="true",
//     `hidden` attribute toggled by JS.
//   - Form action populated from the trigger's `data-confirm-action`.
//   - Hidden input `confirmationToken` populated when the operator first
//     clicks an action (the script POSTs /ops/confirm-token to fetch one).
//   - Visible input `typedPhrase` — the operator must type the
//     server-issued phrase (case-sensitive, no trim).
//   - Submit button starts disabled; the script enables it when
//     `typedPhrase.value === requiredPhrase`.

import type { FC } from "hono/jsx";

interface Props {
    /**
     * Default phrase shown to the operator. The runtime script overrides
     * this by reading the server response from /ops/confirm-token.
     */
    requiredPhrase?: string;
}

export const TypedConfirmModal: FC<Props> = ({ requiredPhrase = "CONFIRM" }) => (
    <div
        id="ops-confirm-modal"
        class="modal ops-confirm-modal"
        hidden
        role="dialog"
        aria-modal="true"
        aria-labelledby="ops-confirm-modal-title"
        data-required-phrase={requiredPhrase}
    >
        <div class="modal-backdrop" data-dismiss="true"></div>
        <div class="modal-content">
            <h3 id="ops-confirm-modal-title">Confirm destructive action</h3>
            <p class="modal-body">
                You are about to{" "}
                <strong id="ops-confirm-modal-action-label">
                    perform a destructive action
                </strong>
                . This cannot be undone.
            </p>
            <p>
                Type{" "}
                <code id="ops-confirm-modal-required-phrase">
                    {requiredPhrase}
                </code>{" "}
                exactly to proceed:
            </p>
            <form
                id="ops-confirm-modal-form"
                method="post"
                action=""
                novalidate
            >
                <input
                    type="hidden"
                    name="confirmationToken"
                    id="ops-confirm-modal-token"
                    value=""
                />
                <label class="visually-hidden" for="ops-confirm-modal-input">
                    Confirmation phrase
                </label>
                <input
                    type="text"
                    name="typedPhrase"
                    id="ops-confirm-modal-input"
                    autocomplete="off"
                    autocorrect="off"
                    autocapitalize="off"
                    spellcheck={false}
                    aria-describedby="ops-confirm-modal-help"
                />
                <p id="ops-confirm-modal-help" class="modal-help">
                    Confirmation tokens expire 60 seconds after issue.
                </p>
                <div class="modal-actions">
                    <button
                        id="ops-confirm-modal-cancel"
                        type="button"
                        data-dismiss="true"
                    >
                        Cancel
                    </button>
                    <button
                        id="ops-confirm-modal-submit"
                        type="submit"
                        disabled
                        class="btn-danger"
                    >
                        Confirm
                    </button>
                </div>
            </form>
        </div>
    </div>
);
