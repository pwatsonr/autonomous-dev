/* SPEC-015-2-04 §Modal lifecycle — Vanilla JS, no framework, no build step.
 *
 * Responsibilities:
 *   1. Listen for clicks on submit buttons that carry data-requires-confirm
 *      on a gate-action form. Capture phase so we run BEFORE HTMX's bubble-
 *      phase listener.
 *   2. POST to /repo/<repo>/request/<id>/gate/confirm-token to mint a
 *      single-use server token (CSRF-protected).
 *   3. Open the in-page #confirm-modal, capture focus, and require the
 *      operator type the exact phrase ("REJECT" by default).
 *   4. On confirm: inject the token as a hidden input on the form and
 *      submit via HTMX. On cancel/backdrop: restore focus and abort.
 *   5. Listen for the optional `gate:requires-confirm` CustomEvent dispatched
 *      by other code paths (e.g., tests). The detail.form is the originating
 *      gate-form element.
 *
 * Pure DOM API. Browser globals only — `htmx` is consulted opportunistically;
 * if absent we fall back to form.requestSubmit().
 */

(function () {
    "use strict";

    /** @type {HTMLElement | null} */
    var lastTrigger = null;

    /** @type {((result: { confirmed: boolean }) => void) | null} */
    var pendingResolve = null;

    /** @type {KeyboardEvent | null} */
    var escListener = null;

    function getCsrfToken() {
        var meta = document.querySelector('meta[name="csrf-token"]');
        if (meta) {
            var attr = meta.getAttribute("content");
            if (attr) return attr;
        }
        var input = document.querySelector('input[name="csrfToken"]');
        if (input && "value" in input) {
            return input.value || "";
        }
        return "";
    }

    function findRepoFromForm(form) {
        if (form.dataset && form.dataset.repo) return form.dataset.repo;
        var action = form.getAttribute("action") || "";
        var match = action.match(/\/repo\/([^/]+)/);
        return match ? match[1] : "";
    }

    function findRequestIdFromForm(form) {
        if (form.dataset && form.dataset.requestId) {
            return form.dataset.requestId;
        }
        var action = form.getAttribute("action") || "";
        var match = action.match(/\/request\/([^/]+)/);
        return match ? match[1] : "";
    }

    function getModal() {
        return document.getElementById("confirm-modal");
    }

    function showInlineError(form, message) {
        var existing = form.querySelector(".confirm-flow-error");
        if (existing) existing.remove();
        var div = document.createElement("div");
        div.className = "confirm-flow-error";
        div.setAttribute("role", "alert");
        div.textContent = message;
        form.insertBefore(div, form.firstChild);
    }

    function setBodyText(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    function formatCost(amount) {
        if (typeof amount !== "number" || !isFinite(amount)) return "";
        return "$" + amount.toFixed(2);
    }

    function closeModal() {
        var modal = getModal();
        if (!modal) return;
        modal.setAttribute("hidden", "");
        var input = document.getElementById("confirm-modal-input");
        if (input && "value" in input) input.value = "";
        var submit = document.getElementById("confirm-modal-submit");
        if (submit) submit.setAttribute("disabled", "disabled");
        if (escListener) {
            document.removeEventListener("keydown", escListener, true);
            escListener = null;
        }
        if (lastTrigger && typeof lastTrigger.focus === "function") {
            lastTrigger.focus();
        }
        lastTrigger = null;
    }

    function resolvePending(confirmed) {
        var resolve = pendingResolve;
        pendingResolve = null;
        closeModal();
        if (resolve) resolve({ confirmed: confirmed });
    }

    function openModal(opts) {
        var modal = getModal();
        if (!modal) {
            return Promise.resolve({ confirmed: false });
        }
        if (!modal.hasAttribute("hidden")) {
            // Idempotent guard: never re-open while open.
            return Promise.resolve({ confirmed: false });
        }
        var requiredText =
            opts.requiredText ||
            modal.getAttribute("data-required-text") ||
            "REJECT";
        setBodyText("confirm-modal-typed-text", requiredText);
        setBodyText(
            "confirm-modal-request-title",
            opts.requestTitle || opts.requestId || "",
        );
        setBodyText(
            "confirm-modal-cost",
            opts.costAmount !== undefined ? formatCost(opts.costAmount) : "",
        );
        var input = document.getElementById("confirm-modal-input");
        var submit = document.getElementById("confirm-modal-submit");
        if (input && "value" in input) input.value = "";
        if (submit) submit.setAttribute("disabled", "disabled");
        modal.removeAttribute("hidden");
        if (input && typeof input.focus === "function") input.focus();

        return new Promise(function (resolve) {
            pendingResolve = resolve;
            escListener = function (ev) {
                if (ev.key === "Escape") {
                    ev.preventDefault();
                    resolvePending(false);
                }
            };
            document.addEventListener("keydown", escListener, true);

            var checker = function () {
                if (!input || !submit) return;
                if (input.value === requiredText) {
                    submit.removeAttribute("disabled");
                } else {
                    submit.setAttribute("disabled", "disabled");
                }
            };
            if (input) {
                input.addEventListener("input", checker);
            }
        });
    }

    function bindStaticHandlers() {
        var modal = getModal();
        if (!modal) return;
        var cancel = document.getElementById("confirm-modal-cancel");
        var submit = document.getElementById("confirm-modal-submit");
        var backdrop = modal.querySelector('[data-dismiss="true"]');
        if (cancel) {
            cancel.addEventListener("click", function () {
                resolvePending(false);
            });
        }
        if (backdrop) {
            backdrop.addEventListener("click", function () {
                resolvePending(false);
            });
        }
        if (submit) {
            submit.addEventListener("click", function () {
                if (submit.hasAttribute("disabled")) return;
                resolvePending(true);
            });
        }
    }

    function injectToken(form, token) {
        var existing = form.querySelector(
            'input[name="confirmationToken"]',
        );
        if (!existing) {
            existing = document.createElement("input");
            existing.type = "hidden";
            existing.name = "confirmationToken";
            form.appendChild(existing);
        }
        existing.value = token;
    }

    function submitForm(form, button) {
        // Honor the click target by injecting the action value.
        if (button && button.name === "action" && button.value) {
            var actionInput = form.querySelector(
                'input[type="hidden"][name="_action_value"]',
            );
            if (!actionInput) {
                actionInput = document.createElement("input");
                actionInput.type = "hidden";
                actionInput.name = "action";
                form.appendChild(actionInput);
            }
            actionInput.value = button.value;
        }
        var w = /** @type {{ htmx?: { trigger: Function } }} */ (window);
        if (w.htmx && typeof w.htmx.trigger === "function") {
            w.htmx.trigger(form, "submit");
        } else if (typeof form.requestSubmit === "function") {
            form.requestSubmit();
        } else {
            form.submit();
        }
    }

    /**
     * Run the full confirm flow against an originating form + button.
     * Resolves silently on cancel; submits the form on confirm.
     */
    async function runConfirmFlow(form, button) {
        var repo = findRepoFromForm(form);
        var requestId = findRequestIdFromForm(form);
        var actionAttr = button.getAttribute("value") || "reject";

        var tokenResp;
        try {
            tokenResp = await fetch(
                "/repo/" +
                    encodeURIComponent(repo) +
                    "/request/" +
                    encodeURIComponent(requestId) +
                    "/gate/confirm-token",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "X-CSRF-Token": getCsrfToken(),
                    },
                    body: JSON.stringify({ action: actionAttr }),
                    credentials: "same-origin",
                },
            );
        } catch (err) {
            showInlineError(
                form,
                "Could not start confirmation flow. Please retry.",
            );
            return;
        }
        if (!tokenResp.ok) {
            showInlineError(
                form,
                "Could not start confirmation flow. Please retry.",
            );
            return;
        }
        var body;
        try {
            body = await tokenResp.json();
        } catch (err) {
            showInlineError(form, "Confirmation service returned bad data.");
            return;
        }
        var token = body && body.token;
        var requiredText = (body && body.requiresType) || "REJECT";
        if (!token) {
            showInlineError(form, "Confirmation token missing from response.");
            return;
        }

        var panel = form.closest(".gate-action-panel");
        var costAttr = panel && panel.getAttribute("data-cost");
        var costAmount =
            costAttr === null || costAttr === undefined
                ? undefined
                : Number(costAttr);
        var titleAttr = panel && panel.getAttribute("data-request-title");

        lastTrigger = button;
        var result = await openModal({
            requestId: requestId,
            costAmount: costAmount,
            requiredText: requiredText,
            requestTitle: titleAttr || requestId,
        });
        if (!result.confirmed) return;

        injectToken(form, token);
        submitForm(form, button);
    }

    function onClickCapture(ev) {
        var target = ev.target;
        if (!(target instanceof Element)) return;
        var button = target.closest('button[data-requires-confirm="true"]');
        if (!button) return;
        var form = button.closest("form.gate-form");
        if (!form) return;
        ev.preventDefault();
        ev.stopPropagation();
        // Detached promise — failures are surfaced via inline error.
        runConfirmFlow(form, button);
    }

    function onCustomEvent(ev) {
        var detail = ev.detail || {};
        var form = detail.form;
        if (!form) return;
        var button =
            (detail.button instanceof Element ? detail.button : null) ||
            form.querySelector('button[data-requires-confirm="true"]');
        if (!button) return;
        runConfirmFlow(form, button);
    }

    function start() {
        bindStaticHandlers();
        document.addEventListener("click", onClickCapture, true);
        document.addEventListener("gate:requires-confirm", onCustomEvent);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", start);
    } else {
        start();
    }

    // Test hook — exposed so jsdom-based tests can drive the flow without
    // simulating the click path.
    /** @type {any} */ (window).__gateConfirmation = {
        runConfirmFlow: runConfirmFlow,
        openModal: openModal,
        closeModal: closeModal,
    };
})();
