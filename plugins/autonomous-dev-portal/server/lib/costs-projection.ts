// SPEC-036-2-03 §projectMonthEnd — pure helper that forecasts month-end
// spend from MTD plus the trailing-7-day run rate.
//
// Algorithm (FR-2):
//   runRateDaily = sum(series last 7 days) / 7
//   daysRemaining = daysInMonth - dayOfMonth
//   projected = MTD + runRateDaily * daysRemaining
//   overage = max(0, projected - cap)
//
// Sparse-series fallback (FR-3): when fewer than 7 daily samples are
// available, run-rate falls back to MTD / dayOfMonth so we don't
// over-extrapolate from a single day.
//
// Defense (FR-8): negative or NaN inputs are clamped to 0 before the
// math runs; otherwise a bad stub could push the ring into "err" tone
// without a real spend signal.

import type { CostPoint } from "../types/render";

export interface ProjectionResult {
    /** Forecast month-end total in USD. */
    projected: number;
    /** Average daily spend used for the forecast. */
    runRateDaily: number;
    /** Calendar days remaining in the current month (excluding today). */
    daysRemaining: number;
    /** `max(0, projected - cap)` — never negative. */
    overage: number;
}

/** Clamp negative / NaN to 0. */
function clampNonNegative(v: number): number {
    if (!Number.isFinite(v)) return 0;
    if (v < 0) return 0;
    return v;
}

/** Number of days in the month containing `d`. */
function daysInMonth(d: Date): number {
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

export interface ProjectInputs {
    /** Daily cost series for the current month (most-recent last). */
    series: CostPoint[];
    /** Month-to-date spend in USD. */
    mtd: number;
    /** Configured monthly cost cap (USD). */
    cap: number;
    /** Reference date — used to compute dayOfMonth + daysRemaining. */
    today: Date;
}

/**
 * SPEC-036-2-03 §FR-1..FR-4, FR-8 — projectMonthEnd.
 *
 * Pure: no I/O, no side effects, table-test friendly.
 */
export function projectMonthEnd(input: ProjectInputs): ProjectionResult {
    const series = input.series ?? [];
    const mtd = clampNonNegative(input.mtd);
    const cap = clampNonNegative(input.cap);
    const today = input.today;

    const dom = daysInMonth(today);
    const dayOfMonth = today.getDate();
    const daysRemaining = Math.max(0, dom - dayOfMonth);

    // FR-4 — degenerate inputs.
    if (series.length === 0 || mtd === 0) {
        return {
            projected: 0,
            runRateDaily: 0,
            daysRemaining,
            overage: 0,
        };
    }

    // FR-2 / FR-3 — run-rate.
    let runRateDaily: number;
    if (series.length >= 7) {
        const last7 = series.slice(-7);
        const sum = last7.reduce(
            (s, p) => s + clampNonNegative(p.value),
            0,
        );
        runRateDaily = sum / 7;
    } else {
        runRateDaily = dayOfMonth > 0 ? mtd / dayOfMonth : 0;
    }
    runRateDaily = clampNonNegative(runRateDaily);

    const projected = clampNonNegative(mtd + runRateDaily * daysRemaining);
    const overage = cap > 0 ? Math.max(0, projected - cap) : 0;

    return { projected, runRateDaily, daysRemaining, overage };
}
