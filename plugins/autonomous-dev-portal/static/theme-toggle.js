// SPEC-034-1-05 — Theme switcher (vanilla JS IIFE).
// SPEC-037-1-03 — Adds a delegated `[data-action="toggle-theme"]` click
// handler bound to `document`, so the pill rendered by SPEC-037-1-02 in
// `.rail-ops` toggles the theme without inline onclick (CSP-safe) and
// works across HTMX swaps. Cookie key remains `portal-theme`; the kit's
// `autodev-theme` key is intentionally NOT adopted to preserve the
// SPEC-034-1-05 storage contract already shipped to users.
//
// Provides:
//   1. An on-load IIFE that reads `localStorage.getItem("portal-theme")` and
//      sets `document.documentElement.dataset.theme = stored || "dark"`
//      (SPEC-037-1-01 default).
//   2. A globally exposed `setTheme(t)` function that updates localStorage,
//      sets the `data-theme` attribute on <html>, and writes a `portal-theme`
//      cookie (path=/, max-age=31536000, SameSite=Lax) so the server-side
//      shadow (see lib/theme.ts) can pre-render the same theme on the next
//      request, eliminating flash-of-unstyled-content on full reloads.
//   3. A delegated click handler on `document` that matches
//      `[data-action="toggle-theme"]` and flips both `data-theme` and the
//      pill's inner `.tt-track` light/dark class so the knob animates.
//
// ---------------------------------------------------------------------------
// FOUC-PREVENTION INLINE IIFE — for SPEC-034-1-06 layout integration
// ---------------------------------------------------------------------------
// The block below is the canonical source for the synchronous, blocking,
// inline <head> script that MUST be embedded directly in `base.tsx` (NOT
// loaded as an external file) so it executes BEFORE first paint. SPEC-034-1-06
// is responsible for wiring this into the layout.
//
// Inline this exact body inside <script nonce={cspNonce}>...</script> at the
// very top of <head> (before stylesheets is fine; before any other scripts
// is required):
//
//   (function () {
//     try {
//       var t = localStorage.getItem("portal-theme");
//       document.documentElement.setAttribute(
//         "data-theme",
//         t === "dark" ? "dark" : "light"
//       );
//     } catch (e) {
//       document.documentElement.setAttribute("data-theme", "light");
//     }
//   })();
//
// Constraints (from TDD-034 §5.3.2 / SPEC-034-1-05 AC-08):
//   - MUST be inline (not <script src=...>) so it runs synchronously.
//   - MUST NOT carry `defer` or `async`.
//   - MUST tolerate Safari private mode / disabled storage via try/catch.
//   - MUST default to "light" on missing key, parse failure, or non-"dark"
//     value (only the literal string "dark" is accepted as non-default).
// ---------------------------------------------------------------------------

(function () {
    "use strict";

    var STORAGE_KEY = "portal-theme";
    var COOKIE_NAME = "portal-theme";
    var COOKIE_MAX_AGE = 31536000; // 1 year in seconds.

    function readStoredTheme() {
        try {
            var v = localStorage.getItem(STORAGE_KEY);
            // SPEC-037-1-01 — only the literal "light" returns "light"; any
            // other value (missing, "dark", tampered) defaults to "dark".
            return v === "light" ? "light" : "dark";
        } catch (e) {
            return "dark";
        }
    }

    function applyTheme(theme) {
        var t = theme === "light" ? "light" : "dark";
        if (
            typeof document !== "undefined" &&
            document.documentElement &&
            document.documentElement.dataset
        ) {
            document.documentElement.dataset.theme = t;
        }
        return t;
    }

    function writeCookie(theme) {
        try {
            document.cookie =
                COOKIE_NAME +
                "=" +
                encodeURIComponent(theme) +
                ";path=/;max-age=" +
                COOKIE_MAX_AGE +
                ";SameSite=Lax";
        } catch (e) {
            // Best-effort: cookie write failure is non-fatal because the
            // client-side IIFE will still apply the theme on next load via
            // localStorage. SSR shadow simply won't match until cookies work.
        }
    }

    function setTheme(theme) {
        var t = theme === "light" ? "light" : "dark";
        try {
            localStorage.setItem(STORAGE_KEY, t);
        } catch (e) {
            // Storage unavailable (Safari private mode, quota, disabled).
            // We still update the DOM and cookie below so the current page
            // and the next SSR render reflect the choice.
        }
        applyTheme(t);
        writeCookie(t);
        return t;
    }

    // Initial application — runs as soon as this script is parsed. Note:
    // because this file is loaded as an external <script>, the inline FOUC
    // IIFE documented above is what actually prevents the flash on first
    // paint. This block is the redundant, idempotent sync fallback.
    applyTheme(readStoredTheme());

    // Expose setTheme globally so toggle UI elements (e.g. a #theme-toggle
    // button rendered by the layout) can call it directly via onclick or
    // delegated handlers.
    if (typeof window !== "undefined") {
        window.setTheme = setTheme;
    }

    // SPEC-037-1-03 — Delegated click handler for the theme-toggle pill.
    //
    // Bound to `document` (not the button) so:
    //   - HTMX swaps that re-render `.rail-ops` keep working without
    //     re-registering listeners.
    //   - We only ever attach ONE handler regardless of how many pills
    //     are on the page (there's only one today, but cheap defence).
    //
    // On click: read the current `<html data-theme>`, compute the
    // opposite, call `setTheme(next)` (which updates DOM, localStorage,
    // and the cookie), then flip the `.tt-track.light`/`.tt-track.dark`
    // class so the knob CSS transition fires.
    function attachToggleHandler() {
        if (typeof document === "undefined") return;
        document.addEventListener("click", function (ev) {
            var target = ev.target;
            var btn =
                target && typeof target.closest === "function"
                    ? target.closest('[data-action="toggle-theme"]')
                    : null;
            if (!btn) return;
            // Defensive: the pill is `type="button"`, so the default
            // action is a no-op, but preventDefault keeps this handler
            // robust if the markup ever drifts (e.g. wrapped in a form).
            ev.preventDefault();
            var current =
                document.documentElement &&
                document.documentElement.dataset &&
                document.documentElement.dataset.theme === "light"
                    ? "light"
                    : "dark";
            var next = current === "dark" ? "light" : "dark";
            setTheme(next);
            var track = btn.querySelector(".tt-track");
            if (track && track.classList) {
                track.classList.remove("light", "dark");
                track.classList.add(next);
            }
        });
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", attachToggleHandler);
        } else {
            attachToggleHandler();
        }
    }
})();
