// SPEC-015-2-01 §Panel Structure
//
// The single source of truth for the approval gate UI. The panel renders one
// of two modes:
//   - "active"   : the request is `pending-approval`. Render three submit
//                  buttons (Approve / Request Changes / Reject), a comment
//                  textarea with a live char counter, the CSRF hidden input,
//                  and any clarifying-question / escalation slots.
//   - "resolved" : the request reached a terminal status. Render only a
//                  status line ("Approved by op1 at ...") and an optional
//                  blockquote for the resolution comment.
//
// The fragment's root element id is `gate-panel-{requestId}` and is the
// HTMX target for `outerHTML` swaps. Preserving that id on every re-render
// is load-bearing — any subsequent button click submits to the same target.
//
// The reject button carries `data-requires-confirm` based on
// `cost.total > 50`. The capture-phase listener in
// `static/js/gate-confirmation.js` (SPEC-015-2-04) runs first and dispatches
// `gate:requires-confirm` so the typed-CONFIRM modal can intercept the
// submission before HTMX fires its bubble-phase request.
//
// `data-requires-comment="true"` on the request-changes button is consumed
// by the same script to flip `textarea.required = true` so the native
// browser validation blocks an empty submission without a server roundtrip.

import type { FC } from "hono/jsx";

import {
    ClarifyingQuestions,
    type ClarifyingQuestion,
} from "./clarifying-questions";
import { EscalationBadge } from "./escalation-badge";

export type GateAction =
    | "approve"
    | "request-changes"
    | "reject";

export type ResolvedAction =
    | GateAction
    | "cancelled"
    | "completed";

export type PanelMode = "active" | "resolved";

export interface PanelCost {
    /** USD; the threshold for typed-CONFIRM is `> 50`. */
    total: number;
}

export interface GateActionPanelProps {
    requestId: string;
    /** Short request title shown for context (already truncated upstream). */
    title: string;
    repo: string;
    cost: PanelCost;
    /** Current persisted status from state.json. */
    status: string;
    /** Determines whether to render buttons or the resolved status line. */
    panelMode: PanelMode;
    /** ISO-8601 — when set, the EscalationBadge is rendered. */
    escalatedAt?: string;
    clarifyingQuestion?: ClarifyingQuestion;
    /** Resolved-mode fields (panelMode === "resolved"). */
    resolvedBy?: string;
    resolvedAt?: string;
    resolvedAction?: ResolvedAction;
    resolvedComment?: string;
    /** Inline 422 / 400 error message rendered above the form. */
    validationError?: string;
    /** Inline 503 message indicating intake-router unavailability. */
    serviceError?: string;
    /** When true, the panel was returned with HTTP 428 and the client must
     *  run the typed-CONFIRM flow before the next submission. The script in
     *  SPEC-015-2-04 reads this flag from a hidden input. */
    requiresConfirm?: boolean;
    /** CSRF token; injected by the route handler. Empty string = test render. */
    csrfToken?: string;
}

function statusLabel(action: ResolvedAction | undefined): string {
    switch (action) {
        case "approve":
            return "Approved";
        case "request-changes":
            return "Changes requested";
        case "reject":
            return "Rejected";
        case "cancelled":
            return "Cancelled";
        case "completed":
            return "Completed";
        default:
            return "Resolved";
    }
}

function formatTime(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

const GateButton: FC<{
    requestId: string;
    repo: string;
    action: GateAction;
    label: string;
    cssClass: string;
    requiresConfirm?: boolean;
    requiresComment?: boolean;
}> = ({
    requestId,
    repo,
    action,
    label,
    cssClass,
    requiresConfirm,
    requiresComment,
}) => (
    <button
        type="submit"
        name="action"
        value={action}
        class={`gate-button ${cssClass}`}
        aria-label={`${label} request ${requestId}`}
        hx-post={`/repo/${repo}/request/${requestId}/gate/${action}`}
        data-requires-confirm={requiresConfirm ? "true" : "false"}
        data-requires-comment={requiresComment ? "true" : undefined}
    >
        {label}
    </button>
);

const ResolvedPanel: FC<GateActionPanelProps> = ({
    requestId,
    resolvedAction,
    resolvedBy,
    resolvedAt,
    resolvedComment,
}) => (
    <div
        id={`gate-panel-${requestId}`}
        class="gate-action-panel resolved"
        data-request-id={requestId}
    >
        <p class="resolution-status">
            {statusLabel(resolvedAction)}
            {resolvedBy ? (
                <>
                    {" "}
                    by <strong>{resolvedBy}</strong>
                </>
            ) : null}
            {resolvedAt ? (
                <>
                    {" "}
                    at{" "}
                    <time datetime={resolvedAt}>{formatTime(resolvedAt)}</time>
                </>
            ) : null}
        </p>
        {resolvedComment ? (
            <blockquote class="resolution-comment">
                {resolvedComment}
            </blockquote>
        ) : null}
    </div>
);

const ActivePanel: FC<GateActionPanelProps> = (props) => {
    const {
        requestId,
        repo,
        cost,
        clarifyingQuestion,
        escalatedAt,
        validationError,
        serviceError,
        requiresConfirm,
        csrfToken,
    } = props;
    const highCost = cost.total > 50;
    const charCountId = `char-count-${requestId}`;
    return (
        <div
            id={`gate-panel-${requestId}`}
            class="gate-action-panel active"
            data-request-id={requestId}
            data-cost={String(cost.total)}
        >
            {clarifyingQuestion ? (
                <ClarifyingQuestions {...clarifyingQuestion} />
            ) : null}
            {escalatedAt ? (
                <EscalationBadge escalatedAt={escalatedAt} />
            ) : null}
            {validationError ? (
                <div
                    class="validation-error"
                    role="alert"
                    data-error-kind="validation"
                >
                    {validationError}
                </div>
            ) : null}
            {serviceError ? (
                <div
                    class="service-error"
                    role="alert"
                    data-error-kind="service"
                >
                    {serviceError} Please retry in 30s.
                </div>
            ) : null}
            <form
                class="gate-form"
                method="post"
                hx-target={`#gate-panel-${requestId}`}
                hx-swap="outerHTML"
                hx-include="this"
                data-repo={repo}
                data-request-id={requestId}
            >
                <input
                    type="hidden"
                    name="csrfToken"
                    value={csrfToken ?? ""}
                />
                {requiresConfirm ? (
                    <input
                        type="hidden"
                        name="_requiresConfirm"
                        value="true"
                    />
                ) : null}
                <label
                    class="comment-label"
                    for={`comment-${requestId}`}
                >
                    Comment
                </label>
                <textarea
                    id={`comment-${requestId}`}
                    name="comment"
                    class="comment-input"
                    maxlength={1000}
                    aria-describedby={charCountId}
                    rows={3}
                />
                <span id={charCountId} class="char-count">
                    0/1000
                </span>
                <div
                    class="gate-actions"
                    role="group"
                    aria-label="Approval actions"
                >
                    <GateButton
                        requestId={requestId}
                        repo={repo}
                        action="approve"
                        label="Approve"
                        cssClass="gate-approve"
                    />
                    <GateButton
                        requestId={requestId}
                        repo={repo}
                        action="request-changes"
                        label="Request Changes"
                        cssClass="gate-request-changes"
                        requiresComment
                    />
                    <GateButton
                        requestId={requestId}
                        repo={repo}
                        action="reject"
                        label="Reject"
                        cssClass="gate-reject"
                        requiresConfirm={highCost}
                    />
                </div>
            </form>
        </div>
    );
};

export const GateActionPanel: FC<GateActionPanelProps> = (props) => {
    if (props.panelMode === "resolved") {
        return <ResolvedPanel {...props} />;
    }
    return <ActivePanel {...props} />;
};
