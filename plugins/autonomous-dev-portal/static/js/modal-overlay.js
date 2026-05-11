/* SPEC-037-5-06 §Shared Modal Overlay JS Module — vanilla JS dismissal
 * helper for the kit's `.modal-bg` + `.modal` overlay pattern emitted by
 * `templates/fragments/modal.tsx`.
 *
 * Scope:
 *   - Closes overlays on (a) backdrop click (target IS `.modal-bg`),
 *     (b) `[data-modal-close]` click (typically the ✕ or a Cancel button),
 *     (c) `Escape` keypress while any overlay is open.
 *   - Re-binds on `htmx:afterSwap` so newly swapped overlays inherit the
 *     listeners (the listeners are document-level + delegated, so the
 *     rebind is a no-op except as documentation).
 *
 * Explicitly out of scope (SPEC-037-5-06 AC-08):
 *   - KillSwitch + the typed-reject `<ConfirmModal>` in
 *     fragments/confirm-modal.tsx use the legacy `<dialog>` pattern.
 *     This module never touches `<dialog>` markup, so those modals are
 *     unaffected.
 *
 * Focus-trapping is intentionally deferred; the helper emits the
 * `data-todo="modal-focus-trap"` attribute as a future-work marker.
 *
 * Idempotency: the document.dataset.modalOverlayBound sentinel keeps a
 * second script load (or test re-import) from double-binding listeners.
 */

(function () {
    "use strict";

    function closeOverlay(node) {
        if (node && node.parentNode) node.parentNode.removeChild(node);
    }

    function onClick(e) {
        var overlay = e.target.closest && e.target.closest("[data-modal-overlay]");
        if (!overlay) return;
        var closer = e.target.closest && e.target.closest("[data-modal-close]");
        if (closer || e.target === overlay) {
            closeOverlay(overlay);
        }
    }

    function onKeydown(e) {
        if (e.key !== "Escape") return;
        var overlays = document.querySelectorAll("[data-modal-overlay]");
        if (overlays.length === 0) return;
        overlays.forEach(function (n) {
            closeOverlay(n);
        });
    }

    function init() {
        // Document-level delegated listeners — newly swapped overlays
        // are picked up for free. `htmx:afterSwap` is wired only for
        // symmetry with the rest of the kit modules.
        if (document.documentElement.dataset.modalOverlayBound === "1") return;
        document.documentElement.dataset.modalOverlayBound = "1";
        document.addEventListener("click", onClick);
        document.addEventListener("keydown", onKeydown);
        document.addEventListener("htmx:afterSwap", function () {
            // Listeners are delegated at document; nothing to rebind.
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    if (typeof window !== "undefined") {
        window.__modalOverlay = {
            init: init,
            closeOverlay: closeOverlay,
            _onClick: onClick,
            _onKeydown: onKeydown,
        };
    }
})();
