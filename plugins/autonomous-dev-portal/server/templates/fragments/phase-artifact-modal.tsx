// SPEC-036-3-03 / SPEC-037-7-03 — Phase artifact modal.
//
// Pre-SPEC-037-7-03 this fragment emitted a native `<dialog>` element
// opened via `dialog.showModal()`. The new contract uses the shared
// `.modal-bg` + `.modal` overlay pattern (see `static/modal.js`):
//
//   <div class="modal-bg" data-modal="artifact-{phase}" hidden>
//     <div class="modal modal-wide" role="dialog" aria-modal="true"
//          aria-labelledby="artifact-modal-{phase}-title">
//       <div class="modal-head">…</div>
//       <div class="artifact-body">…</div>
//     </div>
//   </div>
//
// Triggers are wired by `static/modal.js`:
//   - `[data-modal-open="artifact-{phase}"]` opens the modal
//   - `[data-modal-close]` closes it
//   - Escape / backdrop click also close
//
// The pipeline-vis pipe-step buttons carry the corresponding
// `data-modal-open` attribute so a click opens the matching modal.

import type { FC } from "hono/jsx";

import { ArtifactPane } from "./artifact-pane";
import type { RequestArtifact } from "../../types/render";

interface Props {
    artifacts: RequestArtifact[];
    requestId: string;
    allPhases?: string[];
}

export const PhaseArtifactModal: FC<Props> = ({ artifacts, requestId, allPhases = [] }) => {
    // Create a map of existing artifacts by phase
    const artifactByPhase = new Map(artifacts.map(a => [a.phase, a]));

    // Determine which phases to create modals for
    const phasesToRender = allPhases.length > 0 ? allPhases : artifacts.map(a => a.phase);

    return (
        <>
            {phasesToRender.map((phase) => {
                const artifact = artifactByPhase.get(phase);
                return (
                    <div
                        key={phase}
                        class="modal-bg phase-artifact-modal"
                        data-modal={`artifact-${phase}`}
                        hidden
                    >
                        <div
                            class="modal modal-wide"
                            role="dialog"
                            aria-modal="true"
                            aria-labelledby={`artifact-modal-${phase}-title`}
                        >
                            <div class="modal-head">
                                <div>
                                    <div class="modal-eyebrow">Phase artifact</div>
                                    <h3
                                        id={`artifact-modal-${phase}-title`}
                                    >
                                        {phase.toUpperCase()}-{requestId.slice(-4)}
                                    </h3>
                                </div>
                                <button
                                    type="button"
                                    class="modal-close"
                                    data-modal-close
                                    aria-label="Close"
                                >
                                    ✕
                                </button>
                            </div>
                            <div class="artifact-body">
                                {artifact ? (
                                    <ArtifactPane
                                        phase={phase}
                                        targetId={`artifact-modal-${phase}-body`}
                                        artifact={artifact}
                                    />
                                ) : (
                                    <div class="artifact-placeholder">
                                        <h4>{phase.toUpperCase()} phase artifact</h4>
                                        <p>This phase artifact will be available once the request progresses to this stage.</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                );
            })}
        </>
    );
};
