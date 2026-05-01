// SPEC-013-3-03 §Fragment Components — ApprovalItem.
//
// Single row in the approval queue. Risk level drives a CSS class
// (`risk-low|risk-med|risk-high`); cost impact is shown explicitly
// when the request is high-risk so reviewers see the blast radius.

import type { FC } from "hono/jsx";

import type { ApprovalItem as Item } from "../../types/render";
import { formatUsd } from "../../lib/chart-utils";

export const ApprovalItemRow: FC<Item> = ({
    id,
    summary,
    riskLevel,
    repo,
    costImpactUsd,
    actions,
}) => (
    <article class={`approval-item risk-${riskLevel}`} data-approval-id={id}>
        <header>
            <span class="repo">{repo}</span>
            <span class={`risk-badge risk-${riskLevel}`}>{riskLevel}</span>
        </header>
        <p class="summary">{summary}</p>
        {riskLevel === "high" ? (
            <p class="cost-impact">
                Cost impact: {formatUsd(costImpactUsd)}
            </p>
        ) : null}
        <div class="actions">
            {actions.map((action) => {
                const confirm =
                    action.confirm !== null ? action.confirm : undefined;
                return (
                    <button
                        type="button"
                        class={`action action-${action.id}`}
                        hx-post={`/api/approvals/${id}/${action.id}`}
                        hx-confirm={confirm}
                    >
                        {action.label}
                    </button>
                );
            })}
        </div>
    </article>
);
