// SPEC-036-3-03 §Phase artifact modal — vanilla-JS click → showModal().
//
// Loaded only on the request-detail route. Listens for clicks on
// `.pipe-step` elements and opens the matching `<dialog
// id="artifact-modal-${phase}">`. Backdrop click + Escape are native
// <dialog> behavior; we additionally wire `[data-dismiss="true"]` close
// buttons inside any open dialog.

(function () {
    "use strict";

    function onPipeStepClick(event) {
        var target = event.target;
        // Walk up to find the .pipe-step (clicks may land on inner spans).
        while (target && target !== document.body) {
            if (target.classList && target.classList.contains("pipe-step")) {
                break;
            }
            target = target.parentNode;
        }
        if (!target || target === document.body) return;
        var phase = target.getAttribute("data-phase");
        if (!phase) return;
        var dialog = document.getElementById("artifact-modal-" + phase);
        if (dialog && typeof dialog.showModal === "function") {
            dialog.showModal();
        }
    }

    function onDialogClick(event) {
        var t = event.target;
        if (t && t.getAttribute && t.getAttribute("data-dismiss") === "true") {
            var dialog = t.closest("dialog");
            if (dialog && typeof dialog.close === "function") {
                dialog.close();
            }
        }
    }

    function init() {
        document.addEventListener("click", function (event) {
            onPipeStepClick(event);
            onDialogClick(event);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
