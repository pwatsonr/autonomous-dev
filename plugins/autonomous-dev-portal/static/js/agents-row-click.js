// PLAN-038 polish — Agents-surface row click handler.
//
// CSP policy disallows inline `onclick` attributes (script-src 'self' +
// nonce only). Delegated click listener on the agents table body opens
// the inspect modal by fetching the modal HTML fragment and injecting
// it into #modal-slot.

(function () {
    "use strict";

    function loadInspectModal(agentName) {
        var slot = document.getElementById("modal-slot");
        if (!slot) {
            return;
        }
        fetch("/agents/" + encodeURIComponent(agentName) + "/inspect-modal")
            .then(function (r) {
                if (!r.ok) {
                    throw new Error("inspect-modal " + r.status);
                }
                return r.text();
            })
            .then(function (html) {
                slot.innerHTML = html;
                // Re-process the new DOM so HTMX wires up the modal's
                // action buttons (hx-post, hx-swap, hx-on, etc.).
                if (typeof window.htmx !== "undefined") {
                    window.htmx.process(slot);
                }
            })
            .catch(function (err) {
                // Fail open — no modal is better than a broken page.
                console.warn("inspect-modal load failed", err);
            });
    }

    function onAgentRowClick(event) {
        var row = event.target.closest("[data-agent]");
        if (!row) {
            return;
        }
        var name = row.getAttribute("data-agent");
        if (!name) {
            return;
        }
        loadInspectModal(name);
    }

    function onAgentRowKey(event) {
        if (event.key !== "Enter" && event.key !== " ") {
            return;
        }
        var row = event.target.closest("[data-agent]");
        if (!row) {
            return;
        }
        event.preventDefault();
        var name = row.getAttribute("data-agent");
        if (name) {
            loadInspectModal(name);
        }
    }

    document.addEventListener("click", onAgentRowClick);
    document.addEventListener("keydown", onAgentRowKey);
})();
