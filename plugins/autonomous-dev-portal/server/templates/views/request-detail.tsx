// FR-026-20..22 — Request Detail v3 composition root.
//
// Implements the v3 redesign layout for the request-detail surface:
//
//   [Topbar] title=req-id, subTitle=summary, rightSlot=priority+repo+Back
//   [.main-inner]
//     [.phase-timeline.sec]         — numbered 8-step phase track
//     [.rdetail]                    — two-column grid (minmax(0,1fr) / 360px)
//       [.rdetail-main]             — artifact pane (HTMX swap target)
//       [.gate-panel sticky]        — gate panel (sticky, 360px)
//
// The artifact pane is the hx-target (#rd-artifact-pane); clicking a phase
// step fires hx-get → /repo/:repo/request/:id/artifact/:phase which returns
// the RdV3ArtifactPane fragment with outerHTML swap (no modal, no redirect).
//
// The gate panel shows reviewer verdict rows, a note textarea, and
// Approve / Reject / Defer buttons (or a post-decision banner when the
// server has already recorded a decision). Gate action POSTs target the
// existing /repo/:repo/request/:id/gate/approve|reject endpoints.
//
// Design source of truth:
//   /tmp/design_extract/autonomous-dev-v3/project/request-detail.jsx
//   /tmp/design_extract/autonomous-dev-v3/project/static/app.css
//
// CSS for this view: static/v3/request-detail.css

import type { FC } from "hono/jsx";

import type { RenderProps } from "../../types/render";
import type { RequestRecord } from "../../types/render";
import { Topbar } from "../../components/topbar";
import { RdV3PhaseTrack } from "../fragments/rd-v3-phase-track";
import type { PhaseStepV3 } from "../fragments/rd-v3-phase-track";
import { RdV3ArtifactPane } from "../fragments/rd-v3-artifact-pane";
import { RdV3GatePanel } from "../fragments/rd-v3-gate-panel";
import type { GateReviewer } from "../fragments/rd-v3-gate-panel";
import { RdV3TopbarRight } from "../fragments/rd-v3-request-header";

/** Default 8-phase pipeline order. */
const DEFAULT_PIPELINE = [
    "prd",
    "tdd",
    "plan",
    "spec",
    "code",
    "review",
    "deploy",
    "observe",
] as const;

/** Display labels for each pipeline phase key. */
const PHASE_LABELS: Record<string, string> = {
    prd: "PRD",
    tdd: "TDD",
    plan: "Plan",
    spec: "Spec",
    code: "Code",
    review: "Review",
    deploy: "Deploy",
    observe: "Observe",
};

/**
 * Derive the PhaseStepV3 list from the request record.
 *
 * State mapping:
 *   - phases before currentPhase → "done"
 *   - currentPhase               → "now"
 *   - phases after currentPhase  → "pending"
 *
 * Duration is left empty because the stub RequestRecord does not carry
 * per-phase durations in the v1 shape; a future iteration can thread
 * `phases[].duration` through when the daemon exposes it.
 *
 * @param request - current RequestRecord
 * @returns ordered PhaseStepV3 array
 */
function derivePhaseSteps(request: RequestRecord): PhaseStepV3[] {
    const pipeline = request.pipelinePhases ?? [...DEFAULT_PIPELINE];
    const currentPhase = request.currentPhase ?? pipeline[0] ?? "prd";
    const currentIndex = pipeline.indexOf(currentPhase);

    return pipeline.map((key, i) => {
        let state: PhaseStepV3["state"];
        if (i < currentIndex) {
            state = "done";
        } else if (i === currentIndex) {
            state = "now";
        } else {
            state = "pending";
        }
        return {
            key,
            label: PHASE_LABELS[key] ?? key.toUpperCase(),
            state,
            dur: "",
        };
    });
}

/**
 * Build the gate-panel reviewer list from the request record.
 *
 * Maps `RequestReviewer` (full shape) → `GateReviewer` (verdict-only shape
 * for the gate panel). Falls back to an empty array so the panel renders
 * with no reviewer rows when the request has none.
 *
 * @param request - current RequestRecord
 * @returns GateReviewer array
 */
function deriveGateReviewers(request: RequestRecord): GateReviewer[] {
    if (request.reviewers === undefined || request.reviewers.length === 0) {
        return [];
    }
    return request.reviewers.map((r) => ({
        id: r.name,
        verdict: r.blocking ? "fail" : "pass",
    }));
}

/**
 * Format a cost number as "$X.XX" or "$—" when undefined.
 *
 * @param n - cost in USD or undefined
 * @returns formatted string
 */
function fmt(n: number | undefined): string {
    if (n === undefined) return "$—";
    return `$${n.toFixed(2)}`;
}

/**
 * Derive a short "opened" date string from the startedAt ISO timestamp.
 * Returns "—" when not available.
 *
 * @param iso - ISO-8601 timestamp or undefined
 * @returns formatted date string
 */
function fmtOpened(iso: string | undefined): string {
    if (iso === undefined || iso === "") return "—";
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().slice(0, 10);
}

/**
 * FR-026-20..22 — Request Detail v3 view.
 *
 * Composes the Topbar + phase track strip + two-column rdetail grid from
 * the v3 fragment library. All fragments are server-rendered; no client-
 * side state is used in the initial render. HTMX provides the phase-swap
 * interactivity.
 *
 * @param props - request-detail render props
 */
export const RequestDetailView: FC<RenderProps["request-detail"]> = ({
    request,
    csrfToken = "",
}) => {
    const pipeline = request.pipelinePhases ?? [...DEFAULT_PIPELINE];
    const currentPhase = request.currentPhase ?? pipeline[0] ?? "prd";
    const status = request.status ?? "running";

    const steps = derivePhaseSteps(request);
    const gateReviewers = deriveGateReviewers(request);

    // Gate label: e.g. "Spec gate · review"
    const gateLabel = `${currentPhase.charAt(0).toUpperCase()}${currentPhase.slice(1)} gate · review`;

    // Derive the branch name: fall back to a synthetic branch slug based on
    // the request id (the daemon creates branches as "auto/<req-id>").
    const branch = `auto/${request.id.toLowerCase()}`;

    // Artifact pane props: derive from the current phase step
    const currentStep = steps.find((s) => s.key === currentPhase);
    const artifactState = currentStep?.state ?? "pending";

    // Topbar subTitle: request summary or id
    const subTitle =
        request.summary !== undefined && request.summary !== ""
            ? request.summary
            : undefined;

    // Priority: derive from the gate type or fall back to "MED"
    const priority = status === "gate" ? "HIGH" : "MED";

    // Terminal requests (done/cancelled/failed) must not render live gate
    // controls — approving a dead request writes a gate decision the
    // daemon will never consume (visual crawl p4: a CANCELLED request
    // showed "Approve · promote to code").
    const isTerminal =
        status === "done" || status === "cancelled" || status === "failed";
    const terminalLabel = status.toUpperCase();

    return (
        <>
            <Topbar
                title={request.id}
                subTitle={subTitle}
                rightSlot={
                    <RdV3TopbarRight
                        priority={priority}
                        repo={request.repo}
                    />
                }
            />
            <div class="main-inner">
                {/* Phase pipeline strip */}
                <RdV3PhaseTrack
                    repo={request.repo}
                    requestId={request.id}
                    opened={fmtOpened(request.startedAt)}
                    branch={branch}
                    cost={fmt(request.cost)}
                    budget={fmt(undefined)}
                    steps={steps}
                    selectedPhase={currentPhase}
                />

                {isTerminal ? (
                    <div
                        class={`rd-terminal-banner rd-terminal-${status}`}
                        role="status"
                    >
                        <span class="rd-terminal-chip">{terminalLabel}</span>
                        This request is terminal — phases are frozen and
                        gate actions are disabled.
                    </div>
                ) : null}

                {/* Two-column layout: artifact pane + gate panel */}
                <div class="rdetail">
                    <div class="rdetail-main">
                        <RdV3ArtifactPane
                            phase={currentPhase}
                            state={artifactState}
                            artifact={request.currentArtifact}
                            branch={branch}
                            agent={request.currentArtifact?.phase ?? ""}
                            dur=""
                            cost={fmt(request.cost)}
                        />
                    </div>

                    {/* Gate panel — sticky 360px right column. Terminal
                        requests get a static notice, never live controls. */}
                    <div class="rd-gate-col">
                        {isTerminal ? (
                            <section class="gate-panel" aria-label="Gate status">
                                <h3>{gateLabel}</h3>
                                <p class="empty dim">
                                    No gate is open — the request is{" "}
                                    {status}. Decisions are recorded in the
                                    audit log.
                                </p>
                            </section>
                        ) : (
                            <RdV3GatePanel
                                requestId={request.id}
                                repo={request.repo}
                                gateLabel={gateLabel}
                                reviewers={gateReviewers}
                                csrfToken={csrfToken}
                                decision={request.gateDecision ?? null}
                            />
                        )}
                    </div>
                </div>
            </div>
        </>
    );
};
