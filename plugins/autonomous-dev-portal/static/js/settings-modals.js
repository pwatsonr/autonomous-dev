/* SPEC-036-4-07 §settings-modals.js — generic open/close handler for the
 * native `<dialog>` elements hoisted to top-level main siblings.
 *
 * Bindings:
 *   - `[data-modal-open="<id>"]` — clicking calls `showModal()` on the
 *     dialog with the matching id.
 *   - `[data-modal-close]` inside a dialog — clicking calls
 *     `dialog.close()`. ESC and backdrop dismiss are native browser
 *     behavior; no JS required.
 *   - `[data-confirm]` — when present on an action `<button>`, opens a
 *     confirmation prompt (native `window.confirm` fallback when no
 *     pre-rendered modal exists). The Promote/Shadow/Freeze flow uses
 *     this to gate the POST.
 *
 * Idempotent via `document.body.dataset.modalsBound`.
 */

(function () {
    "use strict";

    function openHandler(event) {
        var btn = event.target.closest("[data-modal-open]");
        if (!btn) return;
        var id = btn.getAttribute("data-modal-open");
        if (!id) return;
        var dialog = document.getElementById(id);
        if (!dialog) return;
        if (typeof dialog.showModal === "function") {
            dialog.showModal();
        } else {
            // jsdom / older browsers: fall back to the `open` attribute.
            dialog.setAttribute("open", "");
        }
    }

    function closeHandler(event) {
        var btn = event.target.closest("[data-modal-close]");
        if (!btn) return;
        var dialog = btn.closest("dialog");
        if (!dialog) return;
        if (typeof dialog.close === "function") {
            dialog.close();
        } else {
            dialog.removeAttribute("open");
        }
    }

    function confirmHandler(event) {
        var btn = event.target.closest("[data-confirm]");
        if (!btn) return;
        // If this button is inside a form intended to submit, intercept
        // the click and gate it on confirmation. Skip when already
        // confirmed (we re-fire the click with a sentinel attribute).
        if (btn.dataset.confirmed === "1") {
            btn.removeAttribute("data-confirmed");
            return;
        }
        var msg = btn.getAttribute("data-confirm");
        if (!msg) return;
        event.preventDefault();
        event.stopPropagation();
        var ok = false;
        try {
            ok = window.confirm(msg);
        } catch (_e) {
            ok = false;
        }
        if (ok) {
            btn.dataset.confirmed = "1";
            btn.click();
        }
    }

    function init() {
        if (
            document.body &&
            document.body.dataset.modalsBound === "1"
        ) {
            return;
        }
        if (document.body) {
            document.body.dataset.modalsBound = "1";
        }
        document.addEventListener("click", openHandler);
        document.addEventListener("click", closeHandler);
        // Confirm gate must run before HTMX submits the form, so use
        // capture phase.
        document.addEventListener("click", confirmHandler, true);
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", init);
        } else {
            init();
        }
    }

    if (typeof window !== "undefined") {
        window.__settingsModals = { init: init };
    }
})();
