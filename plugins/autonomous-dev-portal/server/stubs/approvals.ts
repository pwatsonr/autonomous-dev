// SPEC-013-3-01 §Stub Data Modules — approval queue items.

import type { ApprovalItem } from "../types/render";

const STUB: ApprovalItem[] = [
    {
        id: "APP-001",
        summary: "Deploy v1.4 to production",
        riskLevel: "high",
        repo: "acme",
        costImpactUsd: 0,
        actions: [
            { id: "approve", label: "Approve", confirm: "Confirm production deploy?" },
            { id: "reject", label: "Reject", confirm: null },
        ],
    },
    {
        id: "APP-002",
        summary: "Run cost-optimization migration",
        riskLevel: "med",
        repo: "beta",
        costImpactUsd: 1.25,
        actions: [
            { id: "approve", label: "Approve", confirm: null },
            { id: "reject", label: "Reject", confirm: null },
        ],
    },
];

export async function loadApprovalsStub(): Promise<ApprovalItem[]> {
    return STUB;
}
