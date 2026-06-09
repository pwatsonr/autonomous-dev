// FR-026-31 — Kill-switch tile for the v3 Ops view.
//
// Wraps the shared `<KillSwitch>` component in the design-specified
// `.kill-tile` chrome. The kill-switch state machine (arm → confirm →
// engaged) lives in server/routes/kill-switch.tsx; this fragment is
// purely presentational and defers all transitions to that route via
// the existing HTMX endpoints.
//
// Design spec: /tmp/design_extract/autonomous-dev-v3/project/views.jsx
// §OpsView — `.kill-tile` block.

import type { FC } from "hono/jsx";

import { KillSwitch } from "../../components/kill-switch";
import type { KillSwitchState } from "../../types/render";

export interface OpsKillTileProps {
    /** Kill-switch idle/armed/engaged state from `readOpsHealth()`. */
    killSwitch?: KillSwitchState;
    /** Per-request CSRF token forwarded from the route handler. */
    csrfToken?: string;
    /** Number of in-flight requests at time of render (for display only). */
    inFlightCount?: number;
    /** Human-readable label for last engagement ("14d ago", "never"). */
    lastEngagedLabel?: string;
    /** Cooldown display label (e.g. "3.0s"). */
    cooldownLabel?: string;
}

/**
 * FR-026-31 §kill-switch tile.
 *
 * Renders the `.kill-tile` container from the v3 design. The tile has a
 * 4px `var(--err)` left border and an `.engaged` modifier when the kill
 * switch is active. The actual engage/disarm form lives inside the shared
 * `<KillSwitch>` component which is swapped via HTMX on each state
 * transition.
 *
 * @param props - {@link OpsKillTileProps}
 * @returns The kill-switch tile JSX element.
 */
export const OpsKillTile: FC<OpsKillTileProps> = ({
    killSwitch,
    csrfToken = "",
    inFlightCount = 0,
    lastEngagedLabel = "never",
    cooldownLabel = "3.0s",
}) => {
    const engaged = killSwitch?.engaged === true;
    const armed = killSwitch?.armed === true;
    const armedAt = killSwitch?.armedAt;

    return (
        <div class={`kill-tile${engaged ? " engaged" : ""} sec`}>
            <div class="kill-tile-inner">
                <div class="kill-tile-body">
                    <h3>Kill switch · {engaged ? "ENGAGED" : "armed"}</h3>
                    <p class="kill-tile-desc">
                        Engaging halts every running agent within ~3s,
                        returns in-flight requests to the queue, and refuses
                        new external requests until disarmed. The daemon stays
                        up so observability survives.
                    </p>
                    <div class="kill-tile-meta">
                        <span>
                            last engaged{" "}
                            <strong>{lastEngagedLabel}</strong>
                        </span>
                        <span>
                            cooldown <strong>{cooldownLabel}</strong>
                        </span>
                        <span>
                            in-flight{" "}
                            <strong>{String(inFlightCount)} req</strong>
                        </span>
                    </div>
                </div>
                <div class="kill-tile-action">
                    <KillSwitch
                        engaged={engaged}
                        armed={armed}
                        armedAt={armedAt}
                        csrfToken={csrfToken}
                        onConfirm="/ops/kill-switch"
                    />
                    <span class="kill-tile-note">
                        requires double-confirm · operator only
                    </span>
                </div>
            </div>
        </div>
    );
};
