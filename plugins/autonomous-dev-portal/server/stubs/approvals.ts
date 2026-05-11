// SPEC-013-3-01 §Stub Data Modules — approval queue items.
// SPEC-037-4-04 §Stub data — rebuilt for the kit's gate-row data shape.
//
// The stub array covers all three gate types (reviewer-chain,
// standards-violation, cost-cap) so the KPI strip, segmented filter, and
// row rendering all have non-zero data to exercise without a live daemon.
// The default `costCapDailyUsd` is sourced here so SPEC-037-4-01's KPI
// sub-line always has a real value; route handlers wired to live config
// may override.

import type { ApprovalItem } from "../types/render";

const DEFAULT_COST_CAP_DAILY_USD = 25;

const STUB: ApprovalItem[] = [
    {
        id: "REQ-2041",
        summary: "Migrate auth module to OIDC",
        repo: "acme-api",
        gateType: "reviewer-chain",
        phase: "review",
        variant: "deep-research",
        waitedMin: 42,
        cost: 3.14,
        detail: "security-reviewer raised 2 blocking findings",
        actions: [
            { id: "approve", label: "Approve", confirm: null },
            { id: "reject", label: "Reject", confirm: null },
        ],
    },
    {
        id: "REQ-2042",
        summary: "Refactor billing exporter to streaming writes",
        repo: "beta-svc",
        gateType: "standards-violation",
        phase: "build",
        variant: "vanilla",
        waitedMin: 18,
        cost: 1.02,
        detail: "lint-no-emoji + secret-scan: 3 blocking hits",
        blocking: true,
        actions: [
            { id: "approve", label: "Approve", confirm: null },
            { id: "reject", label: "Reject", confirm: null },
        ],
    },
    {
        id: "REQ-2043",
        summary: "Backfill cost-attribution for Q1 deploys",
        repo: "ops-tools",
        gateType: "cost-cap",
        phase: "deploy",
        variant: "fast-iter",
        waitedMin: 7,
        cost: 19.5,
        detail: "projected spend exceeds daily cap by $4.50",
        actions: [
            { id: "approve", label: "Approve", confirm: null },
            { id: "reject", label: "Reject", confirm: null },
        ],
    },
    {
        id: "REQ-2044",
        summary: "Upgrade portal HTMX to 1.9.10",
        repo: "autonomous-dev",
        gateType: "reviewer-chain",
        phase: "review",
        variant: "vanilla",
        waitedMin: 95,
        cost: 0.42,
        detail: "qa-reviewer requested a follow-up smoke pass",
        actions: [
            { id: "approve", label: "Approve", confirm: null },
            { id: "reject", label: "Reject", confirm: null },
        ],
    },
];

export interface ApprovalsStubResult {
    items: ApprovalItem[];
    costCapDailyUsd: number;
}

export async function loadApprovalsStub(): Promise<ApprovalsStubResult> {
    return { items: STUB, costCapDailyUsd: DEFAULT_COST_CAP_DAILY_USD };
}
