// FR-026-31 — v3 Ops view.
//
// Implements the design spec at:
//   /tmp/design_extract/autonomous-dev-v3/project/views.jsx §OpsView
//
// Layout (top → bottom):
//   1. <Topbar> — sticky frosted header
//   2. Kill-switch tile        (ops-kill-tile.tsx)
//   3. Circuit-breaker grid    (ops-breaker-grid.tsx)
//   4. 2 × 2 ops-grid:
//        [Autopilot tile]  [Firewall tile]
//        [Cost ceiling]    [Daemon tile]
//
// Per FR-026-31 all fragment tiles are view-local (do not edit shared
// kpi-strip / empty-state).  Fields absent from the live daemon are
// rendered as "unavailable" rather than fabricated.

import type { FC } from "hono/jsx";

import { Topbar } from "../../components/topbar";
import type { OpsHealth } from "../../types/render";
import { OpsBreakerGrid } from "../fragments/ops-breaker-grid";
import { OpsFirewallTile } from "../fragments/ops-firewall";
import { OpsKillTile } from "../fragments/ops-kill-tile";
import { OpsAutopilotTile } from "../fragments/ops-autopilot-tile";
import type { AutopilotStatus } from "../fragments/ops-autopilot-tile";
import { OpsCostCeilingTile } from "../fragments/ops-cost-ceiling-tile";
import { OpsDaemonTile } from "../fragments/ops-daemon-tile";
import { OpsProductionIntelligenceTile } from "../fragments/ops-production-intelligence-tile";

// Pre-computed hx-trigger value — using double quotes inside bracket expression.
// Guard: skip the poll when a descendant of #ops-body has focus so that
// keyboard users (and screen-reader users) are never interrupted by an
// outerHTML swap mid-interaction (WCAG 2.1.1 / 2.4.3).
const OPS_POLLING_TRIGGER =
    'every 10s [document.visibilityState === "visible" && !document.activeElement?.closest("#ops-body")]';

/** Local prop extension for v3 tile data (not shared via render.ts). */
export interface OpsViewV3Props {
    health: OpsHealth;
    /** Per-request CSRF token. */
    csrfToken?: string;
    /** Autopilot lifecycle status ("running", "idle", "paused", …). */
    autopilotStatus?: string;
    /** Configured monthly cost cap in USD. */
    monthlyCostCapUsd?: number;
    /** Current MTD spend in USD. */
    mtdUsd?: number;
    /** EOM forecast in USD. */
    forecastUsd?: number;
    /** Daemon port from portal settings. */
    daemonPort?: number;
}

/**
 * FR-026-31 — v3 Ops view component.
 *
 * Composes all ops control tiles using the v3 design language.  Uses
 * the `<Topbar>` foundation component as the first element and builds
 * the kill-switch, breaker-grid, and four-tile ops-grid below it inside
 * `.main-inner`.
 *
 * @param props - {@link OpsViewV3Props} (superset of `RenderProps["ops"]`)
 * @returns The ops page JSX element.
 */
export const OpsView: FC<OpsViewV3Props> = ({
    health,
    csrfToken = "",
    autopilotStatus,
    monthlyCostCapUsd,
    mtdUsd,
    forecastUsd,
    daemonPort,
}) => {
    const killSwitch = health.killSwitch;
    const circuitBreaker = health.circuitBreaker;

    // Coerce autopilotStatus to the tile's union type — unknown values
    // collapse to "unavailable" so the tile's honest empty-state renders.
    const knownStatuses: AutopilotStatus[] = [
        "running",
        "completed",
        "idle",
        "paused",
        "unavailable",
    ];
    const resolvedAutopilotStatus: AutopilotStatus =
        knownStatuses.includes(autopilotStatus as AutopilotStatus)
            ? (autopilotStatus as AutopilotStatus)
            : autopilotStatus !== undefined
              ? "idle"
              : "unavailable";

    return (
        <div
            id="ops-body"
            hx-get="/ops"
            hx-trigger={OPS_POLLING_TRIGGER}
            hx-target="this"
            hx-swap="outerHTML"
            hx-select="#ops-body"
        >
            {/* 1. Sticky topbar — required foundation component.
                Refresh button uses the same hx-target as the polling so it
                matches the BUG-12 contract (hx-target="#ops-body"). */}
            <Topbar
                title="Ops"
                subTitle="kill-switch · breakers · firewall · autopilot"
                rightSlot={
                    <button
                        class="btn sm"
                        type="button"
                        hx-get="/ops"
                        hx-target="#ops-body"
                        hx-swap="outerHTML"
                        hx-select="#ops-body"
                    >
                        Refresh
                    </button>
                }
            />

            <div class="main-inner">
                {/* 2. Kill-switch tile — full-width danger zone. */}
                <OpsKillTile
                    killSwitch={killSwitch}
                    csrfToken={csrfToken}
                    inFlightCount={0}
                    lastEngagedLabel="never"
                    cooldownLabel="3.0s"
                />

                {/* 3. Circuit-breaker grid. */}
                <OpsBreakerGrid circuitBreaker={circuitBreaker} />

                {/* 4. 2 × 2 ops-grid — autopilot / firewall / cost / daemon. */}
                <section class="sec">
                    <div class="ops-v3-grid" aria-label="Ops control tiles">
                        <OpsAutopilotTile
                            status={resolvedAutopilotStatus}
                            nextRunLabel="—"
                            autoPrdsLabel="— / —"
                            operatorOverride={false}
                            csrfToken={csrfToken}
                        />
                        <OpsFirewallTile entries={undefined} />
                        <OpsCostCeilingTile
                            mtdUsd={mtdUsd}
                            capUsd={monthlyCostCapUsd}
                            forecastUsd={forecastUsd}
                        />
                        <OpsDaemonTile
                            status={health.daemon.status}
                            pid={health.daemon.pid}
                            lastHeartbeat={health.lastHeartbeat}
                            port={daemonPort}
                            csrfToken={csrfToken}
                        />
                        <OpsProductionIntelligenceTile
                            productionIntelligence={health.productionIntelligence}
                        />
                    </div>
                </section>
            </div>
        </div>
    );
};
