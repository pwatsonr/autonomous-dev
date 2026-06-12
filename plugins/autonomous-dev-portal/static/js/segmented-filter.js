// segmented-filter.js — row filtering for .seg groups (SPEC-037-4-02).
// Referenced by the requests + approvals views since v3 but never
// shipped: the seg buttons were dead controls (operator-reported,
// visual crawl p2/p3 follow-up).
//
// Contract:
//   <div class="seg" data-segmented-filter="<name>"> with .seg-btn
//   children carrying data-filter="<token>". Rows anywhere under the
//   nearest [data-filter-root] (fallback: document) carry
//   data-gate-type="<token>". Token "all" shows every row. An optional
//   [data-filter-empty] element is unhidden when nothing matches.
(function () {
    "use strict";

    function apply(seg, token) {
        var root = seg.closest("[data-filter-root]") || document;
        var rows = root.querySelectorAll("[data-gate-type]");
        var visible = 0;
        rows.forEach(function (row) {
            var show =
                token === "all" ||
                row.getAttribute("data-gate-type") === token;
            row.hidden = !show;
            if (show) visible += 1;
        });
        var empty = root.querySelector("[data-filter-empty]");
        if (empty) empty.hidden = visible !== 0;
    }

    function bind(seg) {
        if (seg.dataset.segBound === "1") return; // idempotent re-binds
        seg.dataset.segBound = "1";
        seg.addEventListener("click", function (ev) {
            var btn = ev.target.closest(".seg-btn");
            if (!btn || !seg.contains(btn)) return;
            seg.querySelectorAll(".seg-btn").forEach(function (b) {
                b.classList.toggle("active", b === btn);
                b.setAttribute("aria-pressed", b === btn ? "true" : "false");
            });
            apply(seg, btn.getAttribute("data-filter") || "all");
        });
    }

    function init(scope) {
        (scope.querySelectorAll
            ? scope
            : document
        ).querySelectorAll("[data-segmented-filter]").forEach(bind);
    }

    if (document.readyState !== "loading") init(document);
    else document.addEventListener("DOMContentLoaded", function () { init(document); });

    // htmx polling replaces whole page bodies — rebind inside swapped nodes.
    document.addEventListener("htmx:afterSwap", function (ev) {
        if (ev.target && ev.target.querySelectorAll) init(ev.target);
    });
})();
