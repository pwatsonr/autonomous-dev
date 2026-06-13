// SPEC-013-3-03 §Views — logs view component.
// FR-026-32 — v3 rework: full terminal layout with Topbar, filter strip,
// follow-tail chip, tone-colored log rows, and HTMX polling.

import { asset } from "../../lib/plugin-version";
import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { Topbar } from "../../components/topbar";
import { LiveLog } from "../fragments/live-log";
import type { LogEntry } from "../../types/render";

// Pre-computed hx-trigger value — double-quotes inside bracket expression.
const LOGS_POLLING_TRIGGER =
    'every 5s [document.visibilityState === "visible"]';

/**
 * Converts a `LogLine` (render-types shape, lowercase `level`) into the
 * `LogEntry` shape that `LiveLog` consumes. Both have identical field names;
 * this is a no-op type coercion but explicit for clarity.
 */
function toLogEntry(l: { ts: string; level: string; message: string }): LogEntry {
    return { ts: l.ts, level: l.level, message: l.message };
}

/**
 * FR-026-32 — Logs view.
 *
 * Renders the v3 terminal-style log page:
 *   - Sticky `<Topbar>` with "Logs" title, "streaming" subtitle, live indicator
 *   - Filter strip with grep input, follow-tail chip, and segmented level filter
 *   - Dark `.log` terminal via `<LiveLog>` (tone-colored rows, 3 columns)
 *
 * HTMX polling targets `#log-tail` (the inner `role="log"` live-region node)
 * via `hx-swap="innerHTML"` every 5 s when the tab is visible. This keeps
 * the `role="log" aria-live="polite"` container persistent across swaps so
 * AT live-region announcements fire correctly (replacing the node itself
 * produces no announcement in NVDA/JAWS/VoiceOver — finding 6).
 *
 * Level filter state is threaded through the poll URL by logs-view.js so
 * refreshes carry the active level and aria-pressed stays accurate.
 *
 * Client-side follow-tail, grep, aria-pressed management, and error-state
 * handling are in `/static/js/logs-view.js` (loaded via the `<head>` slot).
 *
 * @param props - `{ lines: LogLine[] }` from the route handler.
 */
export const LogsView: FC<RenderProps["logs"]> = ({ lines, readError }) => {
    const entries = lines.map(toLogEntry);

    return (
        <>
            <Topbar
                title="Logs"
                subTitle="streaming"
                liveIndicator
                rightSlot={
                    <div class="seg" role="group" aria-label="Level filter">
                        {/* data-level-value lets logs-view.js identify the
                            active button without parsing hx-get URLs.
                            aria-pressed is managed client-side on click so it
                            reflects state immediately (before the next swap). */}
                        <button
                            class="active"
                            type="button"
                            data-level-value="all"
                            hx-get="/logs"
                            hx-target="#log-tail"
                            hx-swap="innerHTML"
                            hx-select="#log-tail"
                            aria-pressed="true"
                        >
                            All
                        </button>
                        <button
                            type="button"
                            data-level-value="error"
                            hx-get="/logs?level=error"
                            hx-target="#log-tail"
                            hx-swap="innerHTML"
                            hx-select="#log-tail"
                            aria-pressed="false"
                        >
                            Errors
                        </button>
                        <button
                            type="button"
                            data-level-value="warn"
                            hx-get="/logs?level=warn"
                            hx-target="#log-tail"
                            hx-swap="innerHTML"
                            hx-select="#log-tail"
                            aria-pressed="false"
                        >
                            Warn
                        </button>
                        <button
                            type="button"
                            data-level-value="info"
                            hx-get="/logs?level=info"
                            hx-target="#log-tail"
                            hx-swap="innerHTML"
                            hx-select="#log-tail"
                            aria-pressed="false"
                        >
                            Info
                        </button>
                    </div>
                }
            />

            {/* logs-view.js — follow-tail + client-side grep + level-filter
                aria-pressed management + error state; loaded here so it is
                scoped to this page only. The module self-initialises on
                DOMContentLoaded and re-binds after htmx:afterSettle swaps. */}
            <script src={asset("/static/js/logs-view.js")} type="module"></script>

            <div class="main-inner" id="logs-root">
                {/* Filter strip: grep input + follow-tail chip + clear button */}
                <div class="filter-strip">
                    <input
                        class="search logs-grep-input"
                        type="search"
                        placeholder="grep across log stream…"
                        aria-label="Filter log lines"
                        autocomplete="off"
                        spellcheck={false}
                    />
                    <button
                        type="button"
                        class="chip info follow-tail-chip active"
                        aria-label="Follow tail"
                        aria-pressed="true"
                    >
                        follow tail
                    </button>
                    <button
                        type="button"
                        class="btn sm ghost logs-clear-btn"
                        aria-label="Clear grep filter"
                    >
                        Clear
                    </button>
                    <span class="spacer"></span>
                </div>

                {/* Polled log body — section wraps the persistent live-region.
                    hx-get is updated by logs-view.js to thread the active level
                    filter so every 5 s refresh carries the current state.
                    hx-target="#log-tail" + hx-swap="innerHTML" preserves the
                    role=log/aria-live node so AT announcements fire correctly. */}
                <section
                    id="logs-body"
                    hx-get="/logs"
                    hx-trigger={LOGS_POLLING_TRIGGER}
                    hx-target="#log-tail"
                    hx-swap="innerHTML"
                    hx-select="#log-tail"
                    aria-label="Log stream"
                >
                    <LiveLog entries={entries} readError={readError} />
                </section>
            </div>
        </>
    );
};
