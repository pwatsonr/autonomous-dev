// SPEC-015-3-02 — Wong 8-color color-blind-safe palette + SVG patterns.
//
// Wong, B. (2011). Points of view: Color blindness. Nature Methods.
// Pattern overlays provide redundant differentiation for stacked-bar
// segments so users with achromatopsia can still distinguish series.

export const COLOR_PALETTE: readonly string[] = [
    "#000000",
    "#E69F00",
    "#56B4E9",
    "#009E73",
    "#F0E442",
    "#0072B2",
    "#D55E00",
    "#CC79A7",
];

/**
 * 8 SVG <pattern> definitions keyed by index. Each pattern is monochrome
 * black at low opacity so it overlays cleanly on the colored fill below.
 * Pattern IDs are stable: pat-0..pat-7. The block is emitted once per
 * SVG via PATTERN_DEFS.
 */
export const PATTERN_DEFS: string =
    `<defs>` +
    `<pattern id="pat-0" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M0,6 l6,-6" stroke="#000" stroke-width="1"/></pattern>` +
    `<pattern id="pat-1" patternUnits="userSpaceOnUse" width="6" height="6"><circle cx="3" cy="3" r="1" fill="#000"/></pattern>` +
    `<pattern id="pat-2" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M0,0 l6,6 M0,6 l6,-6" stroke="#000" stroke-width="1"/></pattern>` +
    `<pattern id="pat-3" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M3,0 l0,6" stroke="#000" stroke-width="1"/></pattern>` +
    `<pattern id="pat-4" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M0,3 l6,0" stroke="#000" stroke-width="1"/></pattern>` +
    `<pattern id="pat-5" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M0,0 l6,6" stroke="#000" stroke-width="1"/></pattern>` +
    `<pattern id="pat-6" patternUnits="userSpaceOnUse" width="8" height="8"><rect x="0" y="0" width="4" height="4" fill="#000"/></pattern>` +
    `<pattern id="pat-7" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M0,3 l6,0 M3,0 l0,6" stroke="#000" stroke-width="1"/></pattern>` +
    `</defs>`;

export function colorFor(index: number): string {
    const i = ((index % COLOR_PALETTE.length) + COLOR_PALETTE.length) %
        COLOR_PALETTE.length;
    // Safe: the modulo above guarantees a valid index.
    return COLOR_PALETTE[i] as string;
}

export function patternFor(index: number): string {
    const i = ((index % COLOR_PALETTE.length) + COLOR_PALETTE.length) %
        COLOR_PALETTE.length;
    return `url(#pat-${String(i)})`;
}

/**
 * WCAG 2.x relative luminance for a 6-digit hex color.
 * Returns a value in [0, 1].
 */
export function relativeLuminance(hex: string): number {
    const m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return 0;
    const num = parseInt(m[1] as string, 16);
    const r = ((num >> 16) & 0xff) / 255;
    const g = ((num >> 8) & 0xff) / 255;
    const b = (num & 0xff) / 255;
    const lin = (c: number): number =>
        c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2.x contrast ratio between two hex colors (>=1.0). */
export function contrastRatio(hexA: string, hexB: string): number {
    const la = relativeLuminance(hexA);
    const lb = relativeLuminance(hexB);
    const light = Math.max(la, lb);
    const dark = Math.min(la, lb);
    return (light + 0.05) / (dark + 0.05);
}
