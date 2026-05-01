// SPEC-015-3-02 — Accessibility helpers for SVG charts.
//
// Every chart MUST surface a screen-reader-friendly title/desc plus a
// tabular fallback that lists each datum. Sighted users never see the
// table (sr-only), but assistive tech reads it as the canonical data.

import type { AccessibilityMeta } from "./types";

export function escapeXml(s: string): string {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

export function renderA11yMeta(meta: AccessibilityMeta): {
    title: string;
    desc: string;
} {
    return {
        title: `<title id="chart-title">${escapeXml(meta.title)}</title>`,
        desc: `<desc id="chart-desc">${escapeXml(meta.description)}</desc>`,
    };
}

/**
 * Visually-hidden tabular fallback. Uses <foreignObject> wrapping a
 * standard HTML table marked with `sr-only` so it never paints but is
 * read by screen readers.
 */
export function renderTabularFallback(
    rows: ReadonlyArray<{ label: string; value: string }>,
): string {
    const trs = rows
        .map(
            (r) =>
                `<tr><th scope="row">${escapeXml(r.label)}</th><td>${escapeXml(r.value)}</td></tr>`,
        )
        .join("");
    const table = `<table class="sr-only"><thead><tr><th scope="col">Label</th><th scope="col">Value</th></tr></thead><tbody>${trs}</tbody></table>`;
    return `<g><foreignObject x="0" y="0" width="1" height="1"><div xmlns="http://www.w3.org/1999/xhtml" class="sr-only">${table}</div></foreignObject></g>`;
}
