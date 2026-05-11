// SPEC-037-4-02 §segmented-filter.js — vanilla DOM segmented filter.
//
// Wires the kit's `.seg` / `.seg-btn` segmented control to a
// client-side row filter. Each `[data-segmented-filter]` group toggles
// `.hidden` on its sibling `[data-gate-type]` rows based on the active
// button's `data-filter` value (`all` shows every row).
//
// Zero dependencies — pure DOM. Self-attaches on `DOMContentLoaded`
// and on `htmx:afterSwap` so it survives OOB swaps. Also updates
// `aria-pressed` on every click so SR users see the active state.

(function () {
    "use strict";

    function applyFilter(group) {
        var active = group.querySelector(".seg-btn.on");
        var filter = active ? active.getAttribute("data-filter") : "all";
        var section = group.closest("section") || document;
        var rows = section.querySelectorAll("[data-gate-type]");
        var visible = 0;
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var show = filter === "all" || row.getAttribute("data-gate-type") === filter;
            row.classList.toggle("hidden", !show);
            if (show) visible++;
        }
        updateEmpty(section, group, visible, active);
    }

    function updateEmpty(section, group, visible, active) {
        var empty = section.querySelector(".empty[data-empty-for]");
        if (visible === 0) {
            var label = active ? (active.textContent || "").trim() : "";
            if (!empty) {
                empty = document.createElement("div");
                empty.className = "empty";
                empty.setAttribute("data-empty-for", "gate-list");
                // Append to the section so the empty state replaces the
                // visual position of the .gate-list when every row hides.
                section.appendChild(empty);
            }
            empty.textContent = "No " + label.toLowerCase() + " gates";
        } else if (empty) {
            empty.parentNode.removeChild(empty);
        }
    }

    function bind(group) {
        if (group.getAttribute("data-segmented-filter-bound") === "1") return;
        group.setAttribute("data-segmented-filter-bound", "1");
        var buttons = group.querySelectorAll(".seg-btn");
        for (var i = 0; i < buttons.length; i++) {
            (function (btn) {
                btn.addEventListener("click", function () {
                    var siblings = group.querySelectorAll(".seg-btn");
                    for (var j = 0; j < siblings.length; j++) {
                        siblings[j].classList.remove("on");
                        siblings[j].setAttribute("aria-pressed", "false");
                    }
                    btn.classList.add("on");
                    btn.setAttribute("aria-pressed", "true");
                    applyFilter(group);
                });
            })(buttons[i]);
        }
    }

    function init() {
        var groups = document.querySelectorAll("[data-segmented-filter]");
        for (var i = 0; i < groups.length; i++) {
            bind(groups[i]);
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
    if (document.body) {
        document.body.addEventListener("htmx:afterSwap", init);
    } else {
        document.addEventListener("DOMContentLoaded", function () {
            document.body.addEventListener("htmx:afterSwap", init);
        });
    }
})();
