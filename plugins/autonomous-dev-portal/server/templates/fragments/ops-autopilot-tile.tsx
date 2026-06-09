// FR-026-31 — Autopilot tile for the v3 Ops view.
//
// Design spec: /tmp/design_extract/autonomous-dev-v3/project/views.jsx
// §OpsView — `.ops-tile` "Autopilot" block.
//
// The daemon exposes `autopilot-state.json` with a `status` field (e.g.
// "running", "completed", "idle", "paused"). Per FR-026-31, fields not
// exposed by the daemon render as "unavailable" rather than being faked.

import type { FC } from "hono/jsx";

/** Autopilot lifecycle state returned by the daemon. */
export type AutopilotStatus =
    | "running"
    | "completed"
    | "idle"
    | "paused"
    | "unavailable";

export interface OpsAutopilotTileProps {
    /** Current autopilot lifecycle state. `undefined` → renders "unavailable". */
    status?: AutopilotStatus;
    /** Human-readable "next run" label (e.g. "Mon 04:00 UTC"). */
    nextRunLabel?: string;
    /** Auto-PRDs created this week / cap (e.g. "3 / 5"). */
    autoPrdsLabel?: string;
    /** Whether the operator override is currently active. */
    operatorOverride?: boolean;
    /** Per-request CSRF token forwarded from the route handler. */
    csrfToken?: string;
}

/**
 * FR-026-31 §autopilot tile.
 *
 * Renders the self-improvement loop status inside an `.ops-tile`.  When
 * `status` is absent or `"unavailable"`, the tile body shows an honest
 * disclosure rather than fabricated metrics.
 *
 * @param props - {@link OpsAutopilotTileProps}
 * @returns The autopilot tile JSX element.
 */
export const OpsAutopilotTile: FC<OpsAutopilotTileProps> = ({
    status,
    nextRunLabel = "—",
    autoPrdsLabel = "— / —",
    operatorOverride = false,
    csrfToken = "",
}) => {
    const resolved: AutopilotStatus = status ?? "unavailable";
    const isRunning = resolved === "running";
    const isPaused = resolved === "paused";
    const tone =
        isRunning ? "ok"
        : isPaused ? "warn"
        : resolved === "unavailable" ? "muted"
        : "info";

    const stateTone = tone === "muted" ? "dim" : tone;
    const stateLabel =
        isRunning ? "Running"
        : isPaused ? "Paused"
        : resolved === "idle" ? "Idle"
        : resolved === "completed" ? "Completed"
        : "—";

    return (
        <div class="ops-tile">
            <h3>Autopilot</h3>
            <div class="sub">Self-improvement loop · weekly cadence</div>
            {resolved === "unavailable" ? (
                <p class="ops-unavail">
                    Autopilot state is not tracked by this daemon version.
                </p>
            ) : (
                <dl class="ops-kv" aria-label="Autopilot metrics">
                    <div class="ops-kv-row">
                        <span
                            class={`dot ${stateTone}`}
                            aria-hidden="true"
                        />
                        <dt class="ops-kv-k">Status</dt>
                        <dd class="ops-kv-v">{stateLabel}</dd>
                    </div>
                    <div class="ops-kv-row">
                        <span class="dot-placeholder" aria-hidden="true" />
                        <dt class="ops-kv-k">Next run</dt>
                        <dd class="ops-kv-v">{nextRunLabel}</dd>
                    </div>
                    <div class="ops-kv-row">
                        <span class="dot-placeholder" aria-hidden="true" />
                        <dt class="ops-kv-k">Auto-PRDs / wk</dt>
                        <dd class="ops-kv-v">{autoPrdsLabel}</dd>
                    </div>
                    <div class="ops-kv-row">
                        <span class="dot-placeholder" aria-hidden="true" />
                        <dt class="ops-kv-k">Operator override</dt>
                        <dd class="ops-kv-v">
                            {operatorOverride ? "on" : "off"}
                        </dd>
                    </div>
                </dl>
            )}
            <div class="ops-tile-actions">
                {resolved !== "unavailable" ? (
                    <>
                        <form
                            method="POST"
                            action={isPaused ? "/ops/autopilot/resume" : "/ops/autopilot/pause"}
                            class="ops-tile-form"
                        >
                            <input
                                type="hidden"
                                name="_csrf"
                                value={csrfToken}
                            />
                            <button
                                class="btn sm"
                                type="submit"
                                aria-label={isPaused ? "Resume autopilot" : "Pause autopilot"}
                            >
                                {isPaused ? "Resume" : "Pause"}
                            </button>
                        </form>
                        <form
                            method="POST"
                            action="/ops/autopilot/scan"
                            class="ops-tile-form"
                        >
                            <input
                                type="hidden"
                                name="_csrf"
                                value={csrfToken}
                            />
                            <button
                                class="btn sm ghost"
                                type="submit"
                            >
                                Force scan
                            </button>
                        </form>
                    </>
                ) : null}
            </div>
        </div>
    );
};
