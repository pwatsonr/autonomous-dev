// PLAN-038 TASK-011 — dashboard composition reader.
//
// Composes the atomic readers (request-ledger + repo-aggregation + agent
// manifest) and the existing wiring (daemon-readers + settings-store)
// into the `DashboardData` shape the Dashboard view consumes.
//
// Honesty contract (TDD-037 §5.1.3): every reader defaults to safe zeros
// when its state file is absent. The Dashboard's KPI strip, the rail-ops
// bar, and `/api/daemon-status` all consume `mtdSpend` from the SAME
// `readMtdSpend()` call, so they cannot disagree.

import type { DashboardData, RepoSummary } from "../types/render";

import {
    readRepoAggregates,
    type RepoAggregationOptions,
} from "./repo-aggregation-reader";
import { readPortalSettings } from "./settings-reader";

export type DashboardReaderOptions = RepoAggregationOptions;

export async function readDashboardData(
    opts: DashboardReaderOptions = {},
): Promise<DashboardData> {
    // 1. Read the allowlist so repos with zero activity still appear in the
    //    grid (honesty contract — the operator's allowlist is not a lie).
    const settings = await readPortalSettings(opts);
    const allowlistRepos = settings.allowlist.map((e) => e.id);

    // 2. Aggregate per-repo and pull the request ledger in one pass.
    const { byRepo, requests } = await readRepoAggregates({
        ...opts,
        allowlistRepos,
    });

    // 3. Convert the map into a stable-ordered array (matching the
    //    allowlist order so the dashboard grid is deterministic).
    const repos: RepoSummary[] = allowlistRepos
        .map((id) => byRepo.get(id))
        .filter((r): r is RepoSummary => r !== undefined);

    // 4. Append any repos that have requests but are NOT in the allowlist
    //    (defensive — should be rare, but means the dashboard never hides
    //    activity).
    for (const [id, summary] of byRepo) {
        if (!allowlistRepos.includes(id)) repos.push(summary);
    }

    return {
        repos,
        requests,
        // Standards / variants / standardsDrift are out of TASK-011 scope —
        // wired by their own readers in later tasks. The view tolerates
        // undefined via `?? []` so the dashboard still renders.
    };
}
