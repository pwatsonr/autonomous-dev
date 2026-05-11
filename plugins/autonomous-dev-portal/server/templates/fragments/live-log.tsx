/* lint:no-hex-allow #14130f — theme-defying log container per TDD-036 §6.4 */
// SPEC-036-2-06 §LiveLog — dark, theme-defying log tail.
//
// Renders the last 50 INFO/WARN/ERROR entries from
// `~/.autonomous-dev/logs/daemon.log` (server-trimmed before this
// fragment runs). DEBUG / TRACE entries are dropped before render. The
// container background is the literal `#14130f` regardless of the
// active theme — the single documented exception to the no-hex CI lint,
// whitelisted via the comment on line 1.
//
// Per-level coloring (FR-3) resolves via tokens:
//   INFO  → var(--info)
//   WARN  → var(--warn)
//   ERROR → var(--err)
//   markers (phase|deploy|agent ...) → var(--brand) bold
//   timestamps → var(--fg-2)
//
// Layout (FR-9): each line is a CSS grid 11ch / 6ch / 1fr (timestamp,
// level, message) — the .log-line class in portal.css supplies the
// grid template; the fragment only emits the spans.
//
// Per-line markup (SPEC-037-6-02): the kit defines color tiers only
// on `.l-time / .l-info / .l-warn / .l-err / .l-mark` (app.css:331-336
// + 669). The legacy `.ts / .lvl / .lvl-* / .msg` names rendered
// uncolored. This fragment now emits the kit's flat-span shape and
// places the marker treatment INSIDE the line as a `<span class="l-mark">`
// instead of the row-level `marker` modifier the kit no longer styles.

import type { FC } from "hono/jsx";

import type { LogEntry } from "../../types/render";

/** Per-level CSS class name. INFO/WARN/ERROR map to colored level spans.
 *  Per SPEC-037-6-02, emits the kit's flat span classes (no `.lvl` prefix). */
function levelClass(level: string): string {
    const u = level.toUpperCase();
    if (u === "ERROR" || u === "ERR") return "l-err";
    if (u === "WARN") return "l-warn";
    return "l-info";
}

/** Match agent dispatch lines for the bold/brand "marker" treatment. */
const MARKER_RE = /^(phase|deploy|agent)\b/i;
const AGENT_DISPATCH_RE = /^agent .* (dispatched|finished)/i;

function isMarker(message: string): boolean {
    return MARKER_RE.test(message) || AGENT_DISPATCH_RE.test(message);
}

/** Drop DEBUG/TRACE before render. FR-4. */
function isVisibleLevel(level: string): boolean {
    const u = level.toUpperCase();
    return u === "INFO" || u === "WARN" || u === "ERROR" || u === "ERR";
}

const CONTAINER_STYLE =
    "background: #14130f; max-height: 320px; overflow: auto; scroll-behavior: smooth;";

export interface LiveLogProps {
    entries: LogEntry[];
    /** When true, the daemon is offline — overrides entries with a single line. */
    offline?: boolean;
}

export const LiveLog: FC<LiveLogProps> = ({ entries, offline = false }) => {
    if (offline) {
        return (
            <div class="log" id="log-tail" style={CONTAINER_STYLE}>
                <div class="log-line muted meta-mono">
                    <span class="l-time" />
                    <span class="l-info" />
                    <span>Daemon offline</span>
                </div>
            </div>
        );
    }

    const visible = entries.filter((e) => isVisibleLevel(e.level));

    if (visible.length === 0) {
        return (
            <div class="log" id="log-tail" style={CONTAINER_STYLE}>
                <div class="log-line muted meta-mono">
                    <span class="l-time" />
                    <span class="l-info" />
                    <span>No log entries yet</span>
                </div>
            </div>
        );
    }

    return (
        <div class="log" id="log-tail" style={CONTAINER_STYLE}>
            {visible.map((e) => {
                const marker = isMarker(e.message);
                return (
                    <div class="log-line">
                        <span class="l-time">{e.ts}</span>
                        <span class={levelClass(e.level)}>
                            {e.level.toUpperCase()}
                        </span>
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
