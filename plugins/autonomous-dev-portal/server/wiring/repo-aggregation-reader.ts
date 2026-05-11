// PLAN-038 TASK-010 — repo-aggregation reader.
//
// Reduces the request ledger + cost ledger by repo. Returns a map keyed
// by repo id so composition modules (`dashboard-readers`, `repos-readers`)
// can pull a subset or full list as needed.
//
// Cost-per-repo is derived by summing the costs of requests in that repo.
// The cost-ledger.json today only tracks daily totals (no per-repo
// breakdown — PLAN-038 O.Q. #6); the request-action files carry
// per-request costs which we sum here for the per-repo MTD figure.

import type { DashboardRequest, RepoSummary } from "../types/render";

import {
    readRequestLedger,
    type RequestLedgerReaderOptions,
} from "./request-ledger-reader";

export interface RepoAggregationOptions extends RequestLedgerReaderOptions {
    /** Allowlist driving the canonical repo set. When empty, repos are
     *  inferred from the request ledger only. */
    allowlistRepos?: string[];
}

export interface RepoAggregationResult {
    /** Per-repo aggregate, keyed by repo id. */
    byRepo: Map<string, RepoSummary>;
    /** The request ledger that drove the aggregation (pass-through so
     *  composition modules don't re-read the same files). */
    requests: DashboardRequest[];
}

function newSummary(repo: string): RepoSummary {
    return {
        repo,
        activeRequests: 0,
        lastActivity: "",
        monthlyCostUsd: 0,
        attentionCount: 0,
    };
}

export async function readRepoAggregates(
    opts: RepoAggregationOptions = {},
): Promise<RepoAggregationResult> {
    const requests = await readRequestLedger(opts);
    const byRepo = new Map<string, RepoSummary>();

    // Seed with allowlist so repos with zero activity still appear.
    for (const repo of opts.allowlistRepos ?? []) {
        byRepo.set(repo, newSummary(repo));
    }

    for (const r of requests) {
        const existing = byRepo.get(r.repo) ?? newSummary(r.repo);
        if (r.status === "running" || r.status === "gate") {
            existing.activeRequests += 1;
        }
        existing.monthlyCostUsd += r.cost;
        // Use the request's createdAt as a proxy for "last activity";
        // refine with completedAt when present.
        const lastTs = r.completedAt ?? r.createdAt ?? "";
        if (lastTs > existing.lastActivity) {
            existing.lastActivity = lastTs;
        }
        if (r.status === "gate") {
            existing.attentionCount += 1;
        }
        byRepo.set(r.repo, existing);
    }

    // Round monthly cost to 2 decimals to avoid floating-point trailing
    // garbage in the view.
    for (const r of byRepo.values()) {
        r.monthlyCostUsd = Math.round(r.monthlyCostUsd * 100) / 100;
    }

    return { byRepo, requests };
}
