// FR-026-31 — Daemon health tile for the v3 Ops view.
//
// Design spec: /tmp/design_extract/autonomous-dev-v3/project/views.jsx
// §OpsView — `.ops-tile` "Daemon" block.
//
// Reads daemon status from `OpsHealth.daemon` populated by
// `readOpsHealth()`. Fields the daemon does NOT expose (e.g. memory)
// render as "—" rather than fabricated values.

import type { FC } from "hono/jsx";

export interface OpsDaemonTileProps {
    /** Daemon status string ("running", "stale", "dead", "fresh", etc.). */
    status: string;
    /** Daemon PID, or `null` when not running. */
    pid: number | null;
    /** Human-readable uptime label (e.g. "4d 02h", "alive", "—"). */
    uptime?: string;
    /** Port the daemon listens on. */
    port?: number;
    /** Runtime label (e.g. "Bun", "Node"). */
    runtime?: string;
    /** Per-request CSRF token forwarded from the route handler. */
    csrfToken?: string;
}

/**
 * FR-026-31 §daemon health tile.
 *
 * Renders a compact key-value list of daemon runtime metrics inside an
 * `.ops-tile`. Fields that the daemon does not expose (memory, exact
 * port) render as "—" so the display is honest about what is known.
 *
 * @param props - {@link OpsDaemonTileProps}
 * @returns The daemon tile JSX element.
 */
export const OpsDaemonTile: FC<OpsDaemonTileProps> = ({
    status,
    pid,
    uptime = "—",
    port,
    runtime = "Bun",
    csrfToken = "",
}) => {
    const isRunning = status === "running" || status === "fresh";
    const heartbeatTone = isRunning ? "ok" : "err";
    const heartbeatLabel = isRunning ? "alive" : status;

    return (
        <div class="ops-tile">
            <h3>Daemon</h3>
            <div class="sub">{runtime} runtime · single-operator</div>
            <dl class="ops-kv" aria-label="Daemon runtime metrics">
                <div class="ops-kv-row">
                    <span
                        class={`dot ${heartbeatTone}`}
                        aria-hidden="true"
                    />
                    <dt class="ops-kv-k">Heartbeat</dt>
                    <dd class="ops-kv-v">{heartbeatLabel}</dd>
                </div>
                <div class="ops-kv-row">
                    <span class="dot-placeholder" aria-hidden="true" />
                    <dt class="ops-kv-k">PID</dt>
                    <dd class="ops-kv-v">
                        {pid !== null ? String(pid) : "—"}
                    </dd>
                </div>
                <div class="ops-kv-row">
                    <span class="dot-placeholder" aria-hidden="true" />
                    <dt class="ops-kv-k">Uptime</dt>
                    <dd class="ops-kv-v">{uptime}</dd>
                </div>
                <div class="ops-kv-row">
                    <span class="dot-placeholder" aria-hidden="true" />
                    <dt class="ops-kv-k">Memory</dt>
                    <dd class="ops-kv-v dim">—</dd>
                </div>
                {typeof port === "number" ? (
                    <div class="ops-kv-row">
                        <span class="dot-placeholder" aria-hidden="true" />
                        <dt class="ops-kv-k">Port</dt>
                        <dd class="ops-kv-v">
                            {String(port)} (localhost)
                        </dd>
                    </div>
                ) : null}
            </dl>
            <div class="ops-tile-actions">
                <button
                    class="btn sm"
                    type="button"
                    hx-post="/ops/daemon/reload-config"
                    hx-vals={`{"_csrf":"${csrfToken}"}`}
                    hx-target="#ops-page-root"
                    hx-swap="outerHTML"
                >
                    Reload config
                </button>
                <a class="btn sm ghost" href="/logs">
                    Tail logs →
                </a>
            </div>
        </div>
    );
};
