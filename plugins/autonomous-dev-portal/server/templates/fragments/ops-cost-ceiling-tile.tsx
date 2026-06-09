// FR-026-31 — Cost-ceiling meter tile for the v3 Ops view.
//
// Design spec: /tmp/design_extract/autonomous-dev-v3/project/views.jsx
// §OpsView — `.ops-tile` "Cost ceiling" block.
//
// Reads the monthly cap and current MTD spend from the OpsHealth shape
// (populated by the route from settings-reader + cost aggregator).  When
// no cap data is available, renders an honest "unavailable" state.

import type { FC } from "hono/jsx";

export interface OpsCostCeilingTileProps {
    /** Current month-to-date spend in USD. `undefined` → unavailable. */
    mtdUsd?: number;
    /** Configured monthly cap in USD. `undefined` → unavailable. */
    capUsd?: number;
    /** EOM forecast in USD (optional; not always derivable). */
    forecastUsd?: number;
}

/**
 * FR-026-31 §cost-ceiling tile.
 *
 * Renders a linear progress meter showing MTD spend vs. the monthly cap.
 * Auto-pauses at 90 percent; the bar transitions from `ok` → `warn` at
 * 80 percent and `err` at 100 percent.
 *
 * @param props - {@link OpsCostCeilingTileProps}
 * @returns The cost-ceiling tile JSX element.
 */
export const OpsCostCeilingTile: FC<OpsCostCeilingTileProps> = ({
    mtdUsd,
    capUsd,
    forecastUsd,
}) => {
    const hasData =
        typeof mtdUsd === "number" && typeof capUsd === "number" && capUsd > 0;

    const pct = hasData ? Math.min(100, (mtdUsd! / capUsd!) * 100) : 0;
    const pctRounded = Math.round(pct * 10) / 10;
    // Integer bucket (0–100) used for the .pct-N CSS class to avoid inline
    // style= attributes, which the portal CSP forbids.
    const pctClass = Math.min(100, Math.round(pct));

    const barTone =
        pct >= 100 ? "err"
        : pct >= 80 ? "warn"
        : "ok";

    const headroomUsd =
        hasData ? capUsd! - mtdUsd! : null;

    return (
        <div class="ops-tile">
            <h3>Cost ceiling</h3>
            <div class="sub">Monthly cap · auto-pause at 90%</div>
            {hasData ? (
                <>
                    <div class="cost-meter" role="meter" aria-valuenow={pctRounded} aria-valuemin={0} aria-valuemax={100} aria-label={`Cost ceiling: ${pctRounded}% used`}>
                        <div class="cost-meter-track">
                            <div
                                class={`cost-meter-fill ${barTone} pct-${pctClass}`}
                            />
                            <div class="cost-meter-pause-mark" aria-hidden="true" />
                        </div>
                    </div>
                    <div class="cost-meter-labels">
                        <span class="cost-meter-cur">
                            ${mtdUsd!.toFixed(2)} MTD
                        </span>
                        <span class="cost-meter-cap dim">
                            / ${capUsd!.toFixed(2)} cap
                        </span>
                    </div>
                    <dl class="ops-kv cost-forecast" aria-label="Cost forecast">
                        {typeof forecastUsd === "number" ? (
                            <div class="ops-kv-row">
                                <span class="dot-placeholder" aria-hidden="true" />
                                <dt class="ops-kv-k">forecast EOM</dt>
                                <dd class="ops-kv-v">
                                    ${forecastUsd.toFixed(2)}
                                </dd>
                            </div>
                        ) : null}
                        {headroomUsd !== null ? (
                            <div class="ops-kv-row">
                                <span class="dot-placeholder" aria-hidden="true" />
                                <dt class="ops-kv-k">headroom</dt>
                                <dd class={`ops-kv-v ${headroomUsd < 0 ? "err" : "ok"}`}>
                                    {headroomUsd >= 0 ? "+" : ""}${headroomUsd.toFixed(2)}
                                </dd>
                            </div>
                        ) : null}
                    </dl>
                </>
            ) : (
                <p class="ops-unavail">
                    Cost cap configuration is not available. Configure a
                    monthly cap in Settings to enable ceiling monitoring.
                </p>
            )}
        </div>
    );
};
