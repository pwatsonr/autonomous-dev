// FR-026-13 — 14-day stacked cost bars by phase.
//
// View-local fragment. Renders a simple CSS-only stacked bar chart:
//   .cost-bars — 14-column grid, align-items:end, height 110px
//   .cost-bar  — flex column-reverse (bottom-up stacking), height % of max
//   .seg       — one colored block per phase (class-driven color via CSS)
//   .cost-axis — label row: "14d" / "7d" / "now"
//   Phase legend — inline-flex swatches
//
// Does NOT use the SVG renderStackedBarChart (that renderer adds full axes
// and is used on the /costs surface). This view-local version matches the
// design's CSS-only approach exactly.
//
// ARIA notes (WCAG 1.1.1 Non-text Content):
//   - Wrapped in <figure><figcaption> to provide a visible+accessible title.
//   - A visually-hidden <table class="sr-only"> provides keyboard-accessible
//     per-day per-phase data. role=img was dropped (it hides descendants).
//   - Per-segment title attributes kept for hover tooltips but are
//     supplemented by the accessible table.
//
// Phase colors: applied via class .seg-{pk} (not inline style=).
// Bar heights: applied via CSS custom properties --bar-h and --seg-h (the
//   only remaining style= usage sets only a CSS variable, not a style
//   property directly — the accepted CSP-safe pattern for dynamic values).

import type { FC } from "hono/jsx";
import type { DayCostBar, PhaseKey } from "../../wiring/dashboard-readers";
import { PHASE_KEYS, PHASE_LABELS } from "../../wiring/dashboard-readers";

export interface DashboardCostBarsProps {
    days: DayCostBar[];
}

/** Axis label for day index (0 = oldest, 13 = today). */
function axisLabel(i: number): string {
    if (i === 0) return "14d";
    if (i === 6) return "7d";
    if (i === 13) return "now";
    return "";
}

/**
 * Compute total cost per phase across all 14 days — used for the figure
 * summary aria-label so the most meaningful number is immediately available
 * to screen readers.
 */
function buildSummary(days: DayCostBar[]): { grandTotal: number; topPhase: PhaseKey; topTotal: number } {
    let grandTotal = 0;
    const phaseTotals: Record<string, number> = {};
    for (const d of days) {
        grandTotal += d.total;
        if (d.segs === null) continue; // #389: no per-phase attribution
        for (const pk of PHASE_KEYS) {
            phaseTotals[pk] = (phaseTotals[pk] ?? 0) + (d.segs[pk] ?? 0);
        }
    }
    let topPhase: PhaseKey = PHASE_KEYS[0] as PhaseKey;
    let topTotal = 0;
    for (const pk of PHASE_KEYS) {
        if ((phaseTotals[pk] ?? 0) > topTotal) {
            topTotal = phaseTotals[pk] ?? 0;
            topPhase = pk;
        }
    }
    return { grandTotal, topPhase, topTotal };
}

/**
 * FR-026-13 — 14-day stacked cost bars.
 *
 * Renders `.cost-bars` / `.cost-bar` / `.seg` as defined in app.css.
 * Each bar's height is a percentage of the maximum daily total so the
 * tallest bar always fills the container. Segments are stacked
 * bottom-up (flex column-reverse) in phase order.
 */
export const DashboardCostBars: FC<DashboardCostBarsProps> = ({ days }) => {
    const maxTotal = Math.max(...days.map((d) => d.total), 1);
    const { grandTotal, topPhase, topTotal } = buildSummary(days);
    // #389: the ledger records per-request sessions, not phases — only
    // claim a phase split when the data actually carries one.
    const hasPhaseData = days.some((d) => d.segs !== null);

    const figureLabel = hasPhaseData
        ? `Cost by phase over 14 days: total $${grandTotal.toFixed(2)}, ` +
          `top phase ${PHASE_LABELS[topPhase].toLowerCase()} at $${topTotal.toFixed(2)}`
        : `Daily cost over 14 days from the cost ledger: total $${grandTotal.toFixed(2)} ` +
          `(per-phase attribution not recorded)`;

    return (
        <div class="card">
            <div class="card-b">
                {/*
                  * <figure> + <figcaption> is the ARIA-correct pattern for a
                  * chart. It does NOT suppress descendants (unlike role=img),
                  * so the sr-only <table> inside is keyboard-reachable.
                  */}
                <figure aria-label={figureLabel}>
                    <figcaption class="sr-only">{figureLabel}</figcaption>

                    {/* Visual stacked bar chart */}
                    <div class="cost-bars" aria-hidden="true">
                        {days.map((d, i) => {
                            const barHeightPct = Math.round((d.total / maxTotal) * 100);
                            return (
                                <div
                                    class="cost-bar"
                                    key={String(i)}
                                    style={`--bar-h:${barHeightPct}%`}
                                    title={`Day ${i + 1}: $${d.total.toFixed(2)}`}
                                >
                                    {d.segs !== null ? (
                                        PHASE_KEYS.map((pk: PhaseKey) => {
                                            const segVal = d.segs![pk];
                                            const segHeightPct = Math.round(
                                                (segVal / Math.max(d.total, 0.01)) * 100,
                                            );
                                            return (
                                                <span
                                                    key={pk}
                                                    class={`seg seg-${pk}`}
                                                    style={`--seg-h:${segHeightPct}%`}
                                                    title={`${PHASE_LABELS[pk]}: $${segVal.toFixed(2)}`}
                                                ></span>
                                            );
                                        })
                                    ) : (
                                        <span
                                            class="seg seg-unattributed"
                                            style="--seg-h:100%"
                                            title={`Total: $${d.total.toFixed(2)}`}
                                        ></span>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                    <div class="cost-axis" aria-hidden="true">
                        {days.map((_, i) => (
                            <span key={String(i)}>{axisLabel(i)}</span>
                        ))}
                    </div>

                    {/*
                      * Accessible data table: keyboard-reachable, screen-reader
                      * friendly. Visually hidden (sr-only) so it doesn't duplicate
                      * the chart visually. Satisfies WCAG 1.1.1 + 2.1.
                      */}
                    <table class="sr-only">
                        <caption>
                            {hasPhaseData
                                ? "14-day cost by phase (most recent day last)"
                                : "14-day daily cost totals (most recent day last)"}
                        </caption>
                        <thead>
                            <tr>
                                <th scope="col">Day</th>
                                {hasPhaseData &&
                                    PHASE_KEYS.map((pk) => (
                                        <th key={pk} scope="col">{PHASE_LABELS[pk]}</th>
                                    ))}
                                <th scope="col">Total</th>
                            </tr>
                        </thead>
                        <tbody>
                            {days.map((d, i) => (
                                <tr key={String(i)}>
                                    <td>{axisLabel(i) !== "" ? axisLabel(i) : `Day ${i + 1}`}</td>
                                    {hasPhaseData &&
                                        PHASE_KEYS.map((pk) => (
                                            <td key={pk}>${(d.segs?.[pk] ?? 0).toFixed(2)}</td>
                                        ))}
                                    <td>${d.total.toFixed(2)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </figure>

                {/* Legend: phases when attributed, single honest entry otherwise */}
                {hasPhaseData ? (
                    <div class="cost-legend" role="list" aria-label="Phase legend">
                        {PHASE_KEYS.map((pk: PhaseKey) => (
                            <span key={pk} class="cost-legend-item" role="listitem">
                                <span
                                    class={`cost-legend-swatch swatch-${pk}`}
                                    aria-hidden="true"
                                ></span>
                                {PHASE_LABELS[pk].toLowerCase()}
                            </span>
                        ))}
                    </div>
                ) : (
                    <div class="cost-legend" role="list" aria-label="Legend">
                        <span class="cost-legend-item" role="listitem">
                            <span
                                class="cost-legend-swatch swatch-unattributed"
                                aria-hidden="true"
                            ></span>
                            daily total (per-phase attribution not recorded)
                        </span>
                    </div>
                )}
            </div>
        </div>
    );
};
