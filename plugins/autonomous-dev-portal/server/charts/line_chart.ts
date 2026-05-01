// SPEC-015-3-02 — SVG line chart renderer.
//
// Pure function: identical inputs → byte-identical SVG output. No
// timestamps, UUIDs, or random IDs. Browser-native <title> tooltips on
// each data point provide hover information without any JavaScript.

import { colorFor } from "./palette";
import {
    dateScaleX,
    formatCurrency,
    formatDate,
    linearScaleY,
    niceTicks,
} from "./scales";
import { escapeXml, renderA11yMeta, renderTabularFallback } from "./accessibility";
import {
    type ChartDataPoint,
    type ChartOptions,
    DEFAULT_DIMENSIONS,
    mergeDimensions,
} from "./types";

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

export function renderLineChart(
    data: ReadonlyArray<ChartDataPoint>,
    opts: ChartOptions,
): string {
    if (data.length === 0) return renderEmpty(opts);

    const dim = mergeDimensions(opts.dimensions, DEFAULT_DIMENSIONS);
    const { width, height, margins } = dim;
    const innerLeft = margins.left;
    const innerRight = width - margins.right;
    const innerTop = margins.top;
    const innerBottom = height - margins.bottom;

    const showGrid = opts.showGridlines !== false;
    const showLabels = opts.showDataLabels === true;

    const sortedDates = data.map((d) => d.date);
    const maxValue = Math.max(...data.map((d) => d.value), 0);
    const yMax = maxValue > 0 ? maxValue * 1.1 : 1;
    const ticks = niceTicks(0, yMax, 6);
    const yTop = ticks.length > 0 ? Math.max(yMax, ticks[ticks.length - 1] as number) : yMax;
    const yScale = linearScaleY([0, yTop], [innerBottom, innerTop]);
    const xScale = dateScaleX(sortedDates, [innerLeft, innerRight]);

    const meta = renderA11yMeta(opts.a11y);
    const fallbackRows = data.map((d) => ({
        label: formatDate(d.date, "long"),
        value: formatCurrency(d.value),
    }));

    const parts: string[] = [];
    parts.push(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-labelledby="chart-title chart-desc">`,
    );
    parts.push(meta.title);
    parts.push(meta.desc);
    parts.push(renderTabularFallback(fallbackRows));

    if (showGrid) {
        const gridParts: string[] = [];
        for (const t of ticks) {
            const y = yScale(t);
            gridParts.push(
                `<line x1="${String(innerLeft)}" x2="${String(innerRight)}" y1="${String(round1(y))}" y2="${String(round1(y))}" stroke="#e5e7eb" stroke-width="1"/>`,
            );
        }
        parts.push(`<g class="gridlines">${gridParts.join("")}</g>`);
    }

    // Y axis
    const yAxisParts: string[] = [];
    yAxisParts.push(
        `<line x1="${String(innerLeft)}" x2="${String(innerLeft)}" y1="${String(innerTop)}" y2="${String(innerBottom)}" stroke="#374151" stroke-width="1"/>`,
    );
    for (const t of ticks) {
        const y = yScale(t);
        yAxisParts.push(
            `<g class="tick"><line x1="${String(innerLeft - 4)}" x2="${String(innerLeft)}" y1="${String(round1(y))}" y2="${String(round1(y))}" stroke="#374151"/><text x="${String(innerLeft - 8)}" y="${String(round1(y))}" text-anchor="end" dominant-baseline="middle" class="tick-label">${escapeXml(formatCurrency(t))}</text></g>`,
        );
    }
    if (opts.yAxisLabel !== undefined) {
        yAxisParts.push(
            `<text class="axis-label" x="${String(innerLeft - 48)}" y="${String((innerTop + innerBottom) / 2)}" text-anchor="middle" transform="rotate(-90 ${String(innerLeft - 48)} ${String((innerTop + innerBottom) / 2)})">${escapeXml(opts.yAxisLabel)}</text>`,
        );
    }
    parts.push(`<g class="y-axis">${yAxisParts.join("")}</g>`);

    // X axis
    const xAxisParts: string[] = [];
    xAxisParts.push(
        `<line x1="${String(innerLeft)}" x2="${String(innerRight)}" y1="${String(innerBottom)}" y2="${String(innerBottom)}" stroke="#374151" stroke-width="1"/>`,
    );
    const tickEvery = Math.max(1, Math.ceil(data.length / 8));
    const rotate = data.length > 14;
    for (let i = 0; i < data.length; i += tickEvery) {
        const d = data[i] as ChartDataPoint;
        const x = xScale(d.date);
        const labelText = formatDate(d.date, "short");
        const y = innerBottom + 16;
        const transform = rotate
            ? ` transform="rotate(-45 ${String(round1(x))} ${String(y)})"`
            : "";
        xAxisParts.push(
            `<g class="tick"><line x1="${String(round1(x))}" x2="${String(round1(x))}" y1="${String(innerBottom)}" y2="${String(innerBottom + 4)}" stroke="#374151"/><text x="${String(round1(x))}" y="${String(y)}" text-anchor="${rotate ? "end" : "middle"}" class="tick-label"${transform}>${escapeXml(labelText)}</text></g>`,
        );
    }
    parts.push(`<g class="x-axis">${xAxisParts.join("")}</g>`);

    // Data line
    const lineColor = colorFor(0);
    const points = data
        .map((d) => `${String(round1(xScale(d.date)))},${String(round1(yScale(d.value)))}`)
        .join(" ");
    parts.push(
        `<polyline class="series" fill="none" stroke="${lineColor}" stroke-width="2" points="${points}"/>`,
    );

    // Data points
    const circleParts: string[] = [];
    for (const d of data) {
        const cx = round1(xScale(d.date));
        const cy = round1(yScale(d.value));
        const titleText = `${formatDate(d.date, "long")}: ${formatCurrency(d.value)}`;
        const labelText = showLabels
            ? `<text x="${String(cx)}" y="${String(cy - 8)}" text-anchor="middle" class="data-label">${escapeXml(formatCurrency(d.value))}</text>`
            : "";
        circleParts.push(
            `<g class="datum"><title>${escapeXml(titleText)}</title><circle cx="${String(cx)}" cy="${String(cy)}" r="3" fill="${lineColor}"/>${labelText}</g>`,
        );
    }
    parts.push(`<g class="data-points">${circleParts.join("")}</g>`);

    parts.push(`</svg>`);
    return parts.join("");
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}
