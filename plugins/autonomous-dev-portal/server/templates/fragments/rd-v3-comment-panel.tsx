// #500 — Request Detail v3: operator comment panel for an artifact.
//
// Rendered inside the artifact pane (below the document body) for readable
// Markdown artifacts. Lets the operator:
//   - read existing comments (inline + doc-level), with resolve buttons
//   - add a doc-level comment (always-visible textarea)
//   - add an inline comment anchored to a selected text range (the form is
//     revealed by static/js/rd-artifact-comments.js when the operator selects
//     text in the rendered doc; the hidden anchor fields are populated by the
//     same script — no inline JS, CSP-safe)
//   - "Send to AI to revise" → folds unresolved comments into a feedback
//     artifact + revise marker the daemon consumes
//
// HTMX contract:
//   - the panel is wrapped in #rd-comment-panel; every mutating action POSTs
//     and swaps #rd-comment-panel via outerHTML, so the list refreshes in
//     place. The artifact body (#rd-artifact-pane) is NOT the swap target, so
//     the operator's scroll position in the doc is preserved.
//   - CSRF: the global csrf-htmx.js hook attaches X-CSRF-Token from the
//     <meta> tag to every htmx request; we also include a hidden _csrf field
//     (the enforcer's body fallback reads `_csrf`) per the gate-panel pattern.
//
// CSS lives in static/v3/request-detail.css (.rd-comments*). All classes are
// covered by the css-coverage test (#417).

import type { FC } from "hono/jsx";

import type { ArtifactComment } from "../../wiring/artifact-comments-store";

interface Props {
    repo: string;
    requestId: string;
    phase: string;
    comments: ArtifactComment[];
    csrfToken: string;
    /**
     * Whether the daemon can re-dispatch this phase (the request resolves to
     * an allowlisted repo on disk). When false the revise button still works
     * for capture but the panel warns the loop is portal-only.
     */
    canRedispatch?: boolean;
}

function fmtTime(iso: string): string {
    const ts = Date.parse(iso);
    if (Number.isNaN(ts)) return iso;
    return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * One comment row — inline (with quoted anchor) or doc-level. A plain
 * function (not an FC) so it can carry its own `key` in the `.map` below
 * without tripping Hono's FC prop typing (mirrors renderArtifactRow in
 * rd-v3-summary.tsx).
 */
function renderCommentRow(
    repo: string,
    requestId: string,
    phase: string,
    comment: ArtifactComment,
    csrfToken: string,
): JSX.Element {
    const resolveUrl = `/repo/${repo}/request/${requestId}/artifact/${phase}/comments/resolve`;
    return (
        <div
            key={comment.id}
            class={`rd-comment${comment.resolved ? " rd-comment-resolved" : ""}`}
            role="listitem"
        >
            <div class="rd-comment-meta">
                <span
                    class={`chip ${comment.anchor !== null ? "brand" : "muted"} rd-comment-kind`}
                >
                    {comment.anchor !== null ? "inline" : "doc"}
                </span>
                <span class="rd-comment-author meta-mono">{comment.author}</span>
                <span class="rd-comment-time meta-mono dim">
                    {fmtTime(comment.createdAt)}
                </span>
                {comment.resolved ? (
                    <span class="chip ok rd-comment-status">resolved</span>
                ) : null}
            </div>
            {comment.anchor !== null ? (
                <blockquote class="rd-comment-quote">
                    {comment.anchor.quote}
                </blockquote>
            ) : null}
            <p class="rd-comment-body">{comment.body}</p>
            {!comment.resolved ? (
                <div class="rd-comment-actions">
                    <input
                        type="hidden"
                        name="_csrf"
                        value={csrfToken}
                        class="rd-comment-csrf"
                    />
                    <input type="hidden" name="commentId" value={comment.id} />
                    <button
                        type="button"
                        class="btn ghost sm"
                        hx-post={resolveUrl}
                        hx-vals={`{"commentId":"${comment.id}"}`}
                        hx-include="closest .rd-comment-actions"
                        hx-target="#rd-comment-panel"
                        hx-swap="outerHTML"
                        aria-label="Mark this comment resolved"
                    >
                        Resolve
                    </button>
                </div>
            ) : null}
        </div>
    );
}

/**
 * #500 — the operator comment panel. Server-rendered; the only client JS is
 * the delegated selection helper (rd-artifact-comments.js), which is purely
 * additive (reveals the inline form + fills anchor fields). If it fails to
 * load, doc-level comments and resolve/revise still work.
 */
export const RdV3CommentPanel: FC<Props> = ({
    repo,
    requestId,
    phase,
    comments,
    csrfToken,
    canRedispatch = true,
}) => {
    const addUrl = `/repo/${repo}/request/${requestId}/artifact/${phase}/comments`;
    const reviseUrl = `/repo/${repo}/request/${requestId}/artifact/${phase}/revise`;
    const unresolved = comments.filter((c) => !c.resolved).length;

    return (
        <section
            class="rd-comments card"
            id="rd-comment-panel"
            aria-label="Operator comments on this artifact"
            data-comment-phase={phase}
        >
            <div class="card-h">
                <h3>Comments</h3>
                <span class="spacer"></span>
                <span class="meta-mono dim rd-comments-count">
                    {unresolved} open / {comments.length} total
                </span>
            </div>
            <div class="card-b rd-comments-body">
                {comments.length === 0 ? (
                    <p class="dim rd-comments-empty">
                        No comments yet. Select text in the document above to
                        leave an inline comment, or use the box below for a
                        document-level note.
                    </p>
                ) : (
                    <div class="rd-comment-list" role="list">
                        {comments.map((c) =>
                            renderCommentRow(
                                repo,
                                requestId,
                                phase,
                                c,
                                csrfToken,
                            ),
                        )}
                    </div>
                )}

                {/* Inline-comment form — hidden until the operator selects
                    text; revealed + populated by rd-artifact-comments.js. The
                    anchor fields are filled from the live selection. */}
                <form
                    class="rd-comment-form rd-comment-inline-form"
                    id="rd-comment-inline-form"
                    hidden
                    hx-post={addUrl}
                    hx-target="#rd-comment-panel"
                    hx-swap="outerHTML"
                >
                    <input type="hidden" name="_csrf" value={csrfToken} />
                    <input
                        type="hidden"
                        name="anchorQuote"
                        id="rd-comment-anchor-quote"
                        value=""
                    />
                    <input
                        type="hidden"
                        name="anchorStart"
                        id="rd-comment-anchor-start"
                        value=""
                    />
                    <input
                        type="hidden"
                        name="anchorEnd"
                        id="rd-comment-anchor-end"
                        value=""
                    />
                    <label class="rd-comment-label" for="rd-comment-inline-body">
                        Inline comment on selected text
                    </label>
                    <blockquote
                        class="rd-comment-quote rd-comment-selected-preview"
                        id="rd-comment-selected-preview"
                    ></blockquote>
                    <textarea
                        class="rd-comment-textarea"
                        name="body"
                        id="rd-comment-inline-body"
                        rows={2}
                        placeholder="// what should the AI change about this passage?"
                        aria-label="Inline comment body"
                    ></textarea>
                    <div class="rd-comment-form-actions">
                        <button type="submit" class="btn primary sm">
                            Add inline comment
                        </button>
                        <button
                            type="button"
                            class="btn ghost sm"
                            data-action="cancel-inline-comment"
                        >
                            Cancel
                        </button>
                    </div>
                </form>

                {/* Doc-level comment form — always visible. */}
                <form
                    class="rd-comment-form rd-comment-doc-form"
                    hx-post={addUrl}
                    hx-target="#rd-comment-panel"
                    hx-swap="outerHTML"
                >
                    <input type="hidden" name="_csrf" value={csrfToken} />
                    <label class="rd-comment-label" for="rd-comment-doc-body">
                        Document-level comment
                    </label>
                    <textarea
                        class="rd-comment-textarea"
                        name="body"
                        id="rd-comment-doc-body"
                        rows={2}
                        placeholder="// a comment on the whole document…"
                        aria-label="Document-level comment body"
                    ></textarea>
                    <div class="rd-comment-form-actions">
                        <button type="submit" class="btn ghost sm">
                            Add comment
                        </button>
                    </div>
                </form>

                {/* Revise hand-off. */}
                <div class="rd-comment-revise">
                    <input type="hidden" name="_csrf" value={csrfToken} id="rd-revise-csrf" />
                    <button
                        type="button"
                        class="btn primary rd-revise-btn"
                        hx-post={reviseUrl}
                        hx-include="#rd-revise-csrf"
                        hx-target="#rd-comment-panel"
                        hx-swap="outerHTML"
                        disabled={unresolved === 0}
                        aria-label="Send the open comments to the AI to revise this artifact"
                    >
                        Send {unresolved} comment{unresolved === 1 ? "" : "s"} to
                        AI to revise
                    </button>
                    {!canRedispatch ? (
                        <p class="dim rd-revise-note">
                            Comments are saved, but this request is not linked to
                            a repository the daemon manages, so it cannot
                            auto-re-run the phase.
                        </p>
                    ) : null}
                </div>
            </div>
        </section>
    );
};
