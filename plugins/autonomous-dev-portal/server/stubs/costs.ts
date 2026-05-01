// SPEC-013-3-01 §Stub Data Modules — cost time series.

import type { CostSeries } from "../types/render";

const STUB: CostSeries = {
    points: [
        { label: "Mon", value: 1.23 },
        { label: "Tue", value: 2.41 },
        { label: "Wed", value: 0.87 },
        { label: "Thu", value: 3.05 },
        { label: "Fri", value: 1.92 },
    ],
    budgetUsd: 10,
};

export async function loadCostsStub(): Promise<CostSeries> {
    return STUB;
}
