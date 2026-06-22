// #562 / FR-938 — Production-intelligence tile for the v3 Ops view.
//
// Surfaces the observe loop's LAST completed cycle, read from
// `OpsHealth.productionIntelligence` (wiring/ops-readers.ts →
// production-intelligence.json, written by the observe runner). When no
// cycle has run yet the field is undefined and we render an honest
// "no observe cycle yet" empty state rather than fabricated zeros.

import type { FC } from "hono/jsx";

import type { ProductionIntelligenceState } from "../../types/render";

export interface OpsProductionIntelligenceTileProps {
    /** Last-cycle summary from `readOpsHealth()`, or undefined when none has run. */
    productionIntelligence?: ProductionIntelligenceState;
}

/**
 * #562 §production-intelligence tile.
 *
 * Renders a compact key-value list of the most recent observe cycle's
 * counts inside an `.ops-tile`. Mirrors the daemon tile's structure so the
 * 2×N ops-grid stays visually uniform.
 *
 * @param props - {@link OpsProductionIntelligenceTileProps}
 * @returns The production-intelligence tile JSX element.
 */
export const OpsProductionIntelligenceTile: FC<
    OpsProductionIntelligenceTileProps
> = ({ productionIntelligence }) => {
    if (productionIntelligence === undefined) {
        return (
            <div class="ops-tile">
                <h3>Production intelligence</h3>
                <div class="sub">observe loop · last cycle</div>
                <dl class="ops-kv" aria-label="Production intelligence">
                    <div class="ops-kv-row">
                        <span class="dot-placeholder" aria-hidden="true" />
                        <dt class="ops-kv-k">Last cycle</dt>
                        <dd class="ops-kv-v dim">no observe cycle yet</dd>
                    </div>
                </dl>
            </div>
        );
    }

    const pi = productionIntelligence;
    const errorTone = pi.errorCount > 0 ? "err" : "ok";

    return (
        <div class="ops-tile">
            <h3>Production intelligence</h3>
            <div class="sub">observe loop · last cycle</div>
            <dl class="ops-kv" aria-label="Production intelligence">
                <div class="ops-kv-row">
                    <span class={`dot ${errorTone}`} aria-hidden="true" />
                    <dt class="ops-kv-k">Last run</dt>
                    <dd class="ops-kv-v">{pi.lastRunId ?? "—"}</dd>
                </div>
                <div class="ops-kv-row">
                    <span class="dot-placeholder" aria-hidden="true" />
                    <dt class="ops-kv-k">Completed</dt>
                    <dd class="ops-kv-v">{pi.lastRunAt ?? "—"}</dd>
                </div>
                <div class="ops-kv-row">
                    <span class="dot-placeholder" aria-hidden="true" />
                    <dt class="ops-kv-k">Services scanned</dt>
                    <dd class="ops-kv-v">{String(pi.servicesScanned)}</dd>
                </div>
                <div class="ops-kv-row">
                    <span class="dot-placeholder" aria-hidden="true" />
                    <dt class="ops-kv-k">Observations</dt>
                    <dd class="ops-kv-v">
                        {String(pi.observationsGenerated)}
                        <span class="dim">
                            {" "}
                            ({String(pi.observationsFiltered)} filtered)
                        </span>
                    </dd>
                </div>
                <div class="ops-kv-row">
                    <span class="dot-placeholder" aria-hidden="true" />
                    <dt class="ops-kv-k">Triage processed</dt>
                    <dd class="ops-kv-v">{String(pi.triageProcessed)}</dd>
                </div>
                <div class="ops-kv-row">
                    <span class="dot-placeholder" aria-hidden="true" />
                    <dt class="ops-kv-k">Errors</dt>
                    <dd class={`ops-kv-v${pi.errorCount > 0 ? "" : " dim"}`}>
                        {String(pi.errorCount)}
                    </dd>
                </div>
            </dl>
        </div>
    );
};
