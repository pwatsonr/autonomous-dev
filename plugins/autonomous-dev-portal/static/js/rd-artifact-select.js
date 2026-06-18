// #499 — Request Detail artifact-index selection highlight.
//
// CSP policy disallows inline onclick / hx-on (script-src 'self' + nonce
// only), so the "which artifact row is currently shown in the pane" visual
// state is managed here via a delegated click listener.
//
// When an artifact row (a [data-artifact-row] button) is clicked, HTMX
// already swaps the artifact pane (hx-get/hx-target). This handler only
// updates the selected styling: it clears `.selected` / aria-pressed from
// every artifact row and applies it to the clicked one. It is purely
// presentational — if this script fails to load, the pane still swaps; the
// only loss is the highlight, so it fails open.
//
// Re-binding is unnecessary because the listener is delegated on document
// and the artifact index itself is not swapped by the phase interactions.

(function () {
    "use strict";

    function clearSelected() {
        var rows = document.querySelectorAll("[data-artifact-row]");
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.remove("selected");
            rows[i].setAttribute("aria-pressed", "false");
        }
    }

    function onClick(event) {
        var row = event.target.closest("[data-artifact-row]");
        if (!row) {
            return;
        }
        clearSelected();
        row.classList.add("selected");
        row.setAttribute("aria-pressed", "true");
    }

    document.addEventListener("click", onClick);
})();
