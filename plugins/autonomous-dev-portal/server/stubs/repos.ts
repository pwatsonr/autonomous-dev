// SPEC-013-3-01 §Stub Data Modules — dashboard repo summaries.
//
// Async signature is intentional: PLAN-015 will swap this for a SQLite
// query without changing the call sites.

import type { DashboardData } from "../types/render";

const STUB: DashboardData = {
    repos: [
        {
            repo: "acme",
            activeRequests: 2,
            lastActivity: "2025-04-30T11:45:00Z",
            monthlyCostUsd: 12.34,
            attentionCount: 1,
        },
        {
            repo: "beta",
            activeRequests: 0,
            lastActivity: "2025-04-29T22:10:00Z",
            monthlyCostUsd: 4.5,
            attentionCount: 0,
        },
    ],
};

export async function loadDashboardStub(): Promise<DashboardData> {
    return STUB;
}
