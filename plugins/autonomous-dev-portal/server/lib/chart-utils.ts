// SPEC-013-3-03 §`chart-utils.ts` — pure numeric helpers for the SVG
// CostChart fragment. No DOM, no React, no globals — easy to unit-test.

/**
 * Compute a "nice" tick step that divides [min, max] into roughly `n`
 * intervals using a 1/2/5 sequence × 10^k. Useful for SVG axis labels.
 *
 * Returns 1 when the input range is zero so consumers can avoid
 * division-by-zero without special-casing.
 */
export function niceTickStep(min: number, max: number, n: number): number {
    const range = max - min;
    if (!Number.isFinite(range) || range <= 0 || n <= 0) return 1;
    const rough = range / n;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step: number;
    if (norm < 1.5) step = 1;
    else if (norm < 3.5) step = 2;
    else if (norm < 7.5) step = 5;
    else step = 10;
    return step * mag;
}

/**
 * Returns a function mapping a value in `domain` linearly into `range`.
 * Behaviour at zero-width domain mirrors d3-scale: every value maps to
 * the midpoint of the range, avoiding NaN.
 */
export function scaleLinear(
    domain: readonly [number, number],
    range: readonly [number, number],
): (v: number) => number {
    const [d0, d1] = domain;
    const [r0, r1] = range;
    const dRange = d1 - d0;
    if (dRange === 0) {
        const mid = (r0 + r1) / 2;
        return () => mid;
    }
    const slope = (r1 - r0) / dRange;
    return (v: number) => r0 + (v - d0) * slope;
}

/**
 * Format a USD value with two fraction digits and a `$` prefix.
 * Negatives are wrapped in parens (`($1.23)`) per accounting convention.
 */
export function formatUsd(value: number): string {
    if (!Number.isFinite(value)) return "$0.00";
    if (value < 0) return `($${(-value).toFixed(2)})`;
    return `$${value.toFixed(2)}`;
}
