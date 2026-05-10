// SPEC-036-3-03 §Phase artifact modal — server-rendered hidden <dialog>
//
// One <dialog id="artifact-modal-${phase}"> is emitted per phase that
// carries an artifact. Rendered hidden by default; static/js/phase-artifact-
// modal.js opens the matching dialog via `dialog.showModal()` when the
// operator clicks the corresponding `pipe-step` in pipeline-vis.
//
// Backdrop click + Escape dismiss are native <dialog> behavior; we attach
// `data-dismiss="true"` to the close button for parity with the other
// portal modals.

import type { FC } from "hono/jsx";

import { ArtifactPane } from "./artifact-pane";
import type { RequestArtifact } from "../../types/render";

interface Props {
    artifacts: RequestArtifact[];
    requestId: string;
}

export const PhaseArtifactModal: FC<Props> = ({ artifacts, requestId }) => (
    <>
        {artifacts.map((artifact) => (
            <dialog
                id={`artifact-modal-${artifact.phase}`}
                class="modal modal-wide phase-artifact-modal"
                aria-labelledby={`artifact-modal-${artifact.phase}-title`}
            >
                <div class="modal-content">
                    <div class="modal-head">
                        <div>
                            <div class="modal-eyebrow">Phase artifact</div>
                            <h3
                                id={`artifact-modal-${artifact.phase}-title`}
                            >
                                {artifact.phase.toUpperCase()}-{requestId.slice(-4)}
                            </h3>
                        </div>
                        <button
                            type="button"
                            class="modal-close"
                            data-dismiss="true"
                            aria-label="Close"
                        >
                            ✕
                        </button>
                    </div>
                    <div class="artifact-body">
                        <ArtifactPane
                            phase={artifact.phase}
                            targetId={`artifact-modal-${artifact.phase}-body`}
                            artifact={artifact}
                        />
                    </div>
                </div>
            </dialog>
        ))}
    </>
);
