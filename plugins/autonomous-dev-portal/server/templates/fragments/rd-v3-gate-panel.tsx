// FR-026-22 — Request Detail v3: 360px sticky gate panel.
//
// Renders a `.gate-panel` card (sticky, 3px brand top border) containing:
//   1. "Spec gate · review" heading
//   2. Pass/warn/fail chip summary counts
//   3. Per-reviewer rows with pass/warn/fail colored dots + verdict labels
//   4a. Note textarea + Approve / Reject / Defer buttons (pre-decision)
//   4b. Post-decision banner (ok-tint or err-tint)
//
// CSS classes consumed from app.css:
//   .gate-panel, .review-row, .dot, .chip.ok/warn/err,
//   .btn.primary/.destructive/.ghost, .note, .actions
//
// Post-decision banner classes are defined in v3/request-detail.css.
//
// HTMX: buttons POST to the gate action endpoints via hx-post. The
// note textarea value is included via hx-include. The panel swaps itself
// via hx-target="#rd-gate-panel" hx-swap="outerHTML".
//
// Accessibility: verdict dot has aria-label; buttons have descriptive text.
// The note textarea has a visible label via placeholder (supplemented by
// aria-label for SR users).

import type { FC } from "hono/jsx";

export interface GateReviewer {
    /** Reviewer agent id / name. */
    id: string;
    /** Verdict for this reviewer. */
    verdict: "pass" | "warn" | "fail";
}

export type GateDecision = "approved" | "rejected" | "deferred" | null;

interface Props {
    /** Request id. */
    requestId: string;
    /** Repo slug. */
    repo: string;
    /** Gate label (e.g. "Spec gate · review"). */
    gateLabel: string;
    /** Per-reviewer rows. */
    reviewers: GateReviewer[];
    /** Server-side CSRF token for form submissions. */
    csrfToken: string;
    /**
     * When non-null a decision has been recorded and the panel renders the
     * post-decision banner instead of the action buttons.
     */
    decision?: GateDecision;
}

/**
 * FR-026-22 — Sticky gate panel.
 *
 * @param props - {@link Props}
 */
export const RdV3GatePanel: FC<Props> = ({
    requestId,
    repo,
    gateLabel,
    reviewers,
    csrfToken,
    decision = null,
}) => {
    const passes = reviewers.filter((r) => r.verdict === "pass").length;
    const warns = reviewers.filter((r) => r.verdict === "warn").length;
    const fails = reviewers.filter((r) => r.verdict === "fail").length;

    /** Map verdict value to dot class. */
    function verdictDot(v: GateReviewer["verdict"]): string {
        if (v === "pass") return "ok";
        if (v === "warn") return "warn";
        return "err";
    }

    const approveUrl = `/repo/${repo}/request/${requestId}/gate/approve`;
    const rejectUrl = `/repo/${repo}/request/${requestId}/gate/reject`;
    const deferUrl = `/repo/${repo}/request/${requestId}/gate/defer`;

    return (
        <aside
            class="gate-panel"
            id="rd-gate-panel"
            aria-label="Gate review panel"
        >
            <h4>{gateLabel}</h4>

            {/* Chip summary row */}
            <div class="rd-gate-chips">
                <span class="chip ok">{passes} pass</span>
                {warns > 0 ? (
                    <span class="chip warn">{warns} warn</span>
                ) : null}
                {fails > 0 ? (
                    <span class="chip err">{fails} fail</span>
                ) : null}
            </div>

            {/* Per-reviewer rows */}
            <div class="rd-reviewer-rows">
                {reviewers.map((r) => (
                    <div class="review-row" key={r.id}>
                        <span
                            class={`dot ${verdictDot(r.verdict)}`}
                            aria-label={r.verdict}
                        ></span>
                        <span class="ag">{r.id}</span>
                        <span class={`verdict ${r.verdict}`}>{r.verdict}</span>
                    </div>
                ))}
            </div>

            {/* Action area */}
            {decision !== null ? (
                /* Post-decision banner */
                <div
                    class={`rd-decision-banner ${
                        decision === "approved"
                            ? "approved"
                            : decision === "deferred"
                              ? "deferred"
                              : "rejected"
                    }`}
                    role="status"
                    aria-live="polite"
                >
                    {decision === "approved"
                        ? "Approved → promoted to code"
                        : decision === "rejected"
                          ? "Rejected → requeued"
                          : "Deferred to operator"}
                </div>
            ) : (
                <>
                    {/* Hidden CSRF field included by hx-include */}
                    <input
                        type="hidden"
                        name="csrf_token"
                        value={csrfToken}
                        id="rd-gate-csrf"
                    />
                    <textarea
                        class="note"
                        name="note"
                        id="rd-gate-note"
                        placeholder="// optional review note (audit log)…"
                        aria-label="Optional review note for the audit log"
                        rows={3}
                    ></textarea>
                    <div class="actions">
                        <button
                            type="button"
                            class="btn primary"
                            hx-post={approveUrl}
                            hx-include="#rd-gate-csrf,#rd-gate-note"
                            hx-target="#rd-gate-panel"
                            hx-swap="outerHTML"
                            aria-label="Approve and promote to code phase"
                        >
                            Approve &middot; promote to code
                        </button>
                        <button
                            type="button"
                            class="btn destructive"
                            hx-post={rejectUrl}
                            hx-include="#rd-gate-csrf,#rd-gate-note"
                            hx-target="#rd-gate-panel"
                            hx-swap="outerHTML"
                            aria-label="Reject and requeue for revision"
                        >
                            Reject &middot; requeue
                        </button>
                        <button
                            type="button"
                            class="btn ghost"
                            hx-post={deferUrl}
                            hx-include="#rd-gate-csrf,#rd-gate-note"
                            hx-target="#rd-gate-panel"
                            hx-swap="outerHTML"
                            aria-label="Defer decision to operator"
                        >
                            Defer to operator
                        </button>
                    </div>
                </>
            )}
        </aside>
    );
};
