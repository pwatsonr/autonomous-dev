// SPEC-015-3-02 — SVG stacked bar chart renderer.
//
// Each segment is rendered as a colored <rect> overlaid by a pattern
// <rect> at fill-opacity 0.35 so color-blind users see distinct
// textures. Segment order is first-seen across the input series so
// snapshot tests stay stable across re-runs.

import { colorFor, PATTERN_DEFS, patternFor } from "./palette";
import {
    bandScaleX,
    formatCurrency,
    formatDate,
    linearScaleY,
    niceTicks,
} from "./scales";
import { escapeXml, renderA11yMeta, renderTabularFallback } from "./accessibility";
import {
    type ChartOptions,
    DEFAULT_DIMENSIONS,
    mergeDimensions,
    type StackedSeries,
} from "./types";

const MIN_LABEL_HEIGHT = 14;

function renderEmpty(opts: ChartOptions): string {
    const dim = mergeDimensions(opts.dimensions, DEFAULT_DIMENSIONS);
    const meta = renderA11yMeta(opts.a11y);
    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${String(dim.width)}" height="${String(dim.height)}" viewBox="0 0 ${String(dim.width)} ${String(dim.height)}" role="img" aria-labelledby="chart-title chart-desc">` +
        meta.title +
        meta.desc +
        renderTabularFallback([]) +
        `<text x="${String(dim.width / 2)}" y="${String(dim.height / 2)}" text-anchor="middle" dominant-baseline="middle" class="empty-state">No data</text>` +
        `</svg>`
    );
}

export function renderStackedBarChart(
    series: ReadonlyArray<StackedSeries>,
    opts: ChartOptions,
): string {
    if (series.length === 0) return renderEmpty(opts);

    const dim = mergeDimensions(opts.dimensions, DEFAULT_DIMENSIONS);
    const { width, height, margins } = dim;
    const innerLeft = margins.left;
    const innerRight = width - margins.right;
    const innerTop = margins.top;
    const innerBottom = height - margins.bottom;

    const showGrid = opts.showGridlines !== false;
    const showLabels = opts.showDataLabels !== false;

    // First-seen segment order across all series.
    const segmentOrder: string[] = [];
    const segmentIndex = new Map<string, number>();
    for (const s of series) {
        for (const seg of s.segments) {
            if (!segmentIndex.has(seg.name)) {
                segmentIndex.set(seg.name, segmentOrder.length);
                segmentOrder.push(seg.name);
            }
        }
    }

    const dates = series.map((s) => s.date);
    const totals = series.map((s) =>
        s.segments.reduce((acc, seg) => acc + seg.value, 0),
    );
    const maxTotal = Math.max(...totals, 0);
    const yMax = maxTotal > 0 ? maxTotal * 1.1 : 1;
    const ticks = niceTicks(0, yMax, 6);
    const yTop = ticks.length > 0 ? Math.max(yMax, ticks[ticks.length - 1] as number) : yMax;
    const yScale = linearScaleY([0, yTop], [innerBottom, innerTop]);
    const { scale: xScale, bandWidth } = bandScaleX(
        dates,
        [innerLeft, innerRight],
        0.2,
    );

    const meta = renderA11yMeta(opts.a11y);
    const fallbackRows: { label: string; value: string }[] = [];
    for (const s of series) {
        for (const seg of s.segments) {
            fallbackRows.push({
                label: `${formatDate(s.date, "short")} · ${seg.name}`,
                value: formatCurrency(seg.value),
            });
        }
    }

    const parts: string[] = [];
    parts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-labelledby="chart-title chart-desc">`,
    );
    parts.push(meta.title);
    parts.push(meta.desc);
    parts.push(PATTERN_DEFS);
    parts.push(renderTabularFallback(fallbackRows));

    if (showGrid) {
        const grid: string[] = [];
        for (const t of ticks) {
            const y = yScale(t);
            grid.push(
                `<line x1="${String(innerLeft)}" x2="${String(innerRight)}" y1="${String(round1(y))}" y2="${String(round1(y))}" stroke="#e5e7eb" stroke-width="1"/>`,
            );
        }
        parts.push(`<g class="gridlines">${grid.join("")}</g>`);
    }

    // Y axis
    const yParts: string[] = [];
    yParts.push(
        `<line x1="${String(innerLeft)}" x2="${String(innerLeft)}" y1="${String(innerTop)}" y2="${String(innerBottom)}" stroke="#374151"/>`,
    );
    for (const t of ticks) {
        const y = yScale(t);
        yParts.push(
            `<g class="tick"><line x1="${String(innerLeft - 4)}" x2="${String(innerLeft)}" y1="${String(round1(y))}" y2="${String(round1(y))}" stroke="#374151"/><text x="${String(innerLeft - 8)}" y="${String(round1(y))}" text-anchor="end" dominant-baseline="middle" class="tick-label">${escapeXml(formatCurrency(t))}</text></g>`,
        );
    }
    if (opts.yAxisLabel !== undefined) {
        yParts.push(
            `<text class="axis-label" x="${String(innerLeft - 48)}" y="${String((innerTop + innerBottom) / 2)}" text-anchor="middle" transform="rotate(-90 ${String(innerLeft - 48)} ${String((innerTop + innerBottom) / 2)})">${escapeXml(opts.yAxisLabel)}</text>`,
        );
    }
    parts.push(`<g class="y-axis">${yParts.join("")}</g>`);

    // X axis baseline + tick labels
    const xParts: string[] = [];
    xParts.push(
        `<line x1="${String(innerLeft)}" x2="${String(innerRight)}" y1="${String(innerBottom)}" y2="${String(innerBottom)}" stroke="#374151"/>`,
    );
    for (const date of dates) {
        const x = xScale(date) + bandWidth / 2;
        xParts.push(
            `<text x="${String(round1(x))}" y="${String(innerBottom + 16)}" text-anchor="middle" class="tick-label">${escapeXml(formatDate(date, "short"))}</text>`,
        );
    }
    parts.push(`<g class="x-axis">${xParts.join("")}</g>`);

    // Bars
    const barParts: string[] = [];
    for (const s of series) {
        const x0 = xScale(s.date);
        let cumulative = 0;
        for (const seg of s.segments) {
            const idx = segmentIndex.get(seg.name) ?? 0;
            const segTop = cumulative + seg.value;
            const yTopPx = yScale(segTop);
            const yBotPx = yScale(cumulative);
            const segHeight = Math.max(0, yBotPx - yTopPx);
            cumulative = segTop;
            const titleText = `${seg.name}: ${formatCurrency(seg.value)}`;
            const labelMaybe =
                showLabels && segHeight >= MIN_LABEL_HEIGHT
                    ? `<text x="${String(round1(x0 + bandWidth / 2))}" y="${String(round1(yTopPx + segHeight / 2))}" text-anchor="middle" dominant-baseline="middle" class="seg-label">${escapeXml(formatCurrency(seg.value))}</text>`
                    : "";
            barParts.push(
                `<g class="segment"><title>${escapeXml(titleText)}</title>` +
                    `<rect x="${String(round1(x0))}" y="${String(round1(yTopPx))}" width="${String(round1(bandWidth))}" height="${String(round1(segHeight))}" fill="${colorFor(idx)}"/>` +
                    `<rect x="${String(round1(x0))}" y="${String(round1(yTopPx))}" width="${String(round1(bandWidth))}" height="${String(round1(segHeight))}" fill="${patternFor(idx)}" fill-opacity="0.35"/>` +
                    labelMaybe +
                    `</g>`,
            );
        }
    }
    parts.push(`<g class="bars">${barParts.join("")}</g>`);

    // Legend
    const legendY = innerBottom + 32;
    const legendParts: string[] = [];
    let legendX = innerLeft;
    for (const name of segmentOrder) {
        const idx = segmentIndex.get(name) ?? 0;
        legendParts.push(
            `<g class="legend-item">` +
                `<rect x="${String(legendX)}" y="${String(legendY)}" width="12" height="12" fill="${colorFor(idx)}"/>` +
                `<rect x="${String(legendX)}" y="${String(legendY)}" width="12" height="12" fill="${patternFor(idx)}" fill-opacity="0.35"/>` +
                `<text x="${String(legendX + 18)}" y="${String(legendY + 10)}" class="legend-label">${escapeXml(name)}</text>` +
                `</g>`,
        );
        legendX += 18 + Math.max(40, name.length * 7);
    }
    parts.push(`<g class="legend">${legendParts.join("")}</g>`);

    parts.push(`</svg>`);
    return parts.join("");
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}
