// settings-autosave.js — optimistic auto-save for settings forms.
//
// Operator directive (crawl p9): "it should auto save instead of waiting
// for you to click save — assume it saved, tell the user if it did not."
//
// Contract: any <form data-autosave> auto-submits (debounced 400ms)
// whenever a control inside it fires `change` (selects/checkboxes:
// immediate on toggle; text inputs: on blur or Enter). htmx picks up the
// form's hx-post exactly as a manual submit would. Success stays quiet
// apart from the server's inline SAVED chip; failures surface loudly via
// the global htmx-error-feedback banner.
(function () {
    "use strict";

    var timers = new WeakMap();

    function schedule(form) {
        var t = timers.get(form);
        if (t) clearTimeout(t);
        timers.set(
            form,
            setTimeout(function () {
                timers.delete(form);
                if (typeof form.requestSubmit === "function") {
                    form.requestSubmit();
                } else {
                    form.submit();
                }
            }, 400),
        );
    }

    document.addEventListener(
        "change",
        function (e) {
            var el = e.target;
            if (!el || !el.closest) return;
            if (el.matches("[data-no-autosave]")) return;
            var form = el.closest("form[data-autosave]");
            if (form) schedule(form);
        },
        true,
    );
})();
