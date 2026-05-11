// SPEC-036-1-03 §RepoCard — kit-faithful 6-region repo card.
//
// Rewritten from the v1.0 `<dl>`-based card to the TDD-036 §6.1
// 6-region layout. Updated by SPEC-037-6-01 to:
//   - Emit kit-canonical class names (`.repo-top`, `.repo-id`,
//     `.repo-trust`, `.repo-path`, `.repo-meta-row`, `.repo-foot`)
//     so the kit's `app.css:370-386` rules actually hit.
//   - Collapse the `<Card><div class="repo-card">` double wrapper to
//     a single `<button class="repo-card">` element, matching the
//     kit's `Dashboard.jsx` shape and the hoverable interaction the
//     `.repo-card:hover` rule (`app.css:377`) expects.
//
// 6 regions in DOM order (SPEC-036-1-03 AC #1):
//   1. Top row    : repo name + trust-level badge   (.repo-top)
//   2. Path row   : ~/projects/{repo} in mono dim   (.repo-path)
//   3. Meta row 1 : phase chip + variant chip       (.repo-meta-row)
//   4. Meta row 2 : backend chip + stack chip       (.repo-meta-row)
//   5. Footer     : N active + $X.XX MTD + (need-approval chip OR
//                   last-activity)                   (.repo-foot)
//   6. Left bar   : 4px solid var(--phase-{phase}) emitted inline on
//                   the `<button class="repo-card">` element; suppressed
//                   when `attn===true` (`.attn` rule supplies the warn
//                   treatment via kit `app.css:378`).
//
// The grid container `<div id="repo-grid" class="repo-grid">` is
// rendered by `RepoCardGrid` so the parent view can substitute
// `<EmptyState noun="repositories allowlisted" />` when `repos` is
// empty (SPEC-036-1-06 AC #3a).

import type { FC } from "hono/jsx";

import { Chip } from "../../components/primitives";
import type { PhaseName } from "../../components/primitives";
import type { RepoSummary } from "../../types/render";

/**
 * Last-activity rendering. The legacy stub put an ISO8601 timestamp
 * here; the kit shows "last {N}m ago" relative time. Kit prevails for
 * v1.1 (TDD-036 §6.1). When the value cannot be parsed as a number of
 * minutes (e.g. it's an ISO timestamp from the legacy stub), we fall
 * back to rendering the raw string so the layout never collapses.
 */
function formatLastActivity(value: string): string {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0) return `last ${n}m ago`;
    return `last ${value}`;
}

export const RepoCard: FC<RepoSummary> = (r) => {
    // SPEC-036-1-03 AC #1.6 + #2 (per SPEC-037-6-01): phase-tokened left
    // bar is emitted inline on the single `<button class="repo-card">`
    // element. When `attn===true`, the inline `border-left` is suppressed
    // and the `.attn` class supplies the warn-line treatment via the kit
    // rule on `app.css:378`. The kit's static `.repo-card` rule provides
    // a default `var(--phase-code)` bar; the inline style overrides it
    // with the active phase token when present.
    const phase = r.phase as PhaseName | undefined;
    const className = `repo-card${r.attn ? " attn" : ""}`;
    const style =
        !r.attn && phase
            ? `border-left: 4px solid var(--phase-${phase})`
            : undefined;
    return (
        <button
            type="button"
            class={className}
            data-phase={r.phase ?? ""}
            style={style}
        >
            {/* 1. Top row */}
            <div class="repo-top">
                <span class="repo-id">{r.repo}</span>
                {r.trust && (
                    <span class="repo-trust meta-mono">{r.trust}</span>
                )}
            </div>
            {/* 2. Path row */}
            <div class="repo-path meta-mono dim">~/projects/{r.repo}</div>
            {/* 3. Meta row 1 — phase + variant label */}
            <div class="repo-meta-row">
                {r.phase && (
                    <Chip variant="phase" tone={r.phase as PhaseName} />
                )}
                {r.variantLabel && (
                    <Chip variant="status" tone="muted">
                        {r.variantLabel}
                    </Chip>
                )}
            </div>
            {/* 4. Meta row 2 — backend + stack */}
            <div class="repo-meta-row">
                {r.backend && (
                    <Chip variant="status" tone="info">
                        {r.backend}
                    </Chip>
                )}
                {r.stack && (
                    <Chip variant="status" tone="muted">
                        {r.stack}
                    </Chip>
                )}
            </div>
            {/* 5. Footer — active + MTD counts receive .num so the kit
                rule on `app.css:385` brightens them (color + weight). */}
            <div class="repo-foot">
                <span class="num">{r.activeRequests} active</span>
                <span class="meta-mono num">
                    ${r.monthlyCostUsd.toFixed(2)} MTD
                </span>
                {(r.gateCount ?? 0) > 0 ? (
                    <Chip variant="status" tone="warn">
                        {r.gateCount ?? 0} need approval
                    </Chip>
                ) : (
                    <span class="meta-mono dim">
                        {formatLastActivity(r.lastActivity)}
                    </span>
                )}
            </div>
        </button>
    );
};

export interface RepoCardGridProps {
    repos: RepoSummary[];
}

/**
 * Grid container for the repo cards. SPEC-036-1-03 AC #4 — the
 * `id="repo-grid"` is exposed for the `dashboard:repos` SSE OOB swap.
 * Empty `repos` yields no cards; the parent view is responsible for
 * substituting `<EmptyState noun="repositories allowlisted" />`
 * (SPEC-036-1-03 AC #5).
 */
export const RepoCardGrid: FC<RepoCardGridProps> = ({ repos }) => (
    <div id="repo-grid" class="repo-grid">
        {repos.map((r) => (
            <RepoCard {...r} />
        ))}
    </div>
);
