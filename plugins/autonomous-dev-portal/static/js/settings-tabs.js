/* SPEC-036-4-02 §Settings Tabs JS Module — vanilla JS deep-link mechanism.
 *
 * Reads the server-rendered `data-active-tab` attribute on the
 * `.seg.seg-tabs` nav at `DOMContentLoaded`, binds tab-button click
 * handlers that update the URL via `history.pushState`, and listens for
 * `popstate` so browser back/forward restore the right tab without a
 * page reload. The server is the source of truth for the *initial* tab;
 * this module owns *transitions*.
 *
 * Idempotency: the `dataset.bound` sentinel on the nav element ensures
 * double-loading the script does not double-bind handlers.
 *
 * SPEC-036-4-02 AC-07 — never interacts with HTMX URL management;
 * tab clicks fire `pushState` but never trigger `hx-push-url`.
 */

(function () {
    "use strict";

    function showTab(tabId) {
        document.querySelectorAll(".seg-btn").forEach(function (btn) {
            btn.classList.toggle("on", btn.dataset.tab === tabId);
            btn.setAttribute(
                "aria-selected",
                btn.dataset.tab === tabId ? "true" : "false",
            );
        });
        document.querySelectorAll("[data-tab-panel]").forEach(function (panel) {
            panel.hidden = panel.dataset.tabPanel !== tabId;
        });
    }

    function init() {
        var nav = document.querySelector(".seg.seg-tabs");
        if (!nav || nav.dataset.bound === "1") return;
        nav.dataset.bound = "1";

        var initialTab = nav.dataset.activeTab || "general";
        showTab(initialTab);

        nav.querySelectorAll(".seg-btn").forEach(function (btn) {
            btn.addEventListener("click", function () {
                var tabId = btn.dataset.tab;
                if (!tabId) return;
                showTab(tabId);
                try {
                    history.pushState({}, "", "?tab=" + tabId);
                } catch (_e) {
                    /* no-op — pushState is best-effort */
                }
            });
        });

        window.addEventListener("popstate", function () {
            var params = new URLSearchParams(location.search);
            showTab(params.get("tab") || "general");
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    // Export for test harnesses (jsdom). When loaded as a regular
    // script in a browser, `window.__settingsTabs` is purely additive.
    if (typeof window !== "undefined") {
        window.__settingsTabs = { showTab: showTab, init: init };
    }
})();
