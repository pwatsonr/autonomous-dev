// SPEC-035-3-01 §KillSwitch — three-state Hono JSX primitive (idle / armed /
// engaged). Stateless, render-only. The server-side state machine
// (SPEC-035-3-02..04) is authoritative; transitions happen via HTMX
// `outerHTML` swaps so this component carries no client-side state.
//
// SAFETY-CRITICAL: this primitive is the operator's last-resort UI.
//   - No <script>, no inline event handlers, no on*= attributes.
//   - All transitions are server-driven; no fetch / no client mutation.
//   - The armed state always emits a `_csrf` hidden input (even if empty)
//     so the CSRF middleware (server/security/csrf-protection.ts) can
//     enforce a 403 on a tampered/missing token rather than silently
//     accepting a malformed POST.
//
// CSS lives in static/portal.css under .ks-panel / .ks-panel.armed /
// .ks-panel.ks-error per TDD-035 §6.5.7 v1.1.
//
// Acceptance criteria coverage:
//   AC-1 (idle render)         → idle branch
//   AC-2 (armed render)        → armed branch + hidden inputs + label/input pairing
//   AC-3 (engaged render)      → engaged branch + reset form, no engage button
//   AC-4 (failure-path safety) → empty-string fallback for csrfToken/armedAt
//   AC-5 (stateless purity)    → pure FC, props-only branching
//   AC-6 (visual treatment)    → CSS classes only; no inline styles

import type { FC } from "hono/jsx";

export interface KillSwitchProps {
    /** True when the daemon-side kill switch is currently engaged. */
    engaged: boolean;
    /** Base URL for confirm POST; reset POST is `${onConfirm}/reset`. */
    onConfirm: string;
    /** True when the operator has armed the engage flow but not confirmed. */
    armed?: boolean;
    /** Server-minted ISO-8601 timestamp from GET /ops/kill-switch-modal?step=arm. */
    armedAt?: string;
    /** CSRF token from c.get("csrfToken"); empty string fallback is intentional. */
    csrfToken?: string;
}

/**
 * SPEC-035-3-01 — KillSwitch primitive.
 *
 * Branches strictly on (engaged, armed):
 *   engaged === true               → engaged fragment (chip err + reset form)
 *   engaged === false && armed     → armed fragment (typed-CONFIRM form)
 *   otherwise                       → idle fragment (engage button)
 *
 * FR-10: when `engaged === true` the destructive engage button MUST NOT
 * render — the only available action on an engaged switch is reset.
 */
export const KillSwitch: FC<KillSwitchProps> = ({
    engaged,
    onConfirm,
    armed,
    armedAt,
    csrfToken,
}) => {
    // FR-6: csrfToken / armedAt fall back to "" so the form is structurally
    // complete; downstream csrfMiddleware rejects empty values with 403
    // rather than the form silently dropping a hidden input.
    const csrf = csrfToken ?? "";
    const armedAtValue = armedAt ?? "";

    if (engaged === true) {
        // ENGAGED — FR-4 / AC-3. Only the reset action is reachable.
        return (
            <div class="ks-panel">
                <div class="ks-status">
                    <h4>
                        Kill switch <span class="chip err">ENGAGED</span>
                    </h4>
                    <div class="meta">All daemon processing halted.</div>
                </div>
                <div class="ks-action">
                    <form method="POST" action={`${onConfirm}/reset`}>
                        <input type="hidden" name="_csrf" value={csrf} />
                        <button class="btn" type="submit">
                            Reset kill switch
                        </button>
                    </form>
                </div>
            </div>
        );
    }

    if (armed === true) {
        // ARMED — FR-3 / FR-9 / AC-2. Typed-CONFIRM gate.
        return (
            <div class="ks-panel armed">
                <div class="ks-status">
                    <h4>
                        Kill switch <span class="chip warn">ARMED</span>
                    </h4>
                    <div class="meta">
                        Type <code>CONFIRM</code> to halt the daemon. Window
                        expires in 30 seconds.
                    </div>
                </div>
                <div class="ks-action">
                    <form
                        hx-post={onConfirm}
                        hx-target="closest .ks-panel"
                        hx-swap="outerHTML"
                        method="POST"
                        action={onConfirm}
                    >
                        <input type="hidden" name="_csrf" value={csrf} />
                        <input
                            type="hidden"
                            name="armed_at"
                            value={armedAtValue}
                        />
                        <label
                            class="ks-confirm-label"
                            for="ks-confirm-input"
                        >
                            Type CONFIRM (case-sensitive)
                        </label>
                        <input
                            id="ks-confirm-input"
                            type="text"
                            name="confirmation"
                            class="input mono"
                            pattern="CONFIRM"
                            autocomplete="off"
                            required
                        />
                        <button class="btn destructive" type="submit">
                            Confirm engage
                        </button>
                    </form>
                    <button
                        class="btn"
                        type="button"
                        hx-get="/ops/kill-switch-modal"
                        hx-target="closest .ks-panel"
                        hx-swap="outerHTML"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        );
    }

    // IDLE — FR-2 / AC-1. HTMX GET arms the modal; outerHTML swap replaces
    // this `.ks-panel` with the armed fragment from the GET handler.
    return (
        <div class="ks-panel">
            <div class="ks-status">
                <h4>
                    Kill switch <span class="chip ok">DISENGAGED</span>
                </h4>
                <div class="meta">Daemon processing nominal.</div>
            </div>
            <div class="ks-action">
                <button
                    class="btn destructive"
                    type="button"
                    hx-get={`${onConfirm}?step=arm`}
                    hx-target="closest .ks-panel"
                    hx-swap="outerHTML"
                >
                    Engage kill switch
                </button>
            </div>
        </div>
    );
};
