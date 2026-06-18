// #502 / #499 / #501 — Request Detail v3: summary + artifact index.
//
// Three operator-facing sections rendered near the top of the detail view,
// all driven by REAL data synthesized in the request-record reader (no
// hand-written copy, no fabricated artifacts):
//
//   RdV3SummaryCard   — #502 plain-language "what this request did" card:
//                       what was requested, what was produced, the outcome
//                       (with a tone chip). Synthesized from phase-result
//                       feedback + the artifact list + lifecycle status.
//
//   RdV3PrLink        — #501 the github_pr artifact URL as a prominent
//                       clickable link (external, noopener). Rendered only
//                       when the request opened a PR.
//
//   RdV3ArtifactIndex — #499 the list of artifacts the request produced
//                       (PRD/TDD/plan/spec/doc/github_pr/evidence). Readable
//                       docs are HTMX tabs that swap the artifact pane in
//                       place (same endpoint + target as the phase track);
//                       the PR is an external link; other artifacts render
//                       as inert rows showing their kind + path.
//
// CSS for these lives in static/v3/request-detail.css (.rd-summary*,
// .rd-prlink*, .rd-artifacts*). All classes are covered by the
// css-coverage test (#417).
//
// CSP: no inline scripts/handlers. The readable-artifact rows reuse the
// phase track's HTMX contract (hx-get → artifact endpoint, hx-target
// #rd-artifact-pane, outerHTML swap). The selected-row highlight on click
// is handled by static/js/rd-artifact-select.js (delegated, CSP-safe).

import type { FC } from "hono/jsx";

import type { RequestArtifactRef, RequestSummary } from "../../types/render";

/** Human label for an artifact kind shown in the index + summary. */
const KIND_LABELS: Record<string, string> = {
    prd: "PRD",
    tdd: "TDD",
    plan: "Plan",
    spec: "Spec",
    doc: "Doc",
    github_pr: "Pull request",
    "test-output": "Test output",
    dockerfile: "Dockerfile",
    "deploy-script": "Deploy script",
};

function kindLabel(kind: string): string {
    return KIND_LABELS[kind] ?? kind.replace(/[-_]/g, " ");
}

/**
 * #502 — plain-language summary card. Renders only the fields that are
 * present so a partially-run request still gets a useful, honest summary.
 */
export const RdV3SummaryCard: FC<{ summary?: RequestSummary }> = ({
    summary,
}) => {
    if (
        summary === undefined ||
        (summary.requested === undefined &&
            summary.produced === undefined &&
            summary.outcome === undefined)
    ) {
        return <></>;
    }
    const tone = summary.outcomeTone ?? "muted";
    return (
        <section class="rd-summary card" aria-label="Request summary">
            <div class="card-h">
                <h3>Summary</h3>
                {summary.outcome !== undefined ? (
                    <>
                        <span class="spacer"></span>
                        <span class={`chip ${tone} rd-summary-chip`}>
                            {summary.outcome}
                        </span>
                    </>
                ) : null}
            </div>
            <div class="card-b rd-summary-body">
                {summary.requested !== undefined ? (
                    <p class="rd-summary-line">
                        <span class="rd-summary-key">Requested</span>
                        <span class="rd-summary-val">{summary.requested}</span>
                    </p>
                ) : null}
                {summary.produced !== undefined ? (
                    <p class="rd-summary-line">
                        <span class="rd-summary-key">Produced</span>
                        <span class="rd-summary-val">{summary.produced}</span>
                    </p>
                ) : null}
                {summary.requested === undefined &&
                summary.produced === undefined ? (
                    <p class="dim rd-summary-empty">
                        No artifacts recorded yet for this request.
                    </p>
                ) : null}
            </div>
        </section>
    );
};

/**
 * #501 — surface the PR link. External anchor (new tab, noopener). Renders
 * nothing when the request has no github_pr artifact URL.
 */
export const RdV3PrLink: FC<{ prUrl?: string }> = ({ prUrl }) => {
    if (prUrl === undefined || prUrl === "") return <></>;
    return (
        <a
            class="btn primary sm rd-prlink"
            href={prUrl}
            target="_blank"
            rel="noopener"
            aria-label="Open the pull request for this request on GitHub"
        >
            View pull request →
        </a>
    );
};

/**
 * Render one artifact row. Returns the intrinsic element directly (button /
 * anchor / div) so the row participates in the `.rd-artifact-list` grid and
 * carries its own `key`. Variants:
 *   - readable doc → <button> HTMX tab (swaps the artifact pane in place)
 *   - github_pr    → <a> external link
 *   - other        → inert <div> showing kind + path (evidence file)
 */
function renderArtifactRow(
    repo: string,
    requestId: string,
    a: RequestArtifactRef,
    selectedPhase: string | undefined,
    key: string,
): JSX.Element {
    const label = kindLabel(a.kind);

    if (a.readable) {
        const selected = a.phase === selectedPhase;
        const title = a.title ?? a.path ?? label;
        return (
            <button
                key={key}
                type="button"
                class={`rd-artifact-row${selected ? " selected" : ""}`}
                data-artifact-row
                aria-pressed={selected ? "true" : "false"}
                hx-get={`/repo/${repo}/request/${requestId}/artifact/${a.phase}`}
                hx-target="#rd-artifact-pane"
                hx-swap="outerHTML"
                hx-push-url="false"
            >
                <span class="rd-artifact-kind">{label}</span>
                <span class="rd-artifact-title">{title}</span>
                <span class="rd-artifact-phase meta-mono dim">{a.phase}</span>
            </button>
        );
    }

    if (a.kind === "github_pr" && a.url !== undefined) {
        return (
            <a
                key={key}
                class="rd-artifact-row rd-artifact-row-link"
                href={a.url}
                target="_blank"
                rel="noopener"
            >
                <span class="rd-artifact-kind">{label}</span>
                <span class="rd-artifact-title">
                    {a.title ?? a.url ?? "Pull request"}
                </span>
                <span class="rd-artifact-phase meta-mono dim">{a.phase}</span>
            </a>
        );
    }

    return (
        <div key={key} class="rd-artifact-row rd-artifact-row-inert">
            <span class="rd-artifact-kind">{label}</span>
            <span class="rd-artifact-title meta-mono">
                {a.title ?? a.path ?? a.kind}
            </span>
            <span class="rd-artifact-phase meta-mono dim">{a.phase}</span>
        </div>
    );
}

/**
 * #499 — artifact index. Lists every artifact the request produced, grouped
 * by render affordance: readable docs (HTMX tabs), the PR (external link),
 * and inert evidence rows. Empty state when nothing was recorded.
 */
export const RdV3ArtifactIndex: FC<{
    repo: string;
    requestId: string;
    artifacts: RequestArtifactRef[];
    selectedPhase?: string;
}> = ({ repo, requestId, artifacts, selectedPhase }) => (
    <section class="rd-artifacts card" aria-label="Artifacts produced">
        <div class="card-h">
            <h3>Artifacts</h3>
            <span class="spacer"></span>
            <span class="meta-mono dim rd-artifacts-count">
                {artifacts.length}
            </span>
        </div>
        <div class="card-b rd-artifacts-body">
            {artifacts.length === 0 ? (
                <p class="dim rd-artifacts-empty">
                    This request has not produced any artifacts yet.
                </p>
            ) : (
                <div class="rd-artifact-list" role="list">
                    {artifacts.map((a, i) =>
                        renderArtifactRow(
                            repo,
                            requestId,
                            a,
                            selectedPhase,
                            `${a.phase}-${a.kind}-${i}`,
                        ),
                    )}
                </div>
            )}
        </div>
    </section>
);
