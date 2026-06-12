// Global CSRF header injection for HTMX requests.
//
// The CSRF enforcer's canonical input is the X-CSRF-Token header (body
// `_csrf` is a fallback for plain forms). Individual hx-post buttons kept
// missing their per-button `hx-include` wiring (#391: approvals; rd-v3
// gate panel; the notification Test buttons), each failing 403 silently
// until the error banner surfaced them. This hook reads the per-request
// token from `<meta name="csrf-token">` (emitted by the shell) and
// attaches it to EVERY htmx request, fixing the class once.
//
// CSP-safe: external file, nonce-tagged script tag, no eval.
(function () {
    "use strict";

    function token() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute("content") || "" : "";
    }

    function onConfigRequest(event) {
        var t = token();
        if (t && !event.detail.headers["X-CSRF-Token"]) {
            event.detail.headers["X-CSRF-Token"] = t;
        }
    }

    function init() {
        document.body.addEventListener("htmx:configRequest", onConfigRequest);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
