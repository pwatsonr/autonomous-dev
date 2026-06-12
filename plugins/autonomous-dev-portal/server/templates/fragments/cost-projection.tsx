// SPEC-036-2-03 §CostProjection — month-end forecast region.
//
// Composes the `CostRing` primitive (PLAN-035-2) with a small detail
// block. The ring receives `spent={projected}` so its tone responds to
// the FORECAST relative to the cap (warn ≥ 80%, err ≥ 100%) — not the
// MTD figure (which the strip already shows). The detail block renders
// run-rate, days remaining, and (when > 0) forecast overage.
//
// FR-4 / empty state: when MTD is 0 or the series is empty, we render
// EmptyState directly and do NOT mount the CostRing — the surrounding
// section card supplies the elevation, so an absent ring is correct.

import type { FC } from "hono/jsx";

import { CostRing } from "../../components/primitives";
import type { ProjectionResult } from "../../lib/costs-projection";
import { EmptyState } from "./empty-state";

export interface CostProjectionProps {
    /** Output of `projectMonthEnd` — already-clamped numbers. */
    projection: ProjectionResult;
    /** Monthly cap in USD; null = no cap configured (#396). */
    cap: number | null;
    /** Month-to-date spend in USD; drives the empty-state branch. */
    mtd: number;
}

/** Render `$NN.NN` with always 2 decimals. PRD-018 R-22. */
function fmtUsd(v: number): string {
    return `$${v.toFixed(2)}`;
}

export const CostProjection: FC<CostProjectionProps> = ({
    projection,
    cap,
    mtd,
}) => {
    if (mtd <= 0 || projection.projected <= 0) {
        return (
            <EmptyState
                noun="spend"
                message="No spend yet this month"
            />
        );
    }
    return (
        <div class="cost-projection">
            {cap !== null ? (
                <CostRing
                    spent={projection.projected}
                    cap={cap}
                    label="Projected"
                />
            ) : (
                // #396: no cap configured — show the projection as a plain
                // stat instead of a ring against an invented denominator.
                <div class="cost-projection-nocap">
                    <div class="kpi-num">{fmtUsd(projection.projected)}</div>
                    <div class="dim">Projected · no cap configured</div>
                </div>
            )}
            <dl class="kv mono">
                <dt>Run rate / day</dt>
                <dd>{fmtUsd(projection.runRateDaily)}</dd>
                <dt>Days left</dt>
                <dd>{String(projection.daysRemaining)}</dd>
                {projection.overage > 0 && (
                    <>
                        <dt>Forecast overage</dt>
                        <dd class="warn">{fmtUsd(projection.overage)}</dd>
                    </>
                )}
            </dl>
        </div>
    );
};
