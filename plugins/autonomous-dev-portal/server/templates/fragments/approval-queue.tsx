// SPEC-036-1-04 §ApprovalQueueStrip — v1.1 Dashboard region.
//
// Horizontal strip rendered between the repo card grid and the
// standards-drift summary. Shows the next 3 gate-blocked requests
// across all repos sorted by `waitedMin` desc (longest wait first).
//
// IMPORTANT: route handler is responsible for sort + slice — the
// fragment is pure (does not re-sort, does not re-filter). This
// keeps the SSE OOB fragment self-contained: the route can apply
// per-user filters in future without touching the fragment.
//
// Empty contract (SPEC-036-1-04 AC #3): when `gates.length === 0`,
// the entire `<section class="approval-queue">` is absent from the
// DOM (return null). Differs from the standards-drift section,
// which keeps its header even when empty.

import type { FC } from "hono/jsx";

import { Chip } from "../../components/primitives";
import type { PhaseName, StatusTone } from "../../components/primitives";
import type { DashboardRequest } from "../../types/render";

/**
 * Map raw `gateType` strings to `Chip` status tones. Kept as a small
 * helper so it's easy to extend (e.g. adding a `quota-exceeded` gate
 * type later) and so the test matrix can pin each mapping explicitly.
 *
 * SPEC-036-1-04 AC #5:
 *   reviewer-chain        -> warn
 *   standards-violation   -> err
 *   cost-cap              -> info
 *   anything else / undef -> muted
 */
export const gateTypeTone = (t?: string): StatusTone =>
    t === "reviewer-chain"
        ? "warn"
        : t === "standards-violation"
        ? "err"
        : t === "cost-cap"
        ? "info"
        : "muted";

/**
 * Map raw `gateType` strings to human-readable labels. Falls back
 * to the raw type so a new gate kind shows *something* meaningful
 * before its label is added here. SPEC-036-1-04 AC #6.
 */
export const gateTypeLabel = (t?: string): string =>
    t === "reviewer-chain"
        ? "Reviewer"
        : t === "standards-violation"
        ? "Standards"
        : t === "cost-cap"
        ? "Cost cap"
        : t ?? "Gate";

export interface ApprovalQueueStripProps {
    /** Pre-sorted, pre-sliced (max 3) gate-blocked requests. */
    gates: DashboardRequest[];
    /** Total gates across all repos — shown in the section header so
     *  the operator sees "showing 3 of N". Defaults to `gates.length`
     *  when omitted. */
    totalCount?: number;
}

export const ApprovalQueueStrip: FC<ApprovalQueueStripProps> = ({
    gates,
    totalCount,
}) => {
    // SPEC-036-1-04 AC #3: empty contract is "absent from DOM".
    // Hono's FC type doesn't admit a literal `null`, so we return an
    // empty fragment that emits no DOM (verified in unit tests).
    if (gates.length === 0) return <></>;
    return (
        <section id="approval-queue" class="sec approval-queue">
            <div class="sec-head">
                <h2>Awaiting approval</h2>
                <span class="meta-mono dim">
                    {totalCount ?? gates.length} total
                </span>
            </div>
            <div class="gate-strip">
                {gates.map((g) => (
                    <div class="gate-row">
                        <Chip variant="phase" tone={g.phase as PhaseName}>
                            {g.phase.toUpperCase()}
                        </Chip>
                        <span class="gate-repo">{g.repo}</span>
                        <span class="gate-id meta-mono">{g.id}</span>
                        <Chip
                            variant="status"
                            tone={gateTypeTone(g.gateType)}
                        >
                            {gateTypeLabel(g.gateType)}
                        </Chip>
                        <span class="gate-age meta-mono dim">
                            {g.waitedMin ?? 0}m
                        </span>
                        {/* SPEC-036-1-04 AC #8 — Review action must
                            navigate. The Btn primitive's class shape
                            (`btn primary sm`) is preserved so the CSS
                            applies identically; rendered as an anchor
                            so the href works. Same pattern used by
                            error.tsx. */}
                        <a
                            class="btn primary sm"
                            href={`/repo/${g.repo}/request/${g.id}`}
                        >
                            Review
                        </a>
                    </div>
                ))}
            </div>
        </section>
    );
};
