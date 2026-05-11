// SPEC-036-2-02 §CostChart — server-rendered SVG line chart for the
// 30-day cost time series.
// SPEC-034-2-05 §Voice/copy sweep — empty-state copy uses the kit
// canonical short form ("No cost data") rather than "No cost data yet".
//
// Server-authored SVG, no user data, no script content; XSS surface =
// empty per TDD-036 OI-002 resolution. The `d` attribute on every path
// is built from numeric coordinates only (`toFixed(2)` on every value)
// so there is no string concatenation that admits non-numeric input.
//
// The fragment renders one of three branches:
//   - 0 points  -> single empty-state <text>
//   - 1 point   -> single <circle> at the projected coordinate
//   - N points  -> 5 grid lines, area path (gradient fill), line path

import type { FC } from "hono/jsx";

import type { CostPoint, CostSeries } from "../../types/render";

const VB_W = 760;
const VB_H = 200;

/** Project the i-th point's x to chart space. */
function toX(i: number, n: number): number {
    if (n <= 1) return VB_W / 2;
    return (i / (n - 1)) * VB_W;
}

/** Project value v to chart space (inverted: 0 at bottom, max at top). */
function toY(v: number, max: number): number {
    if (max <= 0) return VB_H;
    return VB_H - (v / max) * VB_H;
}

/** Build the polyline `d` from an array of numeric coordinates. */
function buildLinePath(pts: ReadonlyArray<readonly [number, number]>): string {
    return pts
        .map(
            ([x, y], i) =>
                `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`,
        )
        .join(" ");
}

/** Close the line path into an area by dropping to baseline + back. */
function buildAreaPath(
    pts: ReadonlyArray<readonly [number, number]>,
): string {
    if (pts.length === 0) return "";
    const line = buildLinePath(pts);
    const last = pts[pts.length - 1];
    const first = pts[0];
    if (!last || !first) return "";
    return `${line} L${last[0].toFixed(2)},${VB_H.toFixed(2)} L${first[0].toFixed(2)},${VB_H.toFixed(2)} Z`;
}

export interface CostChartProps {
    points: CostPoint[];
    budgetUsd: number;
    /** When `true` (default), render axis labels every 5th point. */
    showLabels?: boolean;
}

/**
 * SPEC-036-2-02 — Costs daily-spend SVG line chart.
 *
 * `CostSeries` is also accepted as the props bag for backward
 * compatibility with callers that pass `{ points, budgetUsd }` from a
 * single object. Either prop signature is valid.
 */
export const CostChart: FC<CostChartProps | CostSeries> = (props) => {
    const points = props.points;
    const showLabels =
        "showLabels" in props && props.showLabels !== undefined
            ? props.showLabels
            : true;

    // FR-5 — empty state.
    if (points.length === 0) {
        return (
            <svg
                class="chart-svg"
                viewBox={`0 0 ${String(VB_W)} ${String(VB_H)}`}
                preserveAspectRatio="none"
            >
                <text
                    x="380"
                    y="100"
                    text-anchor="middle"
                    fill="var(--fg-2)"
                >
                    No cost data
                </text>
            </svg>
        );
    }

    const max = Math.max(...points.map((p) => p.value), 0.01);

    // FR-6 — single-point branch (no line, no area).
    if (points.length === 1) {
        const p0 = points[0];
        if (!p0) {
            return (
                <svg
                    class="chart-svg"
                    viewBox={`0 0 ${String(VB_W)} ${String(VB_H)}`}
                    preserveAspectRatio="none"
                />
            );
        }
        const x = toX(0, 1).toFixed(2);
        const y = toY(p0.value, max).toFixed(2);
        return (
            <svg
                class="chart-svg"
                viewBox={`0 0 ${String(VB_W)} ${String(VB_H)}`}
                preserveAspectRatio="none"
            >
                <circle cx={x} cy={y} r="3" fill="var(--brand)" />
            </svg>
        );
    }

    // N-point branch.
    const projected: Array<readonly [number, number]> = points.map(
        (p, i) => [toX(i, points.length), toY(p.value, max)] as const,
    );
    const linePath = buildLinePath(projected);
    const areaPath = buildAreaPath(projected);

    // FR-2 — 5 grid lines at 0%, 25%, 50%, 75%, 100% of max.
    const gridFractions = [0, 0.25, 0.5, 0.75, 1] as const;

    return (
        <svg
            class="chart-svg"
            viewBox={`0 0 ${String(VB_W)} ${String(VB_H)}`}
            preserveAspectRatio="none"
        >
            <defs>
                <linearGradient
                    id="cost-grad"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                >
                    <stop
                        offset="0%"
                        stop-color="var(--brand)"
                        stop-opacity="0.32"
                    />
                    <stop
                        offset="100%"
                        stop-color="var(--brand)"
                        stop-opacity="0"
                    />
                </linearGradient>
            </defs>
            {gridFractions.map((t) => {
                const y = (t * VB_H).toFixed(2);
                return (
                    <line
                        x1="0"
                        x2={String(VB_W)}
                        y1={y}
                        y2={y}
                        stroke="var(--line-1)"
                        stroke-width="1"
                    />
                );
            })}
            <path d={areaPath} fill="url(#cost-grad)" />
            <path
                d={linePath}
                stroke="var(--brand)"
                stroke-width="2"
                fill="none"
            />
            {showLabels && points.length > 5 && (
                <g class="x-labels">
                    {points.map((p, i) =>
                        i % 5 === 0 ? (
                            <text
                                x={toX(i, points.length).toFixed(2)}
                                y={String(VB_H - 4)}
                                text-anchor="middle"
                                fill="var(--fg-2)"
                                font-size="9"
                            >
                                {p.label}
                            </text>
                        ) : null,
                    )}
                </g>
            )}
        </svg>
    );
};
