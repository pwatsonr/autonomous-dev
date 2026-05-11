// SPEC-036-3-06 / SPEC-037-7-04 §Gate actions confirm-modal flow.
//
// Wires the three gate action buttons (Approve / Request Changes / Reject)
// to a shared confirm-modal interstitial built on the `.modal-bg` overlay
// pattern (SPEC-037-7-03; `static/modal.js`). Each click intercepts the
// HTMX request, opens the modal with action-specific copy, and only fires
// the HTMX request once the operator confirms. Escape + backdrop dismiss
// cancel the action without firing the request.
//
// On confirm:
//   - If the modal carries a reason textarea, the value is attached as a
//     `X-Gate-Note` header via the originating button's `hx-headers`.
//   - The originating button is dispatched a `confirmed` event so its
//     `hx-trigger="confirmed"` listener fires the HTMX POST.
//
// CSRF: read once from `<meta name="csrf-token">` and attached to every
// HTMX request via `htmx:configRequest`. The button's `hx-headers` also
// carries the token statically as a belt-and-braces fallback.

(function () {
    "use strict";

    var MODAL_ID = "confirm-gate";

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
                "Send a short note; the author will retry with this " +
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
        var existing = document.querySelector(
            '.modal-bg[data-modal="' + MODAL_ID + '"]',
        );
        if (existing) return existing;
        var wrap = document.createElement("div");
        wrap.className = "modal-bg gate-action-modal";
        wrap.setAttribute("data-modal", MODAL_ID);
        wrap.setAttribute("hidden", "");
        wrap.hidden = true;
        wrap.innerHTML =
            '<div class="modal modal-wide" role="dialog" aria-modal="true" ' +
            'aria-labelledby="gate-action-modal-title">' +
            '<div class="modal-head">' +
            '<h3 id="gate-action-modal-title"></h3>' +
            '<button type="button" class="modal-close" data-modal-close ' +
            'aria-label="Close">✕</button>' +
            "</div>" +
            '<div class="modal-body">' +
            '<p id="gate-action-modal-body"></p>' +
            '<textarea id="gate-action-modal-reason" class="modal-input" ' +
            'placeholder="Reason..." hidden></textarea>' +
            "</div>" +
            '<div class="modal-actions">' +
            '<button type="button" id="gate-action-modal-cancel" ' +
            'class="btn" data-modal-close>Cancel</button>' +
            '<button type="button" id="gate-action-modal-confirm" ' +
            'class="btn primary"></button>' +
            "</div>" +
            "</div>";
        document.body.appendChild(wrap);
        return wrap;
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

    /** Pending state for the current open confirm modal. */
    var pending = null;

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

        // Tear down any prior pending confirm.
        if (pending) {
            pending.confirmBtn.removeEventListener("click", pending.onConfirm);
        }

        function onConfirm() {
            confirmBtn.removeEventListener("click", onConfirm);
            pending = null;
            // Attach the optional reason as a header so the existing HTMX
            // request can pick it up without a second form roundtrip.
            if (copy.withTextarea && reasonEl.value) {
                var headers = { "X-Gate-Note": reasonEl.value };
                button.setAttribute("hx-headers", JSON.stringify(headers));
            }
            if (window.portalModal && typeof window.portalModal.closeModal === "function") {
                window.portalModal.closeModal(MODAL_ID);
            } else {
                modal.hidden = true;
                modal.setAttribute("hidden", "");
            }
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

        pending = {
            confirmBtn: confirmBtn,
            onConfirm: onConfirm,
        };
        confirmBtn.addEventListener("click", onConfirm);

        if (window.portalModal && typeof window.portalModal.openModal === "function") {
            window.portalModal.openModal(MODAL_ID);
        } else {
            // Fallback: toggle hidden directly.
            modal.hidden = false;
            modal.removeAttribute("hidden");
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
