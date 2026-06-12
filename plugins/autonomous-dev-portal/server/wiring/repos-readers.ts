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
    const repos: RepoSummary[] = [];
    for (const id of allowlistRepos) {
        const summary = byRepo.get(id);
        if (summary === undefined) continue;
        const trust = settings.trustOverrides[id] ?? settings.globalTrust;
        const withTrust: RepoSummary = { ...summary, trust, inAllowlist: true };
        repos.push(withTrust);
    }

    // Append any repos with activity that aren't in the allowlist
    // (defensive — honesty contract). #395: flagged so the view can badge
    // them instead of rendering them indistinguishably from allowlisted.
    for (const [id, summary] of byRepo) {
        if (!allowlistRepos.includes(id)) {
            repos.push({ ...summary, trust: settings.globalTrust, inAllowlist: false });
        }
    }

    const activeRepos = repos.filter((r) => r.activeRequests > 0).length;
    // Crawl p7: the old `allowlistMisses` KPI was HARDCODED 0 (the
    // fs.access probe was never built) while the table visibly badged
    // rows NOT IN ALLOWLIST — a constant posing as a metric, directly
    // contradicting the UI below it. Count the real, derivable fact
    // instead: repos seen in request history that aren't allowlisted.
    const notInAllowlist = repos.filter((r) => r.inAllowlist !== true).length;

    return {
        kpis: {
            // #395: the KPI sub-label claims "in allowlist" — count the
            // allowlist, not the table rows (which may include appended
            // historical repos).
            totalRepos: settings.allowlist.length,
            activeRepos,
            notInAllowlist,
        },
        repos,
    };
}
