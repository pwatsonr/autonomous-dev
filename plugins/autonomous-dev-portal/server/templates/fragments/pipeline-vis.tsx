// SPEC-036-3-03 §Pipeline visualization — horizontal phase strip.
//
// Always rendered. Each step is a `<button class="pipe-step ${state}">` with
// `data-phase="${phase}"`. State is server-derived from the request's
// current phase index relative to the canonical pipeline order:
//   i <  current  → "done"
//   i === current → "now"   (carries the glow ring outline)
//   i >  current  → "pending"
//
// Border-radius: first step has left radius; last step has right radius;
// all but the last carry `border-right: 0`. These are emitted as extra
// CSS classes (`first`, `last`, `no-right`) consumed by primitives.css.
//
// Click handler — `static/modal.js` (SPEC-037-7-03) reads
// `data-modal-open="artifact-{phase}"` and opens the matching
// `.modal-bg[data-modal="artifact-{phase}"]` overlay.

import type { FC } from "hono/jsx";

interface Props {
    /** Canonical pipeline phases (variant-aware). */
    phases: string[];
    /** Currently-active phase name — drives the `now` step. */
    currentPhase: string;
}

export const PipelineVis: FC<Props> = ({ phases, currentPhase }) => {
    const currentIdx = Math.max(0, phases.indexOf(currentPhase));
    return (
        <section class="sec pipeline-section">
            <div class="sec-head">
                <h2>Pipeline</h2>
                <span class="meta-mono dim">click a phase to inspect</span>
            </div>
            <div class="pipeline">
                {phases.map((p, i) => {
                    const state =
                        i < currentIdx
                            ? "done"
                            : i === currentIdx
                              ? "now"
                              : "pending";
                    const positional =
                        i === 0
                            ? "first"
                            : i === phases.length - 1
                              ? "last"
                              : "";
                    const noRight =
                        i === phases.length - 1 ? "" : "no-right";
                    const cls = ["pipe-step", state, positional, noRight]
                        .filter((s) => s !== "")
                        .join(" ");
                    return (
                        <button
                            type="button"
                            class={cls}
                            data-phase={p}
                            data-state={state}
                            data-modal-open={`artifact-${p}`}
                        >
                            <span class="pipe-dot" aria-hidden="true"></span>
                            <span class="pipe-name">{p.toUpperCase()}</span>
                            <span class="pipe-state meta-mono">{state}</span>
                        </button>
                    );
                })}
            </div>
        </section>
    );
};
