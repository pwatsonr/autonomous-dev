// PLAN-038 TASK-011 — repos composition reader.
//
// Composes the portal-settings allowlist + repo-aggregation reader into
// the `ReposPageData` view-input shape. The `/repos` surface consumes
// the full repo list (no truncation); the dashboard grid pulls a subset
// from `dashboard-readers`.

import type { RepoSummary, ReposPageData } from "../types/render";

import {
    readRepoAggregates,
    type RepoAggregationOptions,
} from "./repo-aggregation-reader";
import {
    readPortalSettings,
    type SettingsReaderOptions,
} from "./settings-reader";

export type ReposReaderOptions = RepoAggregationOptions & SettingsReaderOptions;

export async function readReposData(
    opts: ReposReaderOptions = {},
): Promise<ReposPageData> {
    const settings = await readPortalSettings(opts);
    const allowlistRepos = settings.allowlist.map((e) => e.id);

    const { byRepo } = await readRepoAggregates({
        ...opts,
        allowlistRepos,
    });

    // Project to the row shape, preserving allowlist order. Apply trust
    // override if present.
    const repos: RepoSummary[] = allowlistRepos
        .map((id) => {
            const summary = byRepo.get(id);
            if (summary === undefined) return undefined;
            const trust = settings.trustOverrides[id] ?? settings.globalTrust;
            return { ...summary, trust };
        })
        .filter((r): r is RepoSummary => r !== undefined);

    // Append any repos with activity that aren't in the allowlist
    // (defensive — honesty contract).
    for (const [id, summary] of byRepo) {
        if (!allowlistRepos.includes(id)) {
            repos.push({ ...summary, trust: settings.globalTrust });
        }
    }

    const activeRepos = repos.filter((r) => r.activeRequests > 0).length;
    // `allowlistMisses` would need fs.access() per path — out of scope for
    // this composition (would block on disk I/O). Defaulting to 0; future
    // work can add an optional probe.
    const allowlistMisses = 0;

    return {
        kpis: {
            totalRepos: repos.length,
            activeRepos,
            allowlistMisses,
        },
        repos,
    };
}
