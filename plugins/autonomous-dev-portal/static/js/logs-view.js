// logs-view.js — Follow-tail + grep-filter client behaviors for the Logs view.
//
// Loaded as `type="module"` from logs.tsx so it is scoped to the Logs page
// only. No global side-effects; all listeners are delegated to #logs-root.
//
// Features:
//   1. Follow-tail — keeps the .log terminal scrolled to the bottom when the
//      user hasn't manually scrolled up. Activates/deactivates automatically
//      and updates the .follow-tail-chip aria-pressed + class.
//   2. Grep filter — filters visible .log-line elements by a text match on the
//      message span. Runs client-side on the current DOM; the HTMX poll
//      re-fetches from the server with the grep param on submit.
//   3. Level filter — updates aria-pressed on the seg group buttons on click
//      and threads the active level into the polling URL so swaps don't
//      silently discard the user's filter selection.
//   4. After HTMX swap — re-applies the current grep filter and triggers
//      follow-tail scroll on every server swap.
//   5. Error state — listens for htmx:responseError / htmx:sendError and
//      injects a visible 'Stream stalled — retrying…' row so users are not
//      left watching stale log output with no signal of failure.

(function () {
    "use strict";

    var SCROLL_THRESHOLD = 48; // px from bottom before we consider "at tail"

    /**
     * Returns true when the terminal is scrolled within SCROLL_THRESHOLD px
     * of the bottom.
     * @param {HTMLElement} el
     */
    function isAtTail(el) {
        return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD;
    }

    /**
     * Scrolls the terminal to the very bottom.
     * @param {HTMLElement} el
     */
    function scrollToTail(el) {
        el.scrollTop = el.scrollHeight;
    }

    /**
     * Apply the current grep value to all .log-line elements in `terminal`.
     * Rows whose text does not match are hidden via the `.log-row-hidden` class.
     * @param {HTMLElement} terminal
     * @param {string} grep
     */
    function applyGrep(terminal, grep) {
        var rows = terminal.querySelectorAll(".log-line");
        var lower = grep.toLowerCase();
        for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            if (!grep) {
                row.classList.remove("log-row-hidden");
            } else {
                var text = row.textContent || "";
                var visible = text.toLowerCase().indexOf(lower) !== -1;
                row.classList.toggle("log-row-hidden", !visible);
            }
        }
    }

    /**
     * Update the follow-tail chip's visual state and aria-pressed.
     * @param {HTMLElement} chip
     * @param {boolean} active
     */
    function updateChip(chip, active) {
        if (!chip) return;
        chip.classList.toggle("active", active);
        chip.setAttribute("aria-pressed", active ? "true" : "false");
    }

    /**
     * Update aria-pressed on the level-filter segmented buttons.
     * The active button is the one whose hx-get URL matches the current
     * active level (stored as a data-level attribute on the seg group).
     * @param {HTMLElement} segGroup
     * @param {string} level - "all" | "error" | "warn" | "info"
     */
    function updateSegPressed(segGroup, level) {
        if (!segGroup) return;
        var buttons = segGroup.querySelectorAll("button[data-level-value]");
        for (var i = 0; i < buttons.length; i++) {
            var btn = buttons[i];
            var isActive = btn.getAttribute("data-level-value") === level;
            btn.setAttribute("aria-pressed", isActive ? "true" : "false");
            btn.classList.toggle("active", isActive);
        }
    }

    /**
     * Build the poll URL for #logs-body, threading the active level param so
     * refreshes don't silently discard the user's filter.
     * @param {string} level - "all" | "error" | "warn" | "info"
     * @returns {string}
     */
    function buildPollUrl(level) {
        if (!level || level === "all") return "/logs";
        return "/logs?level=" + encodeURIComponent(level);
    }

    /**
     * Inject (or update) a stall-indicator row in the terminal.
     * The row uses .log-line + .l-err styling and carries a distinct id so
     * it is replaced rather than duplicated on repeated failures.
     * @param {HTMLElement} terminal
     */
    function showStreamStall(terminal) {
        if (!terminal) return;
        var existing = terminal.querySelector(".log-stall-row");
        if (existing) return; // already shown
        var row = document.createElement("div");
        row.className = "log-line log-stall-row";
        row.setAttribute("role", "alert");
        var ts = document.createElement("span");
        ts.className = "l-time";
        ts.textContent = "";
        var badge = document.createElement("span");
        badge.className = "l-err";
        badge.textContent = "ERR";
        var msg = document.createElement("span");
        msg.textContent = "Stream stalled — retrying…";
        row.appendChild(ts);
        row.appendChild(badge);
        row.appendChild(msg);
        terminal.appendChild(row);
    }

    /**
     * Remove the stall-indicator row (called after a successful swap).
     * @param {HTMLElement} terminal
     */
    function clearStreamStall(terminal) {
        if (!terminal) return;
        var stall = terminal.querySelector(".log-stall-row");
        if (stall) stall.parentNode.removeChild(stall);
    }

    /**
     * Wire up all log-view behaviors once the DOM is available.
     */
    function init() {
        var root = document.getElementById("logs-root");
        if (!root) return;

        var terminal = document.getElementById("log-tail");
        var chip = root.querySelector(".follow-tail-chip");
        var grepInput = root.querySelector(".logs-grep-input");
        var clearBtn = root.querySelector(".logs-clear-btn");
        var segGroup = document.querySelector(".seg[aria-label='Level filter']");

        // Active level filter — persisted across DOM swaps.
        var activeLevel = "all";

        if (!terminal) return;

        var followTail = true;

        // --- Follow-tail: scroll handler ---
        terminal.addEventListener("scroll", function () {
            var at = isAtTail(terminal);
            if (at !== followTail) {
                followTail = at;
                updateChip(chip, followTail);
            }
        });

        // --- Follow-tail chip: click toggles the state ---
        if (chip) {
            chip.addEventListener("click", function () {
                followTail = !followTail;
                updateChip(chip, followTail);
                if (followTail) {
                    scrollToTail(terminal);
                }
            });
        }

        // --- Level filter seg buttons: update aria-pressed + thread level into poll ---
        if (segGroup) {
            segGroup.addEventListener("click", function (evt) {
                var btn = evt.target.closest("button[data-level-value]");
                if (!btn) return;
                activeLevel = btn.getAttribute("data-level-value") || "all";
                updateSegPressed(segGroup, activeLevel);

                // Update the polling trigger URL so the next swap carries the level.
                var logsBody = document.getElementById("logs-body");
                if (logsBody) {
                    logsBody.setAttribute("hx-get", buildPollUrl(activeLevel));
                    // Tell HTMX to pick up the updated attribute.
                    if (window.htmx) {
                        window.htmx.process(logsBody);
                    }
                }
            });
        }

        // --- Grep: input handler — client-side filter ---
        if (grepInput) {
            grepInput.addEventListener("input", function () {
                var val = grepInput.value;
                applyGrep(terminal, val);
                if (followTail) scrollToTail(terminal);
            });
        }

        // --- Clear: wipe the grep input and unhide all rows ---
        if (clearBtn) {
            clearBtn.addEventListener("click", function () {
                if (grepInput) {
                    grepInput.value = "";
                    applyGrep(terminal, "");
                }
                if (followTail) scrollToTail(terminal);
            });
        }

        // --- After HTMX swap: re-apply grep + follow-tail + clear stall indicator ---
        document.body.addEventListener("htmx:afterSettle", function (evt) {
            var target = evt.detail && evt.detail.target;
            if (!target) return;
            // Only react when the log-tail (the inner log container) is swapped.
            var logTail = document.getElementById("log-tail");
            if (!logTail) return;
            terminal = logTail;

            // Clear any stall indicator — swap succeeded.
            clearStreamStall(terminal);

            if (grepInput) {
                applyGrep(terminal, grepInput.value);
            }
            if (followTail) {
                scrollToTail(terminal);
            }
        });

        // --- Error state: inject stall row when HTMX poll fails ---
        document.body.addEventListener("htmx:responseError", function (evt) {
            var logTail = document.getElementById("log-tail");
            showStreamStall(logTail || terminal);
        });

        document.body.addEventListener("htmx:sendError", function (evt) {
            var logTail = document.getElementById("log-tail");
            showStreamStall(logTail || terminal);
        });

        // Initial scroll to tail on page load
        scrollToTail(terminal);
        updateChip(chip, followTail);
        updateSegPressed(segGroup, activeLevel);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
