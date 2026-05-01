// SPEC-015-3-02 — Pure scale + format helpers.
//
// All functions are pure, side-effect-free, and deterministic — no
// Date.now, no Math.random. Snapshot-test stability depends on this.

const MONTHS_SHORT: ReadonlyArray<string> = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
];

export function linearScaleY(
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
    return (v: number): number => {
        // Clamp to domain bounds before scaling.
        const clamped = v < Math.min(d0, d1)
            ? Math.min(d0, d1)
            : v > Math.max(d0, d1)
                ? Math.max(d0, d1)
                : v;
        return r0 + (clamped - d0) * slope;
    };
}

export function bandScaleX(
    domain: ReadonlyArray<string>,
    range: readonly [number, number],
    padding = 0.1,
): { scale: (key: string) => number; bandWidth: number } {
    const [r0, r1] = range;
    const totalSpan = r1 - r0;
    const n = domain.length;
    if (n === 0 || totalSpan <= 0) {
        return { scale: () => r0, bandWidth: 0 };
    }
    // Reserve `padding` on each end and between bands.
    const step = totalSpan / (n + padding * 2);
    const bandWidth = step * (1 - padding);
    const offsets = new Map<string, number>();
    for (let i = 0; i < n; i += 1) {
        const key = domain[i] as string;
        offsets.set(key, r0 + step * (padding + i) + (step - bandWidth) / 2);
    }
    return {
        scale: (key: string): number => offsets.get(key) ?? r0,
        bandWidth,
    };
}

export function dateScaleX(
    dates: ReadonlyArray<string>,
    range: readonly [number, number],
): (date: string) => number {
    const [r0, r1] = range;
    const n = dates.length;
    if (n === 0) return () => r0;
    if (n === 1) return () => (r0 + r1) / 2;
    const span = r1 - r0;
    const step = span / (n - 1);
    const indexBy = new Map<string, number>();
    for (let i = 0; i < n; i += 1) {
        indexBy.set(dates[i] as string, i);
    }
    return (date: string): number => {
        const idx = indexBy.get(date);
        if (idx === undefined) return r0;
        return r0 + idx * step;
    };
}

export function formatCurrency(usd: number): string {
    if (!Number.isFinite(usd)) return "$0.00";
    const sign = usd < 0 ? "-" : "";
    const abs = Math.abs(usd);
    // Round to 2 decimals before splitting.
    const rounded = Math.round(abs * 100) / 100;
    const fixed = rounded.toFixed(2);
    const [intPart, fracPart] = fixed.split(".");
    const withCommas = (intPart as string).replace(
        /\B(?=(\d{3})+(?!\d))/g,
        ",",
    );
    return `${sign}$${withCommas}.${fracPart as string}`;
}

export function formatDate(
    iso: string,
    style: "short" | "long" | "monthYear",
): string {
    // iso is YYYY-MM-DD or YYYY-MM-DDT...; first 10 chars are sufficient.
    const yStr = iso.slice(0, 4);
    const mStr = iso.slice(5, 7);
    const dStr = iso.slice(8, 10);
    const monthIdx = Number(mStr) - 1;
    const monthName = MONTHS_SHORT[monthIdx] ?? "";
    if (style === "monthYear") return `${monthName} ${yStr}`;
    if (style === "long") return `${monthName} ${String(Number(dStr))}, ${yStr}`;
    return `${monthName} ${String(Number(dStr))}`;
}

/**
 * Pick approximately `count` "round" tick values covering [min, max].
 * Uses a 1/2/5 step ladder. Returned ticks include both endpoints when
 * they happen to be round.
 */
export function niceTicks(
    min: number,
    max: number,
    count: number,
): number[] {
    if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
    if (max <= min) return [min];
    if (count <= 0) return [];
    const range = max - min;
    const rough = range / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    let step: number;
    if (norm < 1.5) step = 1;
    else if (norm < 3.5) step = 2;
    else if (norm < 7.5) step = 5;
    else step = 10;
    step *= mag;
    const start = Math.floor(min / step) * step;
    const end = Math.ceil(max / step) * step;
    const ticks: number[] = [];
    // Avoid floating-point creep: round to step's decimal places.
    const decimals = step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0;
    for (let v = start; v <= end + step * 1e-9; v += step) {
        const rounded = decimals > 0 ? Number(v.toFixed(decimals)) : v;
        ticks.push(rounded);
    }
    return ticks;
}
