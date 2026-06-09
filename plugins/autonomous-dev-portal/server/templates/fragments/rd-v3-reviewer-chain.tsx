// FR-026-22 — Request Detail v3: reviewer verdict rows inside the gate panel.
//
// This fragment renders a compact list of reviewer verdict rows for use
// inside the gate panel sidebar. It is separate from the full ReviewerChain
// fragment (which is a section in the main column) so the gate panel can
// compose it independently.
//
// CSS classes consumed from app.css:
//   .gate-panel .review-row, .dot.ok/.warn/.err, .ag, .verdict.pass/.warn/.fail
//
// Accessibility: each verdict dot has an aria-label describing the verdict.

import type { FC } from "hono/jsx";

export interface ReviewerVerdictRow {
    /** Reviewer agent id. */
    id: string;
    /** Verdict for this reviewer. */
    verdict: "pass" | "warn" | "fail";
}

interface Props {
    rows: ReviewerVerdictRow[];
}

function dotClass(verdict: ReviewerVerdictRow["verdict"]): string {
    if (verdict === "pass") return "ok";
    if (verdict === "warn") return "warn";
    return "err";
}

/**
 * FR-026-22 — Compact reviewer verdict list for the gate panel.
 *
 * Renders each reviewer as a `.review-row` with a colored dot, agent id,
 * and verdict label. Designed to be composed inside `RdV3GatePanel`.
 *
 * @param props - {@link Props}
 */
export const RdV3ReviewerRows: FC<Props> = ({ rows }) => (
    <div class="rd-reviewer-rows">
        {rows.map((r) => (
            <div class="review-row" key={r.id}>
                <span
                    class={`dot ${dotClass(r.verdict)}`}
                    aria-label={r.verdict}
                ></span>
                <span class="ag">{r.id}</span>
                <span class={`verdict ${r.verdict}`}>{r.verdict}</span>
            </div>
        ))}
    </div>
);
