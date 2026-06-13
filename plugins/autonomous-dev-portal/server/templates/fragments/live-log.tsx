/* lint:no-hex-allow #14130f — theme-defying log container per TDD-036 §6.4 */
// SPEC-036-2-06 §LiveLog — dark, theme-defying log tail.
//
// FR-026-32 — v3 rework: renders a `.log` terminal container with three
// columns (timestamp | level-badge | message). Uses exclusively
// CSS class-based styling (no inline style= attributes; CSP-clean).
//
// Per-level coloring resolves via tokens defined in design-tokens.css:
//   INFO  → var(--log-info)   → span.l-info
//   WARN  → var(--log-warn)   → span.l-warn
//   ERROR → var(--log-err)    → span.l-err
//   OK    → var(--log-ok)     → span.l-ok
//   marker lines (phase|deploy|agent ...) → span.l-mark (bold)
//   timestamps → span.l-time  → var(--log-time)
//
// Layout: each `.log-line` is a three-column pre-whitespace line:
//   .l-time   — timestamp (fixed-width)
//   .l-info|.l-warn|.l-err|.l-ok — level badge
//   .l-mark   — tone-colored marker message (or bare <span> for plain lines)
//
// The `.log` container class is defined in app.css (dark terminal background,
// monospace, overflow scroll). The v3 logs.css extends it with column sizing.

import type { FC } from "hono/jsx";

import type { LogEntry } from "../../types/render";

/** Drop DEBUG/TRACE before render (FR-4). */
function isVisibleLevel(level: string): boolean {
    const u = level.toUpperCase();
    return (
        u === "INFO" ||
        u === "WARN" ||
        u === "ERROR" ||
        u === "ERR" ||
        u === "OK"
    );
}

/**
 * Returns the CSS class for the level badge span.
 * ERR and ERROR both map to `l-err`.
 */
function levelClass(level: string): string {
    const u = level.toUpperCase();
    if (u === "ERROR" || u === "ERR") return "l-err";
    if (u === "WARN") return "l-warn";
    if (u === "OK") return "l-ok";
    return "l-info";
}

/** Returns true when the message text matches the marker pattern. */
function isMarker(message: string): boolean {
    return /^(phase|deploy|agent)\b/i.test(message);
}

export interface LiveLogProps {
    entries: LogEntry[];
    /** When true, the daemon is offline — overrides entries with a single line. */
    offline?: boolean;
    /**
     * When true, the log read failed server-side — renders a single `.l-err`
     * system row so the user sees an honest signal rather than stale rows or
     * a blank terminal. The client-side stall row (logs-view.js) handles the
     * case where the HTMX poll itself fails at the network/transport layer.
     */
    readError?: boolean;
}

/**
 * FR-026-32 — Live log terminal fragment.
 *
 * Renders a dark `.log` terminal container populated with three-column
 * log-line rows. Each row has a `.l-time` timestamp span, a tone-classed
 * level badge, and either a `.l-mark` message (for phase/deploy/agent lines)
 * or a bare `<span>` for normal lines. CSP-clean: no inline `style=` attrs.
 *
 * The outer `.log` container (id="log-tail") carries `role="log"` and
 * `aria-live="polite"`. It must remain persistent across HTMX swaps — only
 * its innerHTML is replaced. Replacing the node itself destroys the
 * live-region and silences AT announcements (NVDA/JAWS/VoiceOver).
 *
 * Row shape:
 *   <div class="log-line">
 *     <span class="l-time">HH:MM:SS</span>
 *     <span class="l-info|l-warn|l-err|l-ok">LEVEL</span>
 *     <span class="l-mark">…</span>  <!-- marker lines only -->
 *     <span>…</span>                 <!-- non-marker lines -->
 *   </div>
 *
 * @param props - {@link LiveLogProps}
 */
/** "2026-06-12T20:40:34Z" -> "20:40:34" (full ISO stays on title=). The
 *  raw ISO wrapped at the T inside the narrow time column, splitting
 *  every entry across two lines (crawl p10). */
function timeOnly(ts: string): string {
    const m = ts.match(/(?:^|T)(\d{2}:\d{2}:\d{2})/);
    return m?.[1] ?? ts;
}

export const LiveLog: FC<LiveLogProps> = ({ entries, offline = false, readError = false }) => {
    if (readError) {
        return (
            <div
                class="log"
                id="log-tail"
                role="log"
                aria-label="Daemon log stream"
                aria-live="polite"
            >
                <div class="log-line" role="alert">
                    <span class="l-time"></span>
                    <span class="l-err">ERR</span>
                    <span>Log read failed — retrying…</span>
                </div>
            </div>
        );
    }

    if (offline) {
        return (
            <div
                class="log"
                id="log-tail"
                role="log"
                aria-label="Daemon log stream"
                aria-live="polite"
            >
                <div class="log-line">
                    <span class="l-time"></span>
                    <span class="l-info">INFO</span>
                    <span>Daemon offline</span>
                </div>
            </div>
        );
    }

    const visible = entries.filter((e) => isVisibleLevel(e.level));

    if (visible.length === 0) {
        return (
            <div
                class="log"
                id="log-tail"
                role="log"
                aria-label="Daemon log stream"
                aria-live="polite"
            >
                <div class="log-line">
                    <span class="l-time"></span>
                    <span class="l-info">INFO</span>
                    <span>No log entries yet</span>
                </div>
            </div>
        );
    }

    return (
        <div
            class="log"
            id="log-tail"
            role="log"
            aria-label="Daemon log stream"
            aria-live="polite"
        >
            {visible.map((e, i) => {
                const lvlCls = levelClass(e.level);
                const marker = isMarker(e.message);
                return (
                    <div class="log-line" key={i}>
                        <span class="l-time" title={e.ts}>
                            {timeOnly(e.ts)}
                        </span>
                        <span class={lvlCls}>{e.level.toUpperCase()}</span>
                        {marker ? (
                            <span class="l-mark">{e.message}</span>
                        ) : (
                            <span>{e.message}</span>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
