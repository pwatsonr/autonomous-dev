// SPEC-036-1-03 §RepoCard — kit-faithful 6-region repo card.
//
// Rewritten from the v1.0 `<dl>`-based card to the TDD-036 §6.1
// 6-region layout consuming the `Card` primitive (with `leftBar` set
// to the active phase, or warn-line treatment when `attn === true`)
// and `Chip` primitives for phase / variant / backend / stack tags.
//
// 6 regions in DOM order (SPEC-036-1-03 AC #1):
//   1. Top row    : repo name + trust-level badge
//   2. Path row   : ~/projects/{repo} in mono dim
//   3. Meta row 1 : phase chip (uppercase) + variant chip (label, sentence case)
//   4. Meta row 2 : backend chip (info tint) + stack chip (muted)
//   5. Footer     : N active + $X.XX MTD + (need-approval chip OR last-activity)
//   6. Left bar   : 4px solid var(--phase-{phase}) (Card primitive responsibility)
//
// The grid container `<div id="repo-grid" class="repo-grid">` is
// rendered by `RepoCardGrid` so the parent view can substitute
// `<EmptyState noun="repositories allowlisted" />` when `repos` is
// empty (SPEC-036-1-06 AC #3a).

import type { FC } from "hono/jsx";

import { Card, Chip } from "../../components/primitives";
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
    // SPEC-036-1-03 AC #1.6 + #2: phase-tokened left bar is replaced by
    // warn-line treatment when `attn === true`. We do NOT pass leftBar
    // in the warn case; the `.attn` class supplies the warn border via
    // tokenized CSS.
    const phaseForBar = r.attn ? undefined : (r.phase as PhaseName | undefined);
    return (
        <Card leftBar={phaseForBar} padding="md">
            <div class={`repo-card${r.attn ? " attn" : ""}`}>
                {/* 1. Top row */}
                <div class="rc-top">
                    <span class="rc-name">{r.repo}</span>
                    {r.trust && (
                        <span class="rc-trust meta-mono">{r.trust}</span>
                    )}
                </div>
                {/* 2. Path row */}
                <div class="rc-path meta-mono dim">~/projects/{r.repo}</div>
                {/* 3. Meta row 1 — phase + variant label */}
                <div class="rc-meta">
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
                <div class="rc-meta">
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
                {/* 5. Footer */}
                <div class="rc-footer">
                    <span>{r.activeRequests} active</span>
                    <span class="meta-mono">
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
            </div>
        </Card>
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
