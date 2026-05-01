// SPEC-015-3-02 — Compact inline sparkline.
//
// No axes, no labels, no gridlines. Designed for SSE-streamed cost-cap
// status cards: renders in <5ms and is byte-stable for snapshot tests.

import { colorFor } from "./palette";
import { escapeXml } from "./accessibility";
import { type SparklineOptions, SPARKLINE_DIMENSIONS } from "./types";

export function renderSparkline(
    values: ReadonlyArray<number>,
    opts: SparklineOptions = {},
): string {
    const width = opts.width ?? SPARKLINE_DIMENSIONS.width;
    const height = opts.height ?? SPARKLINE_DIMENSIONS.height;
    const color = opts.color ?? colorFor(0);
    const label = opts.a11yLabel ?? "sparkline";

    if (values.length === 0) {
        return (
            `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${escapeXml(label)}">` +
            `<text x="${String(width / 2)}" y="${String(height / 2)}" text-anchor="middle" dominant-baseline="middle" class="empty-state">no data</text>` +
            `</svg>`
        );
    }

    const minV = Math.min(...values);
    const maxV = Math.max(...values);
    const ySpan = maxV - minV;
    const yToPx = (v: number): number => {
        if (ySpan === 0) return height / 2;
        return height - 2 - ((v - minV) / ySpan) * (height - 4);
    };
    const xToPx = (i: number): number => {
        if (values.length === 1) return width / 2;
        return 2 + (i / (values.length - 1)) * (width - 4);
    };

    const points = values
        .map((v, i) => `${String(round1(xToPx(i)))},${String(round1(yToPx(v)))}`)
        .join(" ");
    const lastIdx = values.length - 1;
    const lastV = values[lastIdx] as number;
    const lastX = round1(xToPx(lastIdx));
    const lastY = round1(yToPx(lastV));

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${escapeXml(label)}">` +
        `<polyline fill="none" stroke="${color}" stroke-width="1.5" points="${points}"/>` +
        `<circle cx="${String(lastX)}" cy="${String(lastY)}" r="2" fill="${color}"/>` +
        `</svg>`
    );
}

function round1(n: number): number {
    return Math.round(n * 10) / 10;
}
