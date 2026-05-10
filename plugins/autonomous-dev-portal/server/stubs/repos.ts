// SPEC-013-3-01 §Stub Data Modules — dashboard repo summaries.
// SPEC-036-1-06 §stub population — extends existing repos with the new
// optional `RepoSummary` fields (trust, phase, variant, variantLabel,
// backend, stack, gateCount, attn) and pre-fills the dashboard's
// `requests`, `standards`, and `variants` so the SPEC-036-1-01 route
// handler can compute aggregates without reaching for additional
// loaders. Existing tests using only the v1.0 fields continue to pass.
//
// Async signature is intentional: PLAN-015 will swap this for a SQLite
// query without changing the call sites.

import type {
    DashboardData,
    DashboardRequest,
    PipelineVariant,
} from "../types/render";
import { loadStandardsStub } from "./standards";

const VARIANTS: PipelineVariant[] = [
    {
        id: "fast-track",
        label: "Fast track",
        desc: "Lightweight 4-phase variant for low-risk patches.",
        phases: ["intake", "plan", "code", "review"],
    },
    {
        id: "full",
        label: "Full pipeline",
        desc: "Eight-phase variant with reviewers + standards gates.",
        phases: [
            "prd",
            "tdd",
            "plan",
            "spec",
            "code",
            "review",
            "deploy",
            "observe",
        ],
    },
];

function variantLabelFor(id: string): string {
    return VARIANTS.find((v) => v.id === id)?.label ?? id;
}

const REPOS_BASE = [
    {
        repo: "acme",
        activeRequests: 2,
        lastActivity: "2025-04-30T11:45:00Z",
        monthlyCostUsd: 12.34,
        attentionCount: 1,
        trust: "L1",
        phase: "code",
        variant: "fast-track",
        backend: "node",
        stack: "hono",
        gateCount: 1,
        attn: false,
    },
    {
        repo: "beta",
        activeRequests: 0,
        lastActivity: "2025-04-29T22:10:00Z",
        monthlyCostUsd: 4.5,
        attentionCount: 0,
        trust: "L2",
        phase: "review",
        variant: "full",
        backend: "python",
        stack: "fastapi",
        gateCount: 0,
        attn: false,
    },
] as const;

const REQUESTS_BASE: Omit<DashboardRequest, "variantLabel">[] = [
    {
        id: "REQ-000001",
        repo: "acme",
        title: "Add login retry policy",
        phase: "code",
        status: "gate",
        cost: 0.42,
        turns: 3,
        score: 88,
        variant: "fast-track",
        gateType: "reviewer-chain",
        stack: "hono",
        waitedMin: 14,
    },
    {
        id: "REQ-000002",
        repo: "acme",
        title: "Patch flaky token refresh",
        phase: "code",
        status: "running",
        cost: 0.21,
        turns: 2,
        score: 92,
        variant: "fast-track",
        stack: "hono",
    },
];

const STUB: DashboardData = {
    repos: REPOS_BASE.map((r) => ({
        ...r,
        variantLabel: variantLabelFor(r.variant),
    })),
    requests: REQUESTS_BASE.map((r) => ({
        ...r,
        // SPEC-036-1-06 AC #8: variantLabel is server-resolved.
        variantLabel: variantLabelFor(r.variant),
    })),
    variants: VARIANTS,
};

/**
 * Loads the dashboard stub. Resolves `standards` lazily so consumers
 * that only care about `repos` don't pay the cost (and so the
 * function remains async-friendly when SQLite replaces the stub).
 */
export async function loadDashboardStub(): Promise<DashboardData> {
    const standards = await loadStandardsStub();
    return { ...STUB, standards };
}
