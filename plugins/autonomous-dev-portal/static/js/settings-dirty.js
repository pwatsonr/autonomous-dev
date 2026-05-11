/* SPEC-037-5-01 §Settings Save / Discard dirty-tracking module.
 *
 * Opt-in: scans for a single `[data-dirty-tracking]` container; if absent
 * (e.g. on pages other than Settings) the module is a no-op.
 *
 * Behaviour:
 *   - On `input` / `change` inside the tracked container, marks the
 *     originating field with `data-dirty="true"` and toggles the
 *     `disabled` attribute on every `[data-action="discard"]` and
 *     `[data-action="save"]` button (page-head action pair).
 *   - On `[data-action="discard"]` click, restores every dirty field to
 *     its `defaultValue` (text/number inputs), `defaultChecked` (radio /
 *     checkbox), or `defaultSelected` (option) and clears the dirty
 *     flags + button state.
 *   - On `htmx:afterSwap` targeting `#settings-root`, re-initialises so
 *     the swapped fragment starts from a clean dirty baseline.
 *
 * Idempotency: the `dataset.dirtyBound` sentinel on the tracking root
 * prevents double-binding on a second script load or test re-import.
 *
 * Save delegates to HTMX (`hx-post="/settings"`); this module does NOT
 * perform a network round-trip itself.
 */

(function () {
    "use strict";

    function isFormField(el) {
        return (
            el instanceof HTMLInputElement ||
            el instanceof HTMLSelectElement ||
            el instanceof HTMLTextAreaElement
        );
    }

    function anyDirty(root) {
        return !!root.querySelector('[data-dirty="true"]');
    }

    function setActionsDisabled(root, disabled) {
        var btns = document.querySelectorAll(
            '[data-action="discard"], [data-action="save"]',
        );
        btns.forEach(function (b) {
            if (disabled) b.setAttribute("disabled", "");
            else b.removeAttribute("disabled");
        });
        // Re-state for accessibility — the visible state mirrors `disabled`.
        // Caller may also surface a save-pending hint elsewhere.
        void root; // keep lint quiet about unused param when root is implicit
    }

    function markDirty(el) {
        if (!isFormField(el)) return;
        // Skip the page-head action buttons themselves.
        if (
            el.getAttribute("data-action") === "save" ||
            el.getAttribute("data-action") === "discard"
        ) {
            return;
        }
        el.setAttribute("data-dirty", "true");
    }

    function restoreField(el) {
        if (el instanceof HTMLInputElement) {
            if (el.type === "checkbox" || el.type === "radio") {
                el.checked = el.defaultChecked;
            } else {
                el.value = el.defaultValue;
            }
        } else if (el instanceof HTMLTextAreaElement) {
            el.value = el.defaultValue;
        } else if (el instanceof HTMLSelectElement) {
            for (var i = 0; i < el.options.length; i++) {
                el.options[i].selected = el.options[i].defaultSelected;
            }
        }
        el.removeAttribute("data-dirty");
    }

    function discardAll(root) {
        root.querySelectorAll('[data-dirty="true"]').forEach(restoreField);
        setActionsDisabled(root, true);
    }

    function init(root) {
        var target =
            root ||
            document.querySelector("[data-dirty-tracking]");
        if (!target) return; // opt-in: no-op when the container is absent.
        if (target.dataset.dirtyBound === "1") {
            // Re-init: reset dirty state but keep the listeners.
            target
                .querySelectorAll('[data-dirty="true"]')
                .forEach(function (el) {
                    el.removeAttribute("data-dirty");
                });
            setActionsDisabled(target, true);
            return;
        }
        target.dataset.dirtyBound = "1";
        setActionsDisabled(target, true);

        function onChange(e) {
            if (!(e.target instanceof Element)) return;
            markDirty(e.target);
            setActionsDisabled(target, !anyDirty(target));
        }
        target.addEventListener("input", onChange);
        target.addEventListener("change", onChange);

        // Discard is delegated at the document level so the page-head
        // buttons (siblings of the tracking root) can dispatch to us.
        document.addEventListener("click", function (e) {
            if (!(e.target instanceof Element)) return;
            var btn = e.target.closest('[data-action="discard"]');
            if (!btn) return;
            e.preventDefault();
            discardAll(target);
        });

        // After a successful HTMX save, the server returns a swapped
        // fragment with fresh default values; reset our dirty state.
        document.addEventListener("htmx:afterSwap", function (e) {
            var detail = e && e.detail;
            var swappedRoot = detail && detail.target;
            if (
                swappedRoot &&
                (swappedRoot.id === "settings-root" ||
                    swappedRoot.querySelector("[data-dirty-tracking]"))
            ) {
                init(document.querySelector("[data-dirty-tracking]"));
            }
        });
    }

    function reset(root) {
        var target =
            root || document.querySelector("[data-dirty-tracking]");
        if (!target) return;
        target
            .querySelectorAll('[data-dirty="true"]')
            .forEach(function (el) {
                el.removeAttribute("data-dirty");
            });
        setActionsDisabled(target, true);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", function () {
            init();
        });
    } else {
        init();
    }

    if (typeof window !== "undefined") {
        window.SettingsDirty = { init: init, reset: reset };
    }
})();
