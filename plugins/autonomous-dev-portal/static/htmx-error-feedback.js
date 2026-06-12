// #391 — Global HTMX error feedback.
//
// HTMX does not swap on 4xx/5xx responses, so a failed action (e.g. a CSRF
// 403 on an approvals button) previously gave the operator ZERO feedback.
// This module listens for htmx:responseError / htmx:sendError and surfaces
// a dismissible banner at the top of the page. Loaded by the shell on every
// surface; CSP-safe (external file, nonce'd script tag, no eval).
(function () {
    "use strict";

    var BANNER_ID = "htmx-error-banner";

    function ensureBanner() {
        var el = document.getElementById(BANNER_ID);
        if (el) return el;
        el = document.createElement("div");
        el.id = BANNER_ID;
        el.setAttribute("role", "alert");
        el.style.cssText = [
            "position:fixed", "top:0", "left:0", "right:0", "z-index:9999",
            "padding:10px 16px", "background:#7f1d1d", "color:#fff",
            "font:13px/1.4 system-ui,sans-serif", "display:flex",
            "justify-content:space-between", "align-items:center",
        ].join(";");
        var msg = document.createElement("span");
        msg.className = "htmx-error-msg";
        var btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = "Dismiss";
        btn.style.cssText =
            "background:transparent;color:#fff;border:1px solid #fff;" +
            "border-radius:4px;padding:2px 10px;cursor:pointer;font:inherit";
        btn.addEventListener("click", function () { el.remove(); });
        el.appendChild(msg);
        el.appendChild(btn);
        document.body.appendChild(el);
        return el;
    }

    function show(text) {
        var el = ensureBanner();
        el.querySelector(".htmx-error-msg").textContent = text;
    }

    function onResponseError(evt) {
        var xhr = evt.detail && evt.detail.xhr;
        var status = xhr ? xhr.status : 0;
        var path = evt.detail && evt.detail.requestConfig
            ? evt.detail.requestConfig.path
            : "";
        var hint = status === 403
            ? " (forbidden — possible expired session/CSRF; reload the page)"
            : "";
        show("Action failed: HTTP " + status + " from " + path + hint);
    }

    function onSendError(evt) {
        var path = evt.detail && evt.detail.requestConfig
            ? evt.detail.requestConfig.path
            : "";
        show("Network error reaching " + path + " — is the portal/daemon up?");
    }

    function init() {
        document.body.addEventListener("htmx:responseError", onResponseError);
        document.body.addEventListener("htmx:sendError", onSendError);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
