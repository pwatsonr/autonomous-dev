// SPEC-036-3-06 §Gate actions — typed-CONFIRM modal interception.
//
// Wires the three gate action buttons (Approve / Request Changes / Reject)
// to the shared ConfirmModal helper. Each click intercepts the HTMX
// request, opens the modal with action-specific copy, and only fires the
// HTMX request once the operator confirms. Escape + backdrop dismiss
// cancel the action without firing the request.
//
// CSRF: read once on DOMContentLoaded from `<meta name="csrf-token">` and
// attached to every HTMX request via `htmx:configRequest`. The button's
// `hx-headers` carries the token statically as well so requests fired
// before the listener attaches still authenticate.

(function () {
    "use strict";

    var COPY = {
        approve: {
            title: "Approve gate?",
            body:
                "This unblocks the request and resumes the active phase. " +
                "Reviewer findings will be marked acknowledged.",
            confirmLabel: "Approve",
            confirmKind: "primary",
        },
        "request-changes": {
            title: "Request changes?",
            body:
                "Send a short reason; the author will retry with this " +
                "feedback included in context.",
            confirmLabel: "Send",
            confirmKind: "secondary",
            withTextarea: true,
        },
        reject: {
            title: "Reject request?",
            body:
                "This rejects the request at the active phase. The action " +
                "cannot be undone.",
            confirmLabel: "Reject",
            confirmKind: "destructive",
        },
    };

    function csrfToken() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        return meta ? meta.getAttribute("content") || "" : "";
    }

    function ensureModal() {
        var existing = document.getElementById("gate-action-modal");
        if (existing) return existing;
        var dialog = document.createElement("dialog");
        dialog.id = "gate-action-modal";
        dialog.className = "modal gate-action-modal";
        dialog.setAttribute("aria-labelledby", "gate-action-modal-title");
        dialog.innerHTML =
            '<div class="modal-content">' +
            '<h3 id="gate-action-modal-title"></h3>' +
            '<p id="gate-action-modal-body" class="modal-body"></p>' +
            '<textarea id="gate-action-modal-reason" class="modal-input" ' +
            'placeholder="Reason..." hidden></textarea>' +
            '<div class="modal-actions">' +
            '<button type="button" id="gate-action-modal-cancel" ' +
            'data-dismiss="true">Cancel</button>' +
            '<button type="button" id="gate-action-modal-confirm" ' +
            'class="btn primary"></button>' +
            "</div>" +
            "</div>";
        document.body.appendChild(dialog);
        return dialog;
    }

    function findButton(target) {
        while (target && target !== document.body) {
            if (
                target.getAttribute &&
                target.getAttribute("data-gate-action") !== null
            ) {
                return target;
            }
            target = target.parentNode;
        }
        return null;
    }

    function onClick(event) {
        var button = findButton(event.target);
        if (!button) return;
        var action = button.getAttribute("data-gate-action");
        if (!action || !COPY[action]) return;

        // Intercept BEFORE HTMX fires its bubble-phase request.
        event.preventDefault();
        event.stopPropagation();

        var copy = COPY[action];
        var modal = ensureModal();
        var titleEl = modal.querySelector("#gate-action-modal-title");
        var bodyEl = modal.querySelector("#gate-action-modal-body");
        var reasonEl = modal.querySelector("#gate-action-modal-reason");
        var confirmBtn = modal.querySelector("#gate-action-modal-confirm");

        titleEl.textContent = copy.title;
        bodyEl.textContent = copy.body;
        reasonEl.hidden = !copy.withTextarea;
        reasonEl.value = "";
        confirmBtn.textContent = copy.confirmLabel;
        confirmBtn.className = "btn " + copy.confirmKind;

        function cleanup() {
            confirmBtn.removeEventListener("click", onConfirm);
            modal.removeEventListener("close", onClose);
            modal.removeEventListener("click", onBackdrop);
        }
        function onConfirm() {
            cleanup();
            // Attach the optional reason as a header so the existing HTMX
            // request can pick it up without a second form roundtrip.
            if (copy.withTextarea && reasonEl.value) {
                button.setAttribute(
                    "hx-vals",
                    JSON.stringify({ reason: reasonEl.value }),
                );
            }
            modal.close();
            // Trigger the deferred HTMX request via the custom event the
            // button listens for (`hx-trigger="confirmed"`).
            if (typeof window.htmx !== "undefined") {
                window.htmx.trigger(button, "confirmed");
            } else {
                // Fallback: dispatch a native event so tests / non-HTMX
                // consumers observe the confirm.
                button.dispatchEvent(
                    new CustomEvent("confirmed", { bubbles: true }),
                );
            }
        }
        function onClose() {
            cleanup();
        }
        function onBackdrop(ev) {
            if (
                ev.target === modal ||
                (ev.target.getAttribute &&
                    ev.target.getAttribute("data-dismiss") === "true")
            ) {
                modal.close();
            }
        }

        confirmBtn.addEventListener("click", onConfirm);
        modal.addEventListener("close", onClose);
        modal.addEventListener("click", onBackdrop);

        if (typeof modal.showModal === "function") {
            modal.showModal();
        }
    }

    function onHtmxConfigRequest(event) {
        var token = csrfToken();
        if (token) {
            event.detail.headers["X-CSRF-Token"] = token;
        }
    }

    function init() {
        // Capture phase so we run BEFORE HTMX's bubble-phase listeners.
        document.addEventListener("click", onClick, true);
        document.body.addEventListener(
            "htmx:configRequest",
            onHtmxConfigRequest,
        );
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
