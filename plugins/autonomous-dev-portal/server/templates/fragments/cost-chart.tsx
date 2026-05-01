// SPEC-013-3-03 §Fragment Components — CostChart.
//
// Server-rendered SVG bar chart. No JS chart library: width is
// controlled via viewBox so the chart scales with its container.
// Includes an accessible <title>, axis labels, and a horizontal
// budget threshold line when budgetUsd > 0.

import type { FC } from "hono/jsx";

import type { CostSeries } from "../../types/render";
import {
    formatUsd,
    niceTickStep,
    scaleLinear,
} from "../../lib/chart-utils";

const VB_W = 480;
const VB_H = 200;
const PAD_L = 48;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 32;

export const CostChart: FC<CostSeries> = ({ points, budgetUsd }) => {
    const max = Math.max(
        budgetUsd > 0 ? budgetUsd : 0,
        ...points.map((p) => p.value),
        1, // floor so an all-zero series still has a sensible scale
    );
    const yMax = Math.ceil(max);
    const tick = niceTickStep(0, yMax, 4);
    const ticks: number[] = [];
    for (let v = 0; v <= yMax; v += tick) ticks.push(v);

    const yScale = scaleLinear([0, yMax], [VB_H - PAD_B, PAD_T]);
    const innerWidth = VB_W - PAD_L - PAD_R;
    const barGap = 4;
    const barWidth =
        points.length > 0
            ? Math.max(2, innerWidth / points.length - barGap)
            : 0;

    return (
        <svg
            class="cost-chart"
            viewBox={`0 0 ${String(VB_W)} ${String(VB_H)}`}
            role="img"
            aria-labelledby="cost-chart-title"
        >
            <title id="cost-chart-title">Cost by period</title>
            {/* y-axis ticks */}
            <g class="y-axis">
                {ticks.map((t) => (
                    <g class="tick">
                        <line
                            x1={String(PAD_L)}
                            x2={String(VB_W - PAD_R)}
                            y1={String(yScale(t))}
                            y2={String(yScale(t))}
                            class="grid"
                        />
                        <text
                            x={String(PAD_L - 4)}
                            y={String(yScale(t))}
                            text-anchor="end"
                            dominant-baseline="middle"
                            class="tick-label"
                        >
                            {formatUsd(t)}
                        </text>
                    </g>
                ))}
            </g>
            {/* bars */}
            <g class="bars">
                {points.map((p, i) => {
                    const x = PAD_L + i * (barWidth + barGap);
                    const y = yScale(p.value);
                    const h = yScale(0) - y;
                    return (
                        <g class="bar">
                            <rect
                                x={String(x)}
                                y={String(y)}
                                width={String(barWidth)}
                                height={String(Math.max(0, h))}
                            />
                            <text
                                x={String(x + barWidth / 2)}
                                y={String(VB_H - PAD_B + 14)}
                                text-anchor="middle"
                                class="x-label"
                            >
                                {p.label}
                            </text>
                        </g>
                    );
                })}
            </g>
            {/* budget threshold */}
            {budgetUsd > 0 ? (
                <g class="budget">
                    <line
                        x1={String(PAD_L)}
                        x2={String(VB_W - PAD_R)}
                        y1={String(yScale(budgetUsd))}
                        y2={String(yScale(budgetUsd))}
                        class="budget-line"
                    />
                    <text
                        x={String(VB_W - PAD_R)}
                        y={String(yScale(budgetUsd) - 4)}
                        text-anchor="end"
                        class="budget-label"
                    >
                        Budget {formatUsd(budgetUsd)}
                    </text>
                </g>
            ) : null}
        </svg>
    );
};
