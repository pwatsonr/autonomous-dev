// SPEC-015-2-01 §Escalation Badge
//
// Render a small status badge whenever a pending-approval request has been
// escalated. Two sources can set escalation:
//   1. The daemon writes `escalated_at` directly into state.json (TDD-001).
//   2. The portal computes a fallback when age > 24h (see escalation.ts in
//      SPEC-015-2-04). Either way the panel-context-builder hands us a
//      ready-to-render ISO timestamp.
//
// Display semantics:
//   - role="status" makes screen readers announce changes politely; the
//     announcement fires only after the panel re-renders so it does not
//     interrupt other operator activity.
//   - <time datetime data-relative="true"> lets future client-side code
//     swap the absolute timestamp for a "25h ago" relative string without
//     re-rendering. The `data-relative` flag is the contract.
//   - We render the absolute formatted time as the visible text fallback so
//     the badge is meaningful even if the relative-time enhancer never runs
//     (e.g., progressive enhancement disabled or script blocked by CSP).

import type { FC } from "hono/jsx";

interface Props {
    /** ISO-8601 timestamp at which the request was escalated. */
    escalatedAt: string;
}

/**
 * Format an ISO timestamp as a human-friendly relative string. The format is
 * intentionally short (`Nh`, `Nd`) so the badge fits in a tight UI slot.
 * Falls back to the raw string on parse failure rather than throwing.
 */
function formatRelative(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    const ageMs = Date.now() - ts;
    const hours = Math.floor(ageMs / 3_600_000);
    if (hours < 1) return "just now";
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export const EscalationBadge: FC<Props> = ({ escalatedAt }) => (
    <div class="escalation-badge" role="status">
        <span class="escalation-badge__icon" aria-hidden="true">
            !
        </span>
        <span class="escalation-badge__label">Escalated</span>
        <time
            datetime={escalatedAt}
            data-relative="true"
            class="escalation-badge__time"
        >
            {formatRelative(escalatedAt)}
        </time>
    </div>
);
