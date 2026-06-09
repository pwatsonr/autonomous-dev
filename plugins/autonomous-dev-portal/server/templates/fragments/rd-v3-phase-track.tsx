// FR-026-20 — Request Detail v3: numbered 8-step phase track with hairline
// connector. States: done/now(pulsing amber)/pending/selected. Clicking a
// phase fires an HTMX GET that swaps the artifact pane inline.
//
// CSS classes consumed from app.css:
//   .phase-track, .phase-step, .dot-big, .phase-name, .phase-meta
//   .done, .now, .selected
//
// Extended classes defined in v3/request-detail.css:
//   .phase-timeline, .phase-timeline-head
//
// HTMX: each step's hx-get targets #rd-artifact-pane with outerHTML swap.
// Accessibility: role=tablist on container; each step is role=tab with
// aria-selected; keyboard-operable via button elements.

import type { FC } from "hono/jsx";

export interface PhaseStepV3 {
    /** Phase key (e.g. "prd", "tdd"). */
    key: string;
    /** Display label (e.g. "PRD", "TDD"). */
    label: string;
    /** Server-derived state for this phase. */
    state: "done" | "now" | "pending";
    /** Duration string rendered beneath the label, empty when pending. */
    dur: string;
}

interface Props {
    /** Repo slug — used to build the hx-get URL. */
    repo: string;
    /** Request id — used to build the hx-get URL. */
    requestId: string;
    /** Opened date string (e.g. "2026-05-09"). */
    opened: string;
    /** Branch name. */
    branch: string;
    /** Total cost formatted as "$X.XX". */
    cost: string;
    /** Budget formatted as "$X.XX". */
    budget: string;
    /** All phases in pipeline order. */
    steps: PhaseStepV3[];
    /** Key of the currently-selected phase (artifact pane view). */
    selectedPhase: string;
}

/**
 * FR-026-20 — Numbered horizontal phase track.
 *
 * Renders a `.phase-timeline` section containing a `.phase-track` grid of
 * eight steps connected by a hairline `::before` rule. Each step is a
 * `<button>` with `hx-get` that loads the phase's artifact pane inline
 * into `#rd-artifact-pane`.
 *
 * @param props - {@link Props}
 */
export const RdV3PhaseTrack: FC<Props> = ({
    repo,
    requestId,
    opened,
    branch,
    cost,
    budget,
    steps,
    selectedPhase,
}) => (
    <div class="phase-timeline sec">
        <div class="phase-timeline-head">
            <h3 class="phase-timeline-title">Phase pipeline</h3>
            <span class="meta-mono dim">
                opened {opened} &middot; branch{" "}
                <span class="phase-branch">{branch}</span>
            </span>
            <span class="spacer"></span>
            <span class="meta-mono dim">
                cost{" "}
                <span class="phase-cost">
                    {cost} / {budget}
                </span>
            </span>
        </div>
        <div class="phase-track" role="tablist" aria-label="Pipeline phases">
            {steps.map((step, i) => {
                const isSelected = step.key === selectedPhase;
                const cls = [
                    "phase-step",
                    step.state,
                    isSelected ? "selected" : "",
                ]
                    .filter(Boolean)
                    .join(" ");
                return (
                    <button
                        type="button"
                        class={cls}
                        role="tab"
                        aria-selected={isSelected ? "true" : "false"}
                        aria-label={`${step.label} phase — ${step.state}`}
                        hx-get={`/repo/${repo}/request/${requestId}/artifact/${step.key}`}
                        hx-target="#rd-artifact-pane"
                        hx-swap="outerHTML"
                        hx-push-url="false"
                    >
                        <div class="dot-big" aria-hidden="true">
                            {i + 1}
                        </div>
                        <div class="phase-name">{step.label.toUpperCase()}</div>
                        <div class="phase-meta">
                            {step.dur !== "" ? step.dur : "—"}
                        </div>
                    </button>
                );
            })}
        </div>
    </div>
);
