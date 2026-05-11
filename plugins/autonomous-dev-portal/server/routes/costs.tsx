// SPEC-036-2-01..03 §Route — Costs (`GET /costs`).
// PLAN-038 TASK-016 — swapped from loadCostsStub() to the real
// readCostsData() composition reader. Per O.Q. #6, the reviewer / phase
// / deploy breakdown tables are empty by default on a real install
// (cost-ledger only tracks daily totals); kit-parity fixtures populate
// the daily chart for screenshot regression.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { projectMonthEnd } from "../lib/costs-projection";
import { readCostsData } from "../wiring/costs-readers";
import type { CostSeries } from "../types/render";

export const costsHandler = async (c: Context): Promise<Response> => {
    const series: CostSeries = await readCostsData();
    const projection = projectMonthEnd({
        series: series.points,
        mtd: series.totalMtd ?? 0,
        cap: series.costCap ?? 0,
        today: new Date(),
    });
    return renderPage(c, "costs", { series, projection });
};
