/* SPEC-036-4-04..06 §Form validation — live `input`-event UX gate.
 *
 * Pure validators (cost caps, allowlist paths, webhook URLs, DND time
 * coherence, trust-level radios) live as named exports so unit tests can
 * exercise the predicates without a DOM. The module also wires the
 * predicates to live form fields by `data-validate` attribute.
 *
 * Authoritative validation always happens server-side; this module is a
 * pre-flight UX gate, not a security boundary.
 */

(function (root) {
    "use strict";

    // ---- Cost-cap predicate -----------------------------------------------
    function validateCostCap(input, context) {
        var value = (input && "value" in input) ? input.value : input;
        if (value === "" || value === null || value === undefined) {
            return null;
        }
        var n = Number(value);
        if (Number.isNaN(n)) return "must be a number";
        if (n < 0) return "must be ≥ 0";
        if (!context) return null;
        var field = input && input.dataset && input.dataset.costCapField;
        if (field === "perRequest" && context.daily !== undefined) {
            if (n > context.daily) return "must be less than daily cap";
        }
        if (field === "daily" && context.monthly !== undefined) {
            if (n > context.monthly) return "must be less than monthly cap";
        }
        return null;
    }

    // ---- Allowlist path predicate -----------------------------------------
    function validateAllowlistPath(value) {
        if (value === "" || value === null || value === undefined) return null;
        var s = String(value);
        if (s.length > 4096) return "path too long";
        if (s.indexOf("..") !== -1) return "path must not contain ..";
        if (s.charAt(0) === "$") {
            return "use absolute path or a tilde-resolved path";
        }
        return null;
    }

    // ---- Webhook URL predicate --------------------------------------------
    var DISCORD_RE = /^https:\/\/discord\.com\//;
    var SLACK_RE = /^https:\/\/hooks\.slack\.com\//;

    function validateWebhookUrl(value, channel) {
        if (value === "" || value === null || value === undefined) return null;
        var s = String(value);
        if (channel === "discord" && !DISCORD_RE.test(s)) {
            return "Discord webhook must start with https://discord.com/";
        }
        if (channel === "slack" && !SLACK_RE.test(s)) {
            return "Slack webhook must start with https://hooks.slack.com/";
        }
        return null;
    }

    // ---- DND time-range coherence -----------------------------------------
    function validateDndRange(start, end, allowWrap) {
        if (!start || !end) return null;
        if (allowWrap) return null;
        // Compare as `HH:MM` strings — lex order matches numeric for HH:MM.
        if (start >= end) {
            return "DND end must be after start (or wrap past midnight)";
        }
        return null;
    }

    // ---- DOM helpers ------------------------------------------------------
    function fieldErrorEl(input) {
        var parent = input && input.parentElement;
        if (!parent) return null;
        return parent.querySelector(".field-error");
    }

    function setError(input, message) {
        var parent = input && input.parentElement;
        if (!parent) return;
        var err = fieldErrorEl(input);
        if (message) {
            if (!err) {
                err = document.createElement("span");
                err.className = "field-error";
                err.setAttribute("role", "alert");
                parent.appendChild(err);
            }
            err.textContent = message;
        } else if (err) {
            err.remove();
        }
    }

    function recomputeFormState(form) {
        if (!form) return;
        var hasError = form.querySelectorAll(".field-error").length > 0;
        form.querySelectorAll('button[type="submit"], .btn.primary').forEach(
            function (btn) {
                btn.disabled = hasError;
            },
        );
    }

    function getCostCapContext(input) {
        var parent =
            input && input.closest && input.closest("[data-page='settings']");
        if (!parent) parent = document;
        function read(id) {
            var el = parent.querySelector ? parent.querySelector("#" + id) : null;
            return el && el.value !== "" ? Number(el.value) : undefined;
        }
        return {
            perRequest: read("cost-cap-per-request"),
            daily: read("cost-cap-daily"),
            monthly: read("cost-cap-monthly"),
        };
    }

    function onInput(event) {
        var t = event.target;
        if (!t || !t.dataset) return;
        var kind = t.dataset.validate;
        if (!kind) return;
        var msg = null;
        if (kind === "cost-cap") {
            msg = validateCostCap(t, getCostCapContext(t));
        } else if (kind === "allowlist-path") {
            msg = validateAllowlistPath(t.value);
            // Also gate the Add button explicitly (empty = disabled).
            var form = t.form;
            if (form) {
                var addBtn = form.querySelector(".btn.primary");
                if (addBtn) addBtn.disabled = !t.value || msg !== null;
            }
        } else if (kind === "webhook-url") {
            var ch = t.id === "discord-webhook" ? "discord" : "slack";
            msg = validateWebhookUrl(t.value, ch);
        } else if (kind === "dnd-time") {
            var start = document.getElementById("dnd-start");
            var end = document.getElementById("dnd-end");
            msg = validateDndRange(
                start && start.value,
                end && end.value,
                false,
            );
            // Apply the message to whichever input triggered the event so
            // the error span is positioned next to the relevant control.
        } else if (kind === "trust-level") {
            // Trust-level radios have no inline error — only the
            // ConfirmModal gate is required (see settings-modals.js).
            return;
        }
        setError(t, msg);
        recomputeFormState(t.form || t.closest("form"));
    }

    function init() {
        if (document.body && document.body.dataset.formValidationBound === "1") {
            return;
        }
        if (document.body) {
            document.body.dataset.formValidationBound = "1";
        }
        document.addEventListener("input", onInput);
        document.addEventListener("change", onInput);
    }

    if (typeof document !== "undefined") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", init);
        } else {
            init();
        }
    }

    if (root) {
        root.__formValidation = {
            validateCostCap: validateCostCap,
            validateAllowlistPath: validateAllowlistPath,
            validateWebhookUrl: validateWebhookUrl,
            validateDndRange: validateDndRange,
            init: init,
            setError: setError,
            recomputeFormState: recomputeFormState,
        };
    }
})(typeof window !== "undefined" ? window : globalThis);
