// SPEC-013-3-03 §Views — dashboard view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { RepoCard } from "../fragments/repo-card";

export const DashboardView: FC<RenderProps["dashboard"]> = ({ data }) => (
    <section class="dashboard">
        <h1>Repositories</h1>
        <div class="repo-grid">
            {data.repos.map((r) => (
                <RepoCard
                    repo={r.repo}
                    activeRequests={r.activeRequests}
                    lastActivity={r.lastActivity}
                    monthlyCostUsd={r.monthlyCostUsd}
                    attentionCount={r.attentionCount}
                />
            ))}
        </div>
    </section>
);
