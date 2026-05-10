// SPEC-036-3-03 §Gate detail card / SPEC-036-3-06 §Gate actions.
//
// Renders only when `request.status === "gate"`. Warning-tinted card with:
//   - section head: `Gate · ${gateTypeLabel}` + `waited ${n}m` in meta-mono
//   - body: free-form gate detail prose
//   - action row: Approve (primary) / Request Changes (secondary) / Reject
//     (destructive). Each button is HTMX-driven (`hx-post`) and carries
//     `data-gate-action` so static/js/gate-actions.js can intercept the
//     click, open the shared ConfirmModal, and only fire the HTMX request
//     after the operator confirms.
//
// The HTMX target is `#request-${id}-meta` so the meta region OOB-swaps
// after the gate is resolved. CSRF token is read from the page meta tag
// at submit time (gate-actions.js attaches it via `htmx:configRequest`).

import type { FC } from "hono/jsx";

import { Btn } from "../../components/primitives";

interface Props {
    requestId: string;
    repo: string;
    gateType: string;
    gateDetail: string;
    waitedMin: number;
    /** CSRF token; embedded inline so HTMX requests carry it without JS. */
    csrfToken?: string;
}

const GATE_LABELS: Record<string, string> = {
    "reviewer-chain": "Reviewer chain",
    "standards-violation": "Standards",
    "cost-cap": "Cost cap",
};

function gateTypeLabel(t: string): string {
    return GATE_LABELS[t] ?? t;
}

const GateActionButton: FC<{
    requestId: string;
    repo: string;
    action: "approve" | "request-changes" | "reject";
    label: string;
    kind: "primary" | "secondary" | "destructive";
    csrfToken: string;
}> = ({ requestId, repo, action, label, kind, csrfToken }) => {
    const headers = JSON.stringify({ "X-CSRF-Token": csrfToken });
    return (
        <Btn
            kind={kind}
            size="sm"
            type="button"
            data-gate-action={action}
            data-request-id={requestId}
            data-repo={repo}
            hx-post={`/repo/${repo}/request/${requestId}/gate/${action}`}
            hx-target={`#request-${requestId}-meta`}
            hx-swap="outerHTML"
            hx-trigger="confirmed"
            hx-headers={headers}
        >
            {label}
        </Btn>
    );
};

export const GateDetail: FC<Props> = ({
    requestId,
    repo,
    gateType,
    gateDetail,
    waitedMin,
    csrfToken,
}) => {
    const csrf = csrfToken ?? "";
    return (
        <section class="sec gate-block">
            <div class="sec-head">
                <h2>Gate · {gateTypeLabel(gateType)}</h2>
                <span class="meta-mono dim">waited {waitedMin}m</span>
            </div>
            <div class="gate-detail-card">
                <div class="gate-detail">{gateDetail}</div>
                <div class="gate-actions" role="group" aria-label="Gate actions">
                    <GateActionButton
                        requestId={requestId}
                        repo={repo}
                        action="approve"
                        label="Approve"
                        kind="primary"
                        csrfToken={csrf}
                    />
                    <GateActionButton
                        requestId={requestId}
                        repo={repo}
                        action="request-changes"
                        label="Request changes"
                        kind="secondary"
                        csrfToken={csrf}
                    />
                    <GateActionButton
                        requestId={requestId}
                        repo={repo}
                        action="reject"
                        label="Reject"
                        kind="destructive"
                        csrfToken={csrf}
                    />
                </div>
            </div>
        </section>
    );
};
