// SPEC-036-3-01..06 — Request Detail composition root.
// SPEC-037-7-01..04 — Adds page-head, .rd-stat block, standards-applied
// section, replaces <dialog> with .modal-bg overlay (consumes the shared
// `static/modal.js` helper), and verifies gate/timeline action wiring.
//
// Pure composition: imports each fragment from `fragments/*` and emits the
// 11-region order specified in TDD-036 §6.2 verbatim:
//
//   0. Page head (← Back · REQ id · Pause/Kill)       — RequestPageHead (037-7-01)
//   1. Request header / SSE meta region (.rd-head)     — RequestHeader (037-7-01)
//   2. Pipeline visualization                          — PipelineVis
//   3. Artifact pane (v1.1, persistent reading)        — ArtifactPane
//   4. Reviewer chain (review/code phases)             — ReviewerChain
//   5. Deploy pipeline (deploy phase)                  — DeployPipeline
//   6. Gate detail card (status === gate)              — GateDetail
//   7. Standards applied (flags.hasStandards)          — StandardsApplied (037-7-02)
//   8. Request timeline (always rendered)              — RequestTimeline
//   9. Run history (v1.1, always rendered)             — RunHistory
//  10. Confirm modal (mounted by gate-actions.js)       — modal-slot
//  11. Phase artifact modal (one per phase artifact)    — PhaseArtifactModal (037-7-03)
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
import { RequestPageHead } from "../fragments/request-page-head";
import { RequestTimeline } from "../fragments/request-timeline";
import { ReviewerChain } from "../fragments/reviewer-chain";
import { RunHistory } from "../fragments/run-history";
import { StandardsApplied } from "../fragments/standards-applied";

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

    // SPEC-037-7-02 — Standards-applied section gates on the explicit
    // `flags.hasStandards` AND a non-empty rule list.
    const standardsRules = request.standardsApplied ?? [];
    const showStandards =
        request.flags?.hasStandards === true && standardsRules.length > 0;

    return (
        <main class="request-detail">
            {/* Region 0: page-head — ← Back, request id, Pause/Kill. */}
            <RequestPageHead requestId={request.id} />

            {/* Region 1+2: request header + meta region. */}
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

            {/* Region 8: standards applied (flags.hasStandards). */}
            {showStandards ? (
                <StandardsApplied rules={standardsRules} />
            ) : null}

            {/* Phase timeline (legacy region preserved for OOB swaps). */}
            <RequestTimeline
                requestId={request.id}
                phases={request.phases}
            />

            {/* Region 9: run history (v1.1, always rendered) */}
            <RunHistory runs={request.runs} />

            {/* Region 11: phase artifact modal (one per phase) */}
            <PhaseArtifactModal
                artifacts={phaseArtifacts}
                requestId={request.id}
                allPhases={phases}
            />

            {/* Page-level scripts — SPEC-037-7-03 shared modal helper +
                SPEC-036-3-06 gate-actions confirm-modal interceptor. The
                shell template loads /static/htmx.min.js + theme-toggle.js;
                this view adds the surface-specific scripts. */}
            <script src="/static/modal.js" defer></script>
            <script src="/static/gate-actions.js" defer></script>
        </main>
    );
};
