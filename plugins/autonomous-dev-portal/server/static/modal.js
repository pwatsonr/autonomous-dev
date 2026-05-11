// SPEC-037-7-03 §Shared modal helper.
//
// CONTRACT (consumed by phase-artifact-modal, gate-actions confirm-modal,
// and any future overlay):
//
//   Markup
//   ------
//   Modals live in the page DOM at all times, wrapped in a backdrop:
//
//       <div class="modal-bg" data-modal="{id}" hidden>
//         <div class="modal modal-wide" role="dialog" aria-modal="true">
//           ...
//           <button data-modal-close>...</button>
//         </div>
//       </div>
//
//   The wrapper carries `hidden` by default. This module toggles the
//   attribute on open/close.
//
//   Triggers
//   --------
//   * `[data-modal-open="{id}"]`           opens the matching modal
//   * `.modal-bg` (target is backdrop itself) closes
//   * `[data-modal-close]` inside an open modal closes
//   * `Escape` while a modal is open closes the top-most modal
//
//   Public API (on `window.portalModal`)
//   ------------------------------------
//   * `openModal(id)`    — opens a modal by `data-modal` id.
//   * `closeModal(id)`   — closes a specific modal (no-op if not open).
//   * `closeTopModal()`  — closes the top-most open modal.
//
//   Focus management
//   ----------------
//   On open the helper records `document.activeElement`, focuses the first
//   focusable child of the modal, and traps Tab/Shift+Tab inside the modal.
//   On close focus is restored to the recorded element.
//
// NOTE: written in vanilla JS (no transpile step) so it is served as-is
// from `/static/modal.js`. CSP-safe: no inline handlers, no eval.
//
// PLAN-037-5 may later ship a shared helper at this same path; in that
// event the contract above MUST stay compatible so downstream surfaces
// (gate-actions confirm-modal, phase-artifact modal) keep working.

(function () {
    "use strict";

    /** Stack of open modal ids, most-recently-opened last. */
    var openStack = [];
    /** Map of modal id -> previously-focused element. */
    var priorFocus = {};

    var FOCUSABLE_SELECTOR =
        'a[href], area[href], input:not([disabled]):not([type="hidden"]), ' +
        "select:not([disabled]), textarea:not([disabled]), " +
        'button:not([disabled]), iframe, object, embed, [tabindex="0"], ' +
        "[contenteditable]";

    function findModal(id) {
        if (!id) return null;
        return document.querySelector('.modal-bg[data-modal="' + id + '"]');
    }

    function focusableChildren(modal) {
        var inner = modal.querySelector(".modal") || modal;
        var nodes = inner.querySelectorAll(FOCUSABLE_SELECTOR);
        var out = [];
        for (var i = 0; i < nodes.length; i++) {
            var el = nodes[i];
            if (el.offsetParent !== null || el === document.activeElement) {
                out.push(el);
            }
        }
        return out;
    }

    function openModal(id) {
        var modal = findModal(id);
        if (!modal) return;
        if (openStack.indexOf(id) !== -1) return; // already open
        priorFocus[id] = document.activeElement;
        modal.hidden = false;
        modal.removeAttribute("hidden");
        openStack.push(id);
        // Focus the first focusable child if any.
        var children = focusableChildren(modal);
        if (children.length > 0 && typeof children[0].focus === "function") {
            try {
                children[0].focus();
            } catch (_) {
                /* noop */
            }
        }
    }

    function closeModal(id) {
        var modal = findModal(id);
        if (!modal) return;
        var idx = openStack.indexOf(id);
        if (idx === -1) return; // not open
        modal.hidden = true;
        modal.setAttribute("hidden", "");
        openStack.splice(idx, 1);
        var prior = priorFocus[id];
        delete priorFocus[id];
        if (prior && typeof prior.focus === "function") {
            try {
                prior.focus();
            } catch (_) {
                /* noop */
            }
        }
    }

    function closeTopModal() {
        if (openStack.length === 0) return;
        var top = openStack[openStack.length - 1];
        closeModal(top);
    }

    function onClick(event) {
        var t = event.target;
        if (!t || !t.getAttribute) return;
        // Open trigger.
        var trigger = closestAttr(t, "data-modal-open");
        if (trigger) {
            event.preventDefault();
            openModal(trigger.getAttribute("data-modal-open"));
            return;
        }
        // Close trigger inside an open modal.
        var closer = closestAttr(t, "data-modal-close");
        if (closer) {
            event.preventDefault();
            var modal = closer.closest(".modal-bg");
            if (modal) {
                closeModal(modal.getAttribute("data-modal"));
            }
            return;
        }
        // Backdrop click — only when the target is the backdrop itself,
        // never when the click bubbles up from inner `.modal` content.
        if (t.classList && t.classList.contains("modal-bg")) {
            closeModal(t.getAttribute("data-modal"));
        }
    }

    function closestAttr(node, attr) {
        while (node && node !== document.body) {
            if (node.getAttribute && node.getAttribute(attr) !== null) {
                return node;
            }
            node = node.parentNode;
        }
        return null;
    }

    function onKeydown(event) {
        if (event.key !== "Escape" && event.key !== "Tab") return;
        if (openStack.length === 0) return;
        if (event.key === "Escape") {
            event.preventDefault();
            closeTopModal();
            return;
        }
        // Focus trap (Tab / Shift+Tab) inside the top-most modal.
        var top = openStack[openStack.length - 1];
        var modal = findModal(top);
        if (!modal) return;
        var children = focusableChildren(modal);
        if (children.length === 0) {
            event.preventDefault();
            return;
        }
        var first = children[0];
        var last = children[children.length - 1];
        var active = document.activeElement;
        if (event.shiftKey && active === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && active === last) {
            event.preventDefault();
            first.focus();
        }
    }

    function init() {
        document.addEventListener("click", onClick);
        document.addEventListener("keydown", onKeydown);
    }

    // Expose for programmatic callers (e.g. gate-actions.js).
    window.portalModal = {
        openModal: openModal,
        closeModal: closeModal,
        closeTopModal: closeTopModal,
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
