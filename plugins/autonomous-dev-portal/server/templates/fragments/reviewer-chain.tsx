// SPEC-036-3-04 §Reviewer chain — per-reviewer cards with rubric scores.
//
// Renders only when `request.currentPhase ∈ {review, code}`. The container
// is a CSS grid (`.rev-chain`) of reviewer cards. Each card composes:
//   - reviewer name + agent version (`meta-mono`)
//   - blocking/passing chip via `Chip variant="status"`
//   - rubric dimensions rendered as `Score` rows; each dimension links to
//     the agent run via `/agents/${reviewerName}/runs/${runId}`.
//
// Empty state: when `reviewers` is empty, render an inline `EmptyState`
// row inside the section card so the region remains visually anchored
// (per AC-5 — keeps the surface from collapsing on misconfigured phases).

import type { FC } from "hono/jsx";

import { Chip, Score } from "../../components/primitives";
import type { RequestReviewer } from "../../types/render";

interface Props {
    reviewers: RequestReviewer[];
}

const ReviewerCard: FC<{ reviewer: RequestReviewer }> = ({ reviewer }) => {
    const tone = reviewer.blocking ? "err" : "ok";
    const stateLabel = reviewer.blocking ? "BLOCKING" : "PASS";
    return (
        <div
            class={`rev-card ${reviewer.blocking ? "blocking" : ""}`.trimEnd()}
        >
            <div class="rev-head">
                <div class="rev-name">{reviewer.name}</div>
                <Chip variant="status" tone={tone}>
                    {stateLabel}
                </Chip>
            </div>
            <div class="rev-finding">{reviewer.finding}</div>
            <ul class="rev-dims">
                {reviewer.dimensions.map((d) => {
                    const value = d.den > 0
                        ? Math.round((d.num / d.den) * 100)
                        : 0;
                    return (
                        <li class="rev-dim">
                            <a
                                class="rev-dim-link"
                                href={`/agents/${reviewer.name}/runs/${reviewer.runId}`}
                            >
                                <span class="rev-dim-name">{d.name}</span>
                                <Score
                                    value={value}
                                    threshold={d.threshold ?? 85}
                                />
                            </a>
                        </li>
                    );
                })}
            </ul>
            <div class="rev-foot meta-mono dim">
                v{reviewer.version}
            </div>
        </div>
    );
};

const EmptyState: FC<{ noun: string }> = ({ noun }) => (
    <div class="empty-state">
        <p class="empty-state-msg">No {noun} configured for this phase.</p>
    </div>
);

export const ReviewerChain: FC<Props> = ({ reviewers }) => (
    <section class="sec reviewer-chain-section">
        <div class="sec-head">
            <h2>Reviewer chain</h2>
            <span class="meta-mono dim">
                parallel · gate blocks on any blocking finding
            </span>
        </div>
        {reviewers.length === 0 ? (
            <EmptyState noun="reviewers" />
        ) : (
            <div class="rev-chain">
                {reviewers.map((r) => (
                    <ReviewerCard reviewer={r} />
                ))}
            </div>
        )}
    </section>
);
