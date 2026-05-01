// SPEC-013-3-03 §Fragment Components — RepoCard.
//
// Dashboard card showing per-repo activity. Click target is the repo
// detail link; HTMX self-refresh polls the per-card endpoint every
// 30s (PLAN-015 owns the endpoint).

import type { FC } from "hono/jsx";

import type { RepoSummary } from "../../types/render";
import { formatUsd } from "../../lib/chart-utils";

export const RepoCard: FC<RepoSummary> = ({
    repo,
    activeRequests,
    lastActivity,
    monthlyCostUsd,
    attentionCount,
}) => (
    <article
        class="repo-card"
        hx-get={`/repo/${repo}/card`}
        hx-trigger="every 30s"
        hx-swap="outerHTML"
    >
        <header>
            <a href={`/repo/${repo}`}>{repo}</a>
            {attentionCount > 0 ? (
                <span class="badge attention">
                    {String(attentionCount)} need attention
                </span>
            ) : null}
        </header>
        <dl>
            <dt>Active</dt>
            <dd>{String(activeRequests)}</dd>
            <dt>Last activity</dt>
            <dd>
                <time datetime={lastActivity}>{lastActivity}</time>
            </dd>
            <dt>Month-to-date</dt>
            <dd>{formatUsd(monthlyCostUsd)}</dd>
        </dl>
    </article>
);
