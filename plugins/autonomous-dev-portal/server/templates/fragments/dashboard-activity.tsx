// FR-026-12 — Activity feed fragment.
//
// View-local fragment. Renders the 10-row activity tail inside a `.card`
// wrapper. The newest row (index 0) receives the `.live` flash animation.
// Each row uses the `.feed-row` 4-column grid:
//   timestamp | actor chip | verb/subject | reference label
//
// Presentational note: feed data comes from buildActivityFeed() in
// dashboard-readers.ts, which returns a deterministic seeded list when
// live readers are unavailable.

import type { FC } from "hono/jsx";
import type { ActivityRow } from "../../wiring/dashboard-readers";

/** Map tone string to chip class */
function chipClass(tone: ActivityRow["tone"]): string {
    if (tone === "ok") return "chip ok";
    if (tone === "warn") return "chip warn";
    if (tone === "err") return "chip err";
    return "chip info";
}

export interface DashboardActivityFeedProps {
    rows: ActivityRow[];
}

/**
 * FR-026-12 — Activity feed.
 *
 * Renders up to 10 activity rows. The top row is flagged `.live` which
 * triggers a CSS fade animation (defined in app.css `@keyframes fadeBg`).
 * A streaming dot indicator appears in the card header.
 */
export const DashboardActivityFeed: FC<DashboardActivityFeedProps> = ({
    rows,
}) => {
    const visible = rows.slice(0, 10);
    return (
        <div class="card" role="log" aria-label="Activity feed" aria-live="polite" aria-relevant="additions">
            <div class="card-h">
                <h3>Activity feed</h3>
                <span class="meta">tail · last 10m</span>
                <span class="spacer"></span>
                <span class="live-indicator" aria-label="Streaming live">
                    <span class="dot live" aria-hidden="true"></span>
                    Streaming
                </span>
            </div>
            <div class="feed">
                {visible.map((row, i) => (
                    <div class={`feed-row${i === 0 ? " live" : ""}`} key={`${row.t}-${row.a}`}>
                        <span class="t">{row.t}</span>
                        {/* font-size token applied via .feed-row .chip in dashboard.css */}
                        <span class={chipClass(row.tone)}>
                            {row.a}
                        </span>
                        <span class="a">{row.v}</span>
                        <span class="r">{row.r}</span>
                    </div>
                ))}
            </div>
        </div>
    );
};
