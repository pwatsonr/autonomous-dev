// SPEC-013-3-03 §Fragment Components — RepoCard.
// SPEC-034-2-05 §Voice/copy sweep — repo slug rendered in mono;
// last-activity timestamp uses compact ISO form.
//
// Dashboard card showing per-repo activity. Click target is the repo
// detail link; HTMX self-refresh polls the per-card endpoint every
// 30s (PLAN-015 owns the endpoint).

import type { FC } from "hono/jsx";

import type { RepoSummary } from "../../types/render";
import { formatUsd } from "../../lib/chart-utils";

function formatTimestampCompact(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

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
            <a href={`/repo/${repo}`}><code>{repo}</code></a>
            {attentionCount > 0 ? (
                <span class="badge attention">
                    {String(attentionCount)} need attention
                </span>
            ) : null}
        </header>
        <dl>
            <dt>Active</dt>
            <dd><code>{String(activeRequests)}</code></dd>
            <dt>Last activity</dt>
            <dd>
                <time datetime={lastActivity} class="mono">
                    {formatTimestampCompact(lastActivity)}
                </time>
            </dd>
            <dt>Month-to-date</dt>
            <dd><code>{formatUsd(monthlyCostUsd)}</code></dd>
        </dl>
    </article>
);
