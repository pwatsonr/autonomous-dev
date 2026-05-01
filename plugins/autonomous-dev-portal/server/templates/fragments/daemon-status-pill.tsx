// SPEC-013-3-03 §Navigation Component / DaemonStatusPill.
//
// Compact pill indicating daemon freshness. Polls /api/daemon-status
// every 30s via HTMX, swapping its own outerHTML so a stale->fresh
// transition does not require a full page reload. The polling endpoint
// is owned by PLAN-015; this fragment only declares the hx-* contract.

import type { FC } from "hono/jsx";

import type { DaemonStatus } from "../../lib/daemon-status";

interface Props {
    // The full status struct when known; "unknown" is used when the
    // pill is rendered before its first poll completes (e.g. from
    // Navigation in the initial page render).
    status: DaemonStatus | "unknown";
}

function classFor(status: string): string {
    return `daemon-status-pill status-${status}`;
}

export const DaemonStatusPill: FC<Props> = ({ status }) => {
    const label =
        status === "unknown" ? "checking…" : `daemon: ${status.status}`;
    const cssClass =
        status === "unknown" ? classFor("unknown") : classFor(status.status);
    return (
        <span
            class={cssClass}
            hx-get="/api/daemon-status"
            hx-trigger="every 30s"
            hx-swap="outerHTML"
        >
            {label}
        </span>
    );
};
