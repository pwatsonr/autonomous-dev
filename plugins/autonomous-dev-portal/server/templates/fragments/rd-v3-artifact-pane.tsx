// FR-026-21 — Request Detail v3: artifact pane.
//
// The artifact pane is the left column of the `.rdetail` grid.  It is also
// the HTMX swap target (`id="rd-artifact-pane"`) so phase-track button
// clicks replace this element in-place (outerHTML swap).
//
// Three render branches:
//   - pending   → "Phase pending" card with muted prose
//   - prd       → PRD markdown card via `.artifact` prose renderer
//   - spec      → Spec card (heading/prose/code blocks) via `.artifact`
//   - code/diff → DiffViewer card
//   - generic   → Generic artifact card with muted "phase artifact" body
//
// The `format` field on the artifact drives which body renderer applies:
//   "markdown" → .artifact prose (renderMarkdown)
//   "diff"     → RdV3DiffViewer (parses unified diff into .ln rows)
//   "text"     → <pre> with HTML-escaped content
//
// CSS classes consumed from app.css:
//   .card, .card-h, .card-b, .artifact, .chip.ok, .chip.brand,
//   .dot.live, .meta, .spacer
//
// HTMX contract: this element MUST carry id="rd-artifact-pane" so the
// phase-track's hx-target="#rd-artifact-pane" resolves correctly.

import type { FC } from "hono/jsx";

import { escapeHtml, renderMarkdown } from "../../lib/markdown";
import type { RequestArtifact } from "../../types/render";
import type { DiffFile } from "./rd-v3-diff-viewer";
import { RdV3DiffViewer } from "./rd-v3-diff-viewer";

interface Props {
    /** Phase key (e.g. "prd", "spec", "code"). Used for the card heading. */
    phase: string;
    /** State of the phase. "pending" renders the placeholder card. */
    state: "done" | "now" | "pending";
    /** Artifact data when state !== "pending". */
    artifact?: RequestArtifact;
    /** Branch name — needed by DiffViewer header. */
    branch: string;
    /** Agent name displayed in the card header meta. */
    agent: string;
    /** Duration string displayed in the card header meta. */
    dur: string;
    /** Cost for this phase displayed in the card header meta. */
    cost: string;
    /** Duration for the active (now) phase displayed as "running X". */
    activeLabel?: string;
    /**
     * #500 — repo slug + request id. When both are present AND the artifact
     * is a readable Markdown doc, the pane appends a lazily-loaded operator
     * comment panel (select-text → inline comment, doc-level box, revise).
     * The panel HTML is fetched by HTMX on load from the comments endpoint
     * so the pane renderer stays a pure function of the artifact.
     */
    repo?: string;
    requestId?: string;
}

/**
 * #500 — lazy-loaded comment panel mount. Renders an empty container that
 * HTMX fills from the comments endpoint on load (hx-trigger="load"). Kept
 * separate so the pane renderer does not need the comments or the CSRF token
 * — both live on the full page already and the fragment fetch carries the
 * global CSRF header via csrf-htmx.js.
 *
 * Only rendered for readable Markdown artifacts (the only thing worth
 * commenting on inline); diff/text/pending panes omit it.
 */
const CommentPanelMount: FC<{ repo: string; requestId: string; phase: string }> = ({
    repo,
    requestId,
    phase,
}) => (
    <div
        class="rd-comment-mount"
        hx-get={`/repo/${repo}/request/${requestId}/artifact/${phase}/comments`}
        hx-trigger="load"
        hx-swap="innerHTML"
    >
        <p class="dim rd-comment-loading">Loading comments…</p>
    </div>
);

const PendingCard: FC<{ phase: string }> = ({ phase }) => (
    <div class="card" id="rd-artifact-pane">
        <div class="card-h">
            <h3>{phase.toUpperCase()} &middot; pending</h3>
        </div>
        <div class="card-b">
            <p class="dim mono rd-pending-msg">
                This phase has not started. It will be triggered when upstream
                phases settle.
            </p>
        </div>
    </div>
);

const MarkdownBody: FC<{ content: string }> = ({ content }) => (
    <div
        class="artifact"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    ></div>
);

const TextBody: FC<{ content: string }> = ({ content }) => (
    <pre class="artifact">{content}</pre>
);

/**
 * FR-026-21 — Artifact pane HTMX swap target.
 *
 * Rendered as the initial page load state AND as the replacement fragment
 * returned by the artifact endpoint (hx-swap="outerHTML" replaces this
 * element in place).
 *
 * @param props - {@link Props}
 */
export const RdV3ArtifactPane: FC<Props> = ({
    phase,
    state,
    artifact,
    branch,
    agent,
    dur,
    cost,
    activeLabel,
    repo,
    requestId,
}) => {
    const phaseLabel = phase.toUpperCase();

    // #500 — the comment panel attaches to readable Markdown artifacts only,
    // and only when the pane was given the repo + request id (the full page
    // and the fragment endpoint both pass them; legacy callers that omit them
    // simply get no comment panel — fail safe).
    const showComments =
        repo !== undefined &&
        repo !== "" &&
        requestId !== undefined &&
        requestId !== "" &&
        artifact !== undefined &&
        artifact.format === "markdown";

    if (state === "pending") {
        return <PendingCard phase={phase} />;
    }

    // Determine the status chip
    const isActive = state === "now";
    const statusChip = isActive ? (
        <span class="chip brand">
            <span class="dot live" aria-hidden="true"></span>
            Active
        </span>
    ) : (
        <span class="chip ok">passed</span>
    );

    // Meta string
    const metaParts: string[] = [];
    if (agent !== "") metaParts.push(agent);
    if (isActive && activeLabel !== undefined && activeLabel !== "") {
        metaParts.push(`running ${activeLabel}`);
    } else if (dur !== "") {
        metaParts.push(dur);
    }
    if (cost !== "" && cost !== "$0.00") metaParts.push(cost);
    const metaText = metaParts.join(" &middot; ");

    // Diff format: delegate to RdV3DiffViewer
    if (artifact !== undefined && artifact.format === "diff") {
        // Parse the unified diff content into DiffFile array for the viewer.
        // If the artifact has an artifactId we surface it; otherwise use phase.
        const diffFiles: DiffFile[] = parseUnifiedDiff(
            artifact.content,
            artifact.phase,
        );
        return (
            <div id="rd-artifact-pane" class="rd-artifact-pane-wrap">
                <div class="card rd-artifact-card">
                    <div class="card-h">
                        <h3>{phaseLabel}</h3>
                        <span
                            class="meta"
                            dangerouslySetInnerHTML={{ __html: metaText }}
                        ></span>
                        <span class="spacer"></span>
                        {statusChip}
                    </div>
                    <div class="card-b">
                        <RdV3DiffViewer branch={branch} files={diffFiles} />
                    </div>
                </div>
            </div>
        );
    }

    // Markdown or text format
    return (
        <div id="rd-artifact-pane" class="rd-artifact-pane-wrap">
            <div class="card rd-artifact-card">
                <div class="card-h">
                    <h3>
                        {phaseLabel}
                        {artifact?.artifactId !== undefined &&
                        artifact.artifactId !== "" ? (
                            <>
                                {" "}
                                &middot;{" "}
                                <span class="meta-mono dim">
                                    {artifact.artifactId}
                                </span>
                            </>
                        ) : null}
                    </h3>
                    <span
                        class="meta"
                        dangerouslySetInnerHTML={{ __html: metaText }}
                    ></span>
                    <span class="spacer"></span>
                    {statusChip}
                </div>
                <div class="card-b">
                    {artifact === undefined ? (
                        <p class="dim meta-mono rd-pending-msg">
                            No artifact available for this phase yet.
                        </p>
                    ) : artifact.format === "markdown" ? (
                        <MarkdownBody content={artifact.content} />
                    ) : (
                        <TextBody content={artifact.content} />
                    )}
                </div>
            </div>
            {showComments ? (
                <CommentPanelMount
                    repo={repo!}
                    requestId={requestId!}
                    phase={phase}
                />
            ) : null}
        </div>
    );
};

/**
 * Parse a unified diff body into DiffFile records for the diff viewer.
 *
 * Handles the `--- a/...` / `+++ b/...` file headers to split multiple
 * files. Falls back to a single file named after the phase when headers
 * are absent.
 *
 * @param content - raw unified diff text
 * @param fallbackName - file name used when no `--- a/` header is found
 * @returns parsed DiffFile array
 */
function parseUnifiedDiff(content: string, fallbackName: string): DiffFile[] {
    const files: DiffFile[] = [];
    const lines = content.split("\n");

    let currentFile: string | null = null;
    let bodyLines: string[] = [];
    let adds = 0;
    let dels = 0;

    function flush(): void {
        if (currentFile !== null && bodyLines.length > 0) {
            files.push({
                file: currentFile,
                adds,
                dels,
                body: bodyLines.join("\n"),
            });
        }
    }

    for (const line of lines) {
        if (line.startsWith("--- ")) {
            // Start of a new file
            flush();
            currentFile =
                line.slice(4).replace(/^[ab]\//, "") || fallbackName;
            bodyLines = [];
            adds = 0;
            dels = 0;
            continue;
        }
        if (line.startsWith("+++ ")) {
            // Skip the +++ header
            continue;
        }
        if (currentFile === null) {
            // No --- header seen yet; treat whole content as one file
            currentFile = fallbackName;
        }
        if (line.startsWith("+") && !line.startsWith("+++")) adds++;
        if (line.startsWith("-") && !line.startsWith("---")) dels++;
        bodyLines.push(line);
    }
    flush();

    if (files.length === 0) {
        // Fallback: no file headers found, wrap the whole content
        const a = content.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
        const d = content.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).length;
        files.push({ file: fallbackName, adds: a, dels: d, body: content });
    }

    return files;
}

/**
 * Exported variant used by the HTMX artifact fragment endpoint.
 *
 * The endpoint handler calls `renderFragment` which needs to call this view.
 * The wrapper `id="rd-artifact-pane"` on the outer element must match the
 * hx-target in the phase track buttons.
 */
export { parseUnifiedDiff };
