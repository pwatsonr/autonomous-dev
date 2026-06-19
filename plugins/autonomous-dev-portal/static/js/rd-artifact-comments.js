// #500 — Request Detail artifact inline-comment selection helper.
//
// CSP policy disallows inline onclick / hx-on (script-src 'self' + nonce
// only), so the "select text in the doc → attach an inline comment" flow is
// driven here via delegated listeners on `document`. This script is purely
// ADDITIVE: doc-level comments, resolve, and revise are plain HTMX forms that
// work without it. If this file fails to load, the only loss is the
// select-to-comment affordance — it fails open.
//
// Behavior:
//   - On `mouseup` / `keyup`, if there is a non-empty text selection whose
//     anchor + focus are both inside the rendered artifact body (`.artifact`),
//     compute the selected text and its character offsets relative to that
//     body, reveal the inline-comment form (#rd-comment-inline-form), fill the
//     hidden anchor fields (quote/start/end) and the preview blockquote, and
//     focus the textarea.
//   - Clicking the form's [data-action="cancel-inline-comment"] button hides
//     the form and clears its fields.
//   - After an HTMX swap replaces #rd-comment-panel (add/resolve/revise), the
//     form returns to its hidden default — no rebind needed because all
//     listeners are delegated on `document`.
//
// Offsets are computed with a TreeWalker over the artifact body's text nodes
// so they are stable against the rendered HTML structure. They are best-effort
// (used only for UI re-highlighting); the authoritative anchor for the daemon
// is the verbatim `quote` text.

(function () {
    "use strict";

    var ARTIFACT_SELECTOR = ".artifact";
    var FORM_ID = "rd-comment-inline-form";
    var QUOTE_ID = "rd-comment-anchor-quote";
    var START_ID = "rd-comment-anchor-start";
    var END_ID = "rd-comment-anchor-end";
    var PREVIEW_ID = "rd-comment-selected-preview";
    var BODY_ID = "rd-comment-inline-body";

    function closestArtifact(node) {
        var el = node && node.nodeType === 3 ? node.parentNode : node;
        return el && el.closest ? el.closest(ARTIFACT_SELECTOR) : null;
    }

    // Character offset of a (node, offset) point within `root`'s text content.
    function offsetWithin(root, node, nodeOffset) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var total = 0;
        var current;
        while ((current = walker.nextNode())) {
            if (current === node) {
                return total + nodeOffset;
            }
            total += current.nodeValue ? current.nodeValue.length : 0;
        }
        return total;
    }

    function byId(id) {
        return document.getElementById(id);
    }

    function hideForm() {
        var form = byId(FORM_ID);
        if (!form) {
            return;
        }
        form.setAttribute("hidden", "");
        setVal(QUOTE_ID, "");
        setVal(START_ID, "");
        setVal(END_ID, "");
        var preview = byId(PREVIEW_ID);
        if (preview) {
            preview.textContent = "";
        }
        var body = byId(BODY_ID);
        if (body) {
            body.value = "";
        }
    }

    function setVal(id, value) {
        var el = byId(id);
        if (el) {
            el.value = value;
        }
    }

    function showFormForSelection(text, start, end) {
        var form = byId(FORM_ID);
        if (!form) {
            return;
        }
        setVal(QUOTE_ID, text);
        setVal(START_ID, String(start));
        setVal(END_ID, String(end));
        var preview = byId(PREVIEW_ID);
        if (preview) {
            preview.textContent = text;
        }
        form.removeAttribute("hidden");
        var body = byId(BODY_ID);
        if (body) {
            body.focus();
        }
    }

    function onSelectionChange() {
        var sel = window.getSelection ? window.getSelection() : null;
        if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
            return;
        }
        var text = sel.toString();
        if (!text || text.trim().length === 0) {
            return;
        }
        // Both ends of the selection must live inside the SAME artifact body.
        var anchorArtifact = closestArtifact(sel.anchorNode);
        var focusArtifact = closestArtifact(sel.focusNode);
        if (
            !anchorArtifact ||
            !focusArtifact ||
            anchorArtifact !== focusArtifact
        ) {
            return;
        }
        var root = anchorArtifact;
        var a = offsetWithin(root, sel.anchorNode, sel.anchorOffset);
        var b = offsetWithin(root, sel.focusNode, sel.focusOffset);
        var start = Math.min(a, b);
        var end = Math.max(a, b);
        showFormForSelection(text, start, end);
    }

    function onClick(event) {
        var cancel = event.target.closest(
            '[data-action="cancel-inline-comment"]'
        );
        if (cancel) {
            event.preventDefault();
            hideForm();
        }
    }

    // Selection can finish via mouse or keyboard; listen for both.
    document.addEventListener("mouseup", onSelectionChange);
    document.addEventListener("keyup", onSelectionChange);
    document.addEventListener("click", onClick);
})();
