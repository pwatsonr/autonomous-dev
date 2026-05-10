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

/**
 * SPEC-034-2-05 §Voice/copy sweep — canonical daemon status copy.
 *
 * The "running" case uses the kit canonical "Daemon running" (not
 * "Daemon is running"). Other states render as "Daemon: <STATUS>" with
 * the status word UPPERCASE per the design system status-badge rule.
 */
function labelFor(state: string): string {
    if (state === "running") return "Daemon running";
    return `Daemon: ${state.toUpperCase()}`;
}

export const DaemonStatusPill: FC<Props> = ({ status }) => {
    if (status === "unknown") {
        return (
            <span
                class={classFor("unknown")}
                hx-get="/api/daemon-status"
                hx-trigger="every 30s"
                hx-swap="outerHTML"
            >
                <code class="mono">checking…</code>
            </span>
        );
    }
    const state = status.status;
    return (
        <span
            class={classFor(state)}
            hx-get="/api/daemon-status"
            hx-trigger="every 30s"
            hx-swap="outerHTML"
        >
            <code class="mono">{labelFor(state)}</code>
        </span>
    );
};
