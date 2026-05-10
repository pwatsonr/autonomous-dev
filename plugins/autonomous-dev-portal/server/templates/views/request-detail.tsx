// SPEC-036-3-01..06 — Request Detail composition root.
//
// Pure composition: imports each fragment from `fragments/*` and emits the
// 11-region order specified in TDD-036 §6.2 verbatim:
//
//   1. Page head (h1 + status / variant chips)         — RequestHeader
//   2. Request header / SSE meta region                — RequestHeader (id)
//   3. Pipeline visualization                          — PipelineVis
//   4. Artifact pane (v1.1, persistent reading)        — ArtifactPane
//   5. Reviewer chain (review/code phases)             — ReviewerChain
//   6. Deploy pipeline (deploy phase)                  — DeployPipeline
//   7. Gate detail card (status === gate)              — GateDetail
//   8. Standards applied (TODO — out of scope here)
//   9. Run history (v1.1, always rendered)             — RunHistory
//  10. Confirm modal (mounted by gate-actions.js)       — modal-slot
//  11. Phase artifact modal (one per phase artifact)    — PhaseArtifactModal
//
// Conditional rendering uses straight ternaries on the request shape — no
// fragment-level logic is duplicated here. All fragments self-handle their
// empty cases.

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import { ArtifactPane } from "../fragments/artifact-pane";
import { DeployPipeline } from "../fragments/deploy-pipeline";
import { GateDetail } from "../fragments/gate-detail";
import { PhaseArtifactModal } from "../fragments/phase-artifact-modal";
import { PipelineVis } from "../fragments/pipeline-vis";
import { RequestHeader } from "../fragments/request-header";
import { RequestTimeline } from "../fragments/request-timeline";
import { ReviewerChain } from "../fragments/reviewer-chain";
import { RunHistory } from "../fragments/run-history";

const DEFAULT_PIPELINE: string[] = [
    "prd",
    "tdd",
    "plan",
    "spec",
    "code",
    "review",
    "deploy",
    "observe",
];

export const RequestDetailView: FC<RenderProps["request-detail"]> = ({
    request,
    csrfToken,
}) => {
    const phases = request.pipelinePhases ?? DEFAULT_PIPELINE;
    const currentPhase = request.currentPhase ?? phases[0] ?? "prd";
    const status = request.status ?? "running";
    const reviewers = request.reviewers ?? [];
    const showReviewerChain =
        currentPhase === "review" || currentPhase === "code";
    const showDeploy = currentPhase === "deploy";
    const showGate = status === "gate";
    // Only artifacts attached to the request show up in the modal stack;
    // future iteration will surface a per-phase map. For now the current
    // artifact is always also reachable as a modal.
    const phaseArtifacts =
        request.currentArtifact !== undefined ? [request.currentArtifact] : [];

    return (
        <main class="request-detail">
            {/* Region 1+2: page head + meta region */}
            <RequestHeader request={request} />

            {/* Region 3: pipeline visualization (always rendered) */}
            <div id={`request-${request.id}-phase`}>
                <PipelineVis phases={phases} currentPhase={currentPhase} />
            </div>

            {/* Region 4: artifact pane (v1.1, always rendered) */}
            <div id={`request-${request.id}-artifact`}>
                <ArtifactPane
                    phase={currentPhase}
                    targetId={`request-${request.id}-artifact-pane`}
                    artifact={request.currentArtifact}
                />
            </div>

            {/* Region 5: reviewer chain (review/code phases) */}
            {showReviewerChain ? (
                <ReviewerChain reviewers={reviewers} />
            ) : null}

            {/* Region 6: deploy pipeline (deploy phase) */}
            {showDeploy ? (
                <div id={`request-${request.id}-deploy`}>
                    <DeployPipeline
                        deployStage={request.deployStage ?? "preflight"}
                        deployTarget={request.deployTarget}
                    />
                </div>
            ) : null}

            {/* Region 7: gate detail card (status === gate) */}
            {showGate ? (
                <GateDetail
                    requestId={request.id}
                    repo={request.repo}
                    gateType={request.gateType ?? "reviewer-chain"}
                    gateDetail={request.gateDetail ?? ""}
                    waitedMin={request.waitedMin ?? 0}
                    csrfToken={csrfToken}
                />
            ) : null}

            {/* Phase timeline (legacy region preserved for OOB swaps). */}
            <RequestTimeline
                requestId={request.id}
                phases={request.phases}
            />

            {/* Region 9: run history (v1.1, always rendered) */}
            <RunHistory runs={request.runs} />

            {/* Region 11: phase artifact modal (one per artifact) */}
            <PhaseArtifactModal
                artifacts={phaseArtifacts}
                requestId={request.id}
            />
        </main>
    );
};
