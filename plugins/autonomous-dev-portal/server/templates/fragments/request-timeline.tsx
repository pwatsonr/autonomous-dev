// SPEC-013-3-03 §Fragment Components — RequestTimeline.
// SPEC-034-2-05 §Voice/copy sweep — phase timestamps render compact ISO;
// agent identifiers render in mono.
// SPEC-037-7-04 — Adds retry / skip action buttons next to the existing
// Cancel button. All three POST `/api/requests/:id/action` (PLAN-037-2).
// Irreversible actions (skip, cancel) carry `hx-confirm`; reversible
// retries do not.
//
// Vertical phase timeline. Status icon is conveyed via CSS class only
// (no inline SVG/glyphs — CSS owns the visual). Each entry includes a
// relative <time> element, the assigned agent, and an expandable
// <details> block. Action buttons emit HTMX POSTs with `hx-confirm`
// for irreversible actions.
//
// Action visibility matrix (SPEC-037-7-04 AC-2):
//   in-progress  → Cancel
//   failed       → Retry, Skip
//   pending      → Skip
//   complete     → (no actions)

import type { FC } from "hono/jsx";

import type { Phase } from "../../types/render";

interface Props {
    requestId: string;
    phases: Phase[];
}

function formatTimestampCompact(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().replace("T", " ").slice(0, 19) + "Z";
}

const TimelineActions: FC<{ requestId: string; phase: Phase }> = ({
    requestId,
    phase,
}) => {
    const showCancel = phase.status === "in-progress";
    const showRetry = phase.status === "failed";
    // Skip applies whenever the phase isn't actively running and isn't
    // already complete (SPEC-037-7-04 AC-2). `failed` + `pending` qualify.
    const showSkip =
        phase.status !== "in-progress" && phase.status !== "complete";
    if (!showCancel && !showRetry && !showSkip) return <></>;
    const endpoint = `/api/requests/${requestId}/action`;
    return (
        <div class="actions">
            {showCancel ? (
                <button
                    type="button"
                    hx-post={endpoint}
                    hx-vals={`{"action":"cancel","phase":"${phase.name}"}`}
                    hx-confirm={`Cancel phase ${phase.name}?`}
                    data-timeline-action="cancel"
                    data-phase={phase.name}
                >
                    Cancel
                </button>
            ) : null}
            {showRetry ? (
                <button
                    type="button"
                    hx-post={endpoint}
                    hx-vals={`{"action":"retry","phase":"${phase.name}"}`}
                    data-timeline-action="retry"
                    data-phase={phase.name}
                >
                    Retry
                </button>
            ) : null}
            {showSkip ? (
                <button
                    type="button"
                    hx-post={endpoint}
                    hx-vals={`{"action":"skip","phase":"${phase.name}"}`}
                    hx-confirm={`Skip phase ${phase.name}?`}
                    data-timeline-action="skip"
                    data-phase={phase.name}
                >
                    Skip
                </button>
            ) : null}
        </div>
    );
};

export const RequestTimeline: FC<Props> = ({ requestId, phases }) => (
    <ol class="request-timeline">
        {phases.map((phase) => (
            <li class={`timeline-entry status-${phase.status}`}>
                <span class={`status-icon ${phase.status}`} aria-hidden="true">
                    {""}
                </span>
                <div class="entry-body">
                    <h3>{phase.name}</h3>
                    {phase.timestamp !== null ? (
                        <time datetime={phase.timestamp} class="mono">
                            {formatTimestampCompact(phase.timestamp)}
                        </time>
                    ) : null}
                    {phase.agent !== null ? (
                        <code class="agent">{phase.agent}</code>
                    ) : null}
                    {phase.detail !== null ? (
                        <details>
                            <summary>Detail</summary>
                            <pre>{phase.detail}</pre>
                        </details>
                    ) : null}
                    <TimelineActions requestId={requestId} phase={phase} />
                </div>
            </li>
        ))}
    </ol>
);
