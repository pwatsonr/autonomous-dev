// SPEC-013-3-03 §Views — approvals queue view component.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { ApprovalItemRow } from "../fragments/approval-item";

export const ApprovalsView: FC<RenderProps["approvals"]> = ({ items }) => (
    <section class="approvals">
        <h1>Approval queue</h1>
        {items.length === 0 ? (
            <p class="empty">No active requests.</p>
        ) : (
            <div class="approval-list">
                {items.map((it) => (
                    <ApprovalItemRow
                        id={it.id}
                        summary={it.summary}
                        riskLevel={it.riskLevel}
                        repo={it.repo}
                        costImpactUsd={it.costImpactUsd}
                        actions={it.actions}
                    />
                ))}
            </div>
        )}
    </section>
);
