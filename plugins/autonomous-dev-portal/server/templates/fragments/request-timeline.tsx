// SPEC-013-3-03 §Fragment Components — RequestTimeline.
//
// Vertical phase timeline. Status icon is conveyed via CSS class only
// (no inline SVG/glyphs — CSS owns the visual). Each entry includes a
// relative <time> element, the assigned agent, and an expandable
// <details> block. Action buttons emit HTMX POSTs with `hx-confirm`
// for irreversible actions.

import type { FC } from "hono/jsx";

import type { Phase } from "../../types/render";

interface Props {
    requestId: string;
    phases: Phase[];
}

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
                        <time datetime={phase.timestamp}>{phase.timestamp}</time>
                    ) : null}
                    {phase.agent !== null ? (
                        <span class="agent">{phase.agent}</span>
                    ) : null}
                    {phase.detail !== null ? (
                        <details>
                            <summary>Detail</summary>
                            <pre>{phase.detail}</pre>
                        </details>
                    ) : null}
                    {phase.status === "in-progress" ? (
                        <div class="actions">
                            <button
                                type="button"
                                hx-post={`/api/requests/${requestId}/action`}
                                hx-vals={`{"action":"cancel","phase":"${phase.name}"}`}
                                hx-confirm={`Cancel phase ${phase.name}?`}
                            >
                                Cancel
                            </button>
                        </div>
                    ) : null}
                </div>
            </li>
        ))}
    </ol>
);
