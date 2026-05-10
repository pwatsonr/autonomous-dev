// SPEC-036-3-02 §Artifact pane (v1.1) — persistent inline reading surface.
//
// Always rendered as part of Request Detail (NOT a modal). Three render
// branches by `format`:
//   - "diff"     → <pre> with per-line tinted spans (+ ok / - err / @@ info)
//   - "markdown" → rendered prose via lib/markdown.ts
//   - "text"     → plain <pre> with HTML-escaped content
//
// Section head shows `Artifact · ${PHASE}` with the optional artifactId in
// `meta-mono dim` to its right. When `artifact` is undefined the pane
// renders muted "No artifact available for this phase" copy so the region
// stays visually anchored even on phases without a current artifact.

import type { FC } from "hono/jsx";

import { escapeHtml, renderMarkdown } from "../../lib/markdown";
import type { RequestArtifact } from "../../types/render";

interface Props {
    /** Current phase; used to label the section head when `artifact` is unset. */
    phase: string;
    /** SSE OOB swap target id — `request-${id}-artifact`. */
    targetId: string;
    /** When undefined, the pane renders the empty state. */
    artifact?: RequestArtifact;
}

/** Per-line classifier for unified-diff content. Server-side, pure. */
function diffLineClass(line: string): string {
    if (line.startsWith("+")) return "diff-add";
    if (line.startsWith("-")) return "diff-del";
    if (line.startsWith("@@")) return "diff-hunk";
    return "";
}

const DiffBody: FC<{ content: string }> = ({ content }) => {
    // Each line gets its own <span> wrapper so CSS `.diff-add`/`.diff-del`/
    // `.diff-hunk` can apply the per-line tint background.
    const lines = content.split("\n");
    const html = lines
        .map((line) => {
            const cls = diffLineClass(line);
            const escaped = escapeHtml(line);
            const safeCls = cls === "" ? "" : ` class="${cls}"`;
            return `<span${safeCls}>${escaped}</span>`;
        })
        .join("\n");
    return (
        <pre
            class="artifact-pre artifact-diff"
            dangerouslySetInnerHTML={{ __html: html }}
        ></pre>
    );
};

const MarkdownBody: FC<{ content: string }> = ({ content }) => (
    <div
        class="artifact-prose"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
    ></div>
);

const TextBody: FC<{ content: string }> = ({ content }) => (
    <pre class="artifact-pre">{content}</pre>
);

export const ArtifactPane: FC<Props> = ({ phase, targetId, artifact }) => {
    const phaseLabel = (artifact?.phase ?? phase).toUpperCase();
    return (
        <section class="sec artifact-pane" id={targetId}>
            <div class="sec-head">
                <h2>Artifact · {phaseLabel}</h2>
                {artifact?.artifactId !== undefined ? (
                    <span class="meta-mono dim">{artifact.artifactId}</span>
                ) : null}
            </div>
            {artifact === undefined ? (
                <div class="artifact-empty meta-mono dim">
                    No artifact available for this phase
                </div>
            ) : artifact.format === "diff" ? (
                <DiffBody content={artifact.content} />
            ) : artifact.format === "markdown" ? (
                <MarkdownBody content={artifact.content} />
            ) : (
                <TextBody content={artifact.content} />
            )}
        </section>
    );
};
