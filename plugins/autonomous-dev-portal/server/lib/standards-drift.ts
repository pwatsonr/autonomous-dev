// SPEC-036-1-01 §standardsDrift aggregation — server-side only.
//
// Lives in lib/ (not in the route handler) so the route stays thin
// and the aggregator is independently unit-testable. Pure function:
// no I/O, no globals, no time/date dependencies.
//
// Algorithm (per TDD-036 §6.1 "Server-side population"):
//   1. Filter rules to those with `hits > 0` (zero-hit rules add no row).
//   2. For each rule, fan out to the repos it `applies` to.
//   3. Group resulting (repo, ruleId) pairs by repo, accumulating a
//      hits[] list and a running max severity.
//   4. Emit `StandardsDriftEntry[]` sorted by `hitCount` desc.
//
// `applies` predicate language is intentionally minimal in v1:
//   - `"*"`           matches every repo
//   - `"repoA,repoB"` matches the comma-separated repo names verbatim
//   - everything else is treated as a single repo name to match
// PLAN-040+ may swap this for a tag/glob predicate; the contract is
// "string -> (repo) -> bool", so callers continue to pass strings.

import type {
    RepoSummary,
    StandardRule,
    StandardsDriftEntry,
    StandardsHit,
} from "../types/render";

const SEVERITY_RANK: Record<StandardRule["severity"], number> = {
    advisory: 0,
    warn: 1,
    blocking: 2,
};

/**
 * Returns true when `rule.applies` matches `repo.repo`. See module
 * header for the v1 predicate grammar.
 */
function ruleAppliesToRepo(rule: StandardRule, repo: RepoSummary): boolean {
    const a = rule.applies.trim();
    if (a === "*") return true;
    if (a.includes(",")) {
        return a
            .split(",")
            .map((s) => s.trim())
            .includes(repo.repo);
    }
    return a === repo.repo;
}

/**
 * Pick the higher-ranked severity. Used to maintain `severityMax`
 * when accumulating multiple rule hits per repo.
 */
function maxSeverity(
    a: StandardRule["severity"],
    b: StandardRule["severity"],
): StandardRule["severity"] {
    return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Aggregate `standards` rules into per-repo drift entries.
 *
 * SPEC-036-1-01 AC #4:
 *   - Empty `standards` -> empty array (never `undefined`).
 *   - Single-repo case  -> one entry, hitCount = rule.hits.
 *   - Multi-repo case   -> sorted by hitCount desc.
 */
export function computeStandardsDrift(
    standards: StandardRule[],
    repos: RepoSummary[],
): StandardsDriftEntry[] {
    const byRepo = new Map<string, StandardsDriftEntry>();
    for (const rule of standards) {
        if (rule.hits <= 0) continue;
        for (const repo of repos) {
            if (!ruleAppliesToRepo(rule, repo)) continue;
            const hit: StandardsHit = {
                ruleId: rule.id,
                severity: rule.severity,
                hits: rule.hits,
            };
            const existing = byRepo.get(repo.repo);
            if (existing) {
                existing.hitCount += rule.hits;
                existing.severityMax = maxSeverity(
                    existing.severityMax,
                    rule.severity,
                );
                existing.hits.push(hit);
            } else {
                byRepo.set(repo.repo, {
                    repo: repo.repo,
                    hitCount: rule.hits,
                    severityMax: rule.severity,
                    hits: [hit],
                });
            }
        }
    }
    return [...byRepo.values()].sort((a, b) => b.hitCount - a.hitCount);
}

/**
 * Convenience helper for the route handler — sums the hits of
 * `severity === "blocking"` rules. Defined here so the route handler
 * does not have to repeat the filter+reduce pattern, and so the test
 * for empty input documents the contract once.
 */
export function totalBlockingHits(standards: StandardRule[]): number {
    let total = 0;
    for (const rule of standards) {
        if (rule.severity === "blocking") total += rule.hits;
    }
    return total;
}
