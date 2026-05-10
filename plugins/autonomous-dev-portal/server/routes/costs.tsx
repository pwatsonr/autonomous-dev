// SPEC-036-2-01..03 §Route — Costs (`GET /costs`).
//
// Loads the costs stub, computes the month-end projection server-side,
// and renders the v1.1 Costs surface via the template dispatcher. The
// view stays purely presentational; aggregates land in props.

import type { Context } from "hono";

import { renderPage } from "../lib/response-utils";
import { projectMonthEnd } from "../lib/costs-projection";
import { loadCostsStub } from "../stubs/costs";
import type { CostSeries } from "../types/render";

export const costsHandler = async (c: Context): Promise<Response> => {
    const series: CostSeries = await loadCostsStub();
    const projection = projectMonthEnd({
        series: series.points,
        mtd: series.totalMtd ?? 0,
        cap: series.costCap ?? 0,
        today: new Date(),
    });
    return renderPage(c, "costs", { series, projection });
};
