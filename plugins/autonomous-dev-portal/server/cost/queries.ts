// SPEC-015-3-01 — Pure aggregation queries.
//
// All helpers operate over an array of validated CostLedgerEntry. They
// never throw, never read the filesystem, never reference a clock other
// than the one passed in. Output percentages are pre-rounded so the
// template layer can render them verbatim.

import {
    CANONICAL_PHASES,
    type CostLedgerEntry,
    type CostPhase,
    type DailySummary,
    type MonthlySummary,
    type PhaseBreakdown,
    type Projection,
    type RepoBreakdown,
    type TopRequest,
} from "./types";

const MS_PER_DAY = 86_400_000;

function isoDate(ts: string): string {
    // Slice the YYYY-MM-DD off an ISO-8601 timestamp without parsing.
    return ts.slice(0, 10);
}

function isoMonth(ts: string): string {
    return ts.slice(0, 7);
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

function parseDateUtc(date: string): Date {
    // date is YYYY-MM-DD. Use Date.UTC so we never drift across TZ.
    const [yStr, mStr, dStr] = date.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    const d = Number(dStr);
    return new Date(Date.UTC(y, m - 1, d));
}

function parseMonthUtc(month: string): Date {
    const [yStr, mStr] = month.split("-");
    const y = Number(yStr);
    const m = Number(mStr);
    return new Date(Date.UTC(y, m - 1, 1));
}

function fmtDate(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function fmtMonth(d: Date): string {
    return d.toISOString().slice(0, 7);
}

export function aggregateByDay(
    entries: ReadonlyArray<CostLedgerEntry>,
    startDate: string,
    endDate: string,
): DailySummary[] {
    const byDay = new Map<
        string,
        { cost: number; tokens: number; reqs: Set<string> }
    >();
    for (const e of entries) {
        const d = isoDate(e.timestamp);
        if (d < startDate || d > endDate) continue;
        let bucket = byDay.get(d);
        if (!bucket) {
            bucket = { cost: 0, tokens: 0, reqs: new Set() };
            byDay.set(d, bucket);
        }
        bucket.cost += e.cost_usd;
        bucket.tokens += e.cost_tokens;
        bucket.reqs.add(e.request_id);
    }

    const out: DailySummary[] = [];
    const start = parseDateUtc(startDate);
    const end = parseDateUtc(endDate);
    for (let t = start.getTime(); t <= end.getTime(); t += MS_PER_DAY) {
        const key = fmtDate(new Date(t));
        const b = byDay.get(key);
        if (b) {
            out.push({
                date: key,
                total_cost_usd: round2(b.cost),
                total_tokens: b.tokens,
                request_count: b.reqs.size,
            });
        } else {
            out.push({
                date: key,
                total_cost_usd: 0,
                total_tokens: 0,
                request_count: 0,
            });
        }
    }
    return out;
}

export function aggregateByMonth(
    entries: ReadonlyArray<CostLedgerEntry>,
    startMonth: string,
    endMonth: string,
): MonthlySummary[] {
    const byMonth = new Map<
        string,
        { cost: number; tokens: number; reqs: Set<string> }
    >();
    for (const e of entries) {
        const m = isoMonth(e.timestamp);
        if (m < startMonth || m > endMonth) continue;
        let bucket = byMonth.get(m);
        if (!bucket) {
            bucket = { cost: 0, tokens: 0, reqs: new Set() };
            byMonth.set(m, bucket);
        }
        bucket.cost += e.cost_usd;
        bucket.tokens += e.cost_tokens;
        bucket.reqs.add(e.request_id);
    }

    const out: MonthlySummary[] = [];
    const start = parseMonthUtc(startMonth);
    const end = parseMonthUtc(endMonth);
    let cur = new Date(start.getTime());
    while (cur.getTime() <= end.getTime()) {
        const key = fmtMonth(cur);
        const b = byMonth.get(key);
        if (b) {
            out.push({
                month: key,
                total_cost_usd: round2(b.cost),
                total_tokens: b.tokens,
                request_count: b.reqs.size,
            });
        } else {
            out.push({
                month: key,
                total_cost_usd: 0,
                total_tokens: 0,
                request_count: 0,
            });
        }
        cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
    return out;
}

export function aggregateByRepo(
    entries: ReadonlyArray<CostLedgerEntry>,
): RepoBreakdown[] {
    const byRepo = new Map<string, { cost: number; reqs: Set<string> }>();
    let grand = 0;
    for (const e of entries) {
        let b = byRepo.get(e.repository);
        if (!b) {
            b = { cost: 0, reqs: new Set() };
            byRepo.set(e.repository, b);
        }
        b.cost += e.cost_usd;
        b.reqs.add(e.request_id);
        grand += e.cost_usd;
    }
    const out: RepoBreakdown[] = [];
    for (const [repo, b] of byRepo.entries()) {
        const pct = grand > 0 ? round2((b.cost / grand) * 100) : 0;
        out.push({
            repository: repo,
            total_cost_usd: round2(b.cost),
            request_count: b.reqs.size,
            pct_of_total: pct,
        });
    }
    out.sort((a, b) => b.total_cost_usd - a.total_cost_usd);
    return out;
}

export function aggregateByPhase(
    entries: ReadonlyArray<CostLedgerEntry>,
): PhaseBreakdown[] {
    const byPhase = new Map<CostPhase, number>();
    let grand = 0;
    for (const e of entries) {
        byPhase.set(e.phase, (byPhase.get(e.phase) ?? 0) + e.cost_usd);
        grand += e.cost_usd;
    }
    const out: PhaseBreakdown[] = [];
    for (const phase of CANONICAL_PHASES) {
        const cost = byPhase.get(phase) ?? 0;
        const pct = grand > 0 ? round2((cost / grand) * 100) : 0;
        out.push({
            phase,
            total_cost_usd: round2(cost),
            pct_of_total: pct,
        });
    }
    return out;
}

export function topNExpensive(
    entries: ReadonlyArray<CostLedgerEntry>,
    limit: number,
): TopRequest[] {
    if (limit <= 0) return [];
    const byReq = new Map<string, { cost: number; repo: string }>();
    for (const e of entries) {
        const b = byReq.get(e.request_id);
        if (b) {
            b.cost += e.cost_usd;
        } else {
            byReq.set(e.request_id, { cost: e.cost_usd, repo: e.repository });
        }
    }
    const all: TopRequest[] = [];
    for (const [request_id, b] of byReq.entries()) {
        all.push({
            request_id,
            repository: b.repo,
            total_cost_usd: round2(b.cost),
            drill_down_url: `/requests/${request_id}`,
        });
    }
    all.sort((a, b) => {
        if (b.total_cost_usd !== a.total_cost_usd) {
            return b.total_cost_usd - a.total_cost_usd;
        }
        return a.request_id < b.request_id ? -1 : a.request_id > b.request_id ? 1 : 0;
    });
    return all.slice(0, limit);
}

export function sevenDayProjection(
    entries: ReadonlyArray<CostLedgerEntry>,
    now: Date,
): Projection {
    // Window: 7 calendar days ending on `now` (inclusive of today partial).
    const today = fmtDate(now);
    const windowStart = fmtDate(new Date(now.getTime() - 6 * MS_PER_DAY));
    const datesWithData = new Set<string>();
    let sum = 0;
    for (const e of entries) {
        const d = isoDate(e.timestamp);
        if (d < windowStart || d > today) continue;
        datesWithData.add(d);
        sum += e.cost_usd;
    }
    const basis_days = Math.min(7, datesWithData.size);
    if (basis_days === 0) {
        return {
            trailing_avg_usd_per_day: 0,
            projected_seven_day_usd: 0,
            basis_days: 0,
        };
    }
    const avg = sum / basis_days;
    return {
        trailing_avg_usd_per_day: round2(avg),
        projected_seven_day_usd: round2(avg * 7),
        basis_days,
    };
}
