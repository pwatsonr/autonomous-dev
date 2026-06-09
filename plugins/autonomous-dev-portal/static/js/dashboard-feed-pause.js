// FR-026 — Dashboard "Pause feed" toggle handler.
//
// CSP policy disallows inline `onclick` attributes (script-src 'self' +
// nonce only). Delegated click listener on the topbar toggle button sets /
// removes a `data-paused` attribute on `#dashboard-body`.
//
// The HTMX polling trigger on `#dashboard-body` checks for the attribute
// and suppresses the auto-refresh while the feed is paused:
//
//   hx-trigger="every 10s [... && !document.querySelector('#dashboard-body[data-paused]')]"
//
// The button label flips between "Pause feed" and "Resume feed" and the
// aria-pressed state is updated to reflect the new state.

(function () {
    "use strict";

    function onPauseButtonClick(event) {
        var btn = event.target.closest("[data-pause-feed]");
        if (!btn) {
            return;
        }
        var body = document.getElementById("dashboard-body");
        if (!body) {
            return;
        }
        var isPaused = body.hasAttribute("data-paused");
        if (isPaused) {
            body.removeAttribute("data-paused");
            btn.setAttribute("aria-pressed", "false");
            btn.textContent = "Pause feed";
        } else {
            body.setAttribute("data-paused", "");
            btn.setAttribute("aria-pressed", "true");
            btn.textContent = "Resume feed";
        }
    }

    document.addEventListener("click", onPauseButtonClick);
})();
