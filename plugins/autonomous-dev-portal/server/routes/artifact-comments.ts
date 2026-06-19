// #500 — operator artifact-comment routes (capture + persist + revise).
//
// Built on the #499 artifact viewer. Five endpoints back the comment panel
// rendered inside the artifact pane:
//
//   GET  /repo/:repo/request/:id/artifact/:phase/comments          (fragment)
//   POST /repo/:repo/request/:id/artifact/:phase/comments          (add)
//   POST /repo/:repo/request/:id/artifact/:phase/comments/resolve  (resolve)
//   POST /repo/:repo/request/:id/artifact/:phase/revise            (hand-off)
//
// Contract notes (consistent with the existing action routes):
//   - CSRF is enforced by the GLOBAL middleware (PR #312 / csrf-htmx.js). This
//     router does NOT add a second guard. The mutating endpoints accept either
//     form-encoded (the HTMX forms) or JSON bodies.
//   - Path params are validated with strict regexes BEFORE any store call; a
//     mismatch is a 404 (probe-resistant), matching request-detail.ts.
//   - The router is deps-injected (store fns + audit + bus + logger) so tests
//     stub the filesystem without touching real operator state. When omitted
//     from registerRoutes, the paths return 503 (visible gap, no silent 404).
//   - All mutating responses return the re-rendered #rd-comment-panel fragment
//     (outerHTML swap target) so the list refreshes in place.

import { Hono } from "hono";
import { jsx } from "hono/jsx";

import type {
    ActionLogger,
    AuditAppender,
    SSEBroadcaster,
} from "./_action-deps";
import {
    noopActionLogger,
    noopBroadcaster,
    resolveActor,
} from "./_action-deps";
import { RdV3CommentPanel } from "../templates/fragments/rd-v3-comment-panel";
import type {
    AddCommentInput,
    ArtifactComment,
    ArtifactCommentsFile,
} from "../wiring/artifact-comments-store";
import {
    addArtifactComment,
    commentsFilePath,
    readArtifactComments,
    resolveArtifactComment,
} from "../wiring/artifact-comments-store";
import type {
    ReviseInput,
    ReviseResult,
} from "../wiring/artifact-revise-store";
import { writeReviseRequest } from "../wiring/artifact-revise-store";

const REPO_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQ_ID_RE = /^REQ-[0-9]{6}$/;
const PHASE_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Store surface the routes depend on (injectable for tests). */
export interface ArtifactCommentDeps {
    readComments: (
        repo: string,
        id: string,
        phase: string,
    ) => Promise<ArtifactCommentsFile>;
    addComment: (
        input: AddCommentInput,
    ) => Promise<{ comment: ArtifactComment; file: ArtifactCommentsFile }>;
    resolveComment: (
        repo: string,
        id: string,
        phase: string,
        commentId: string,
    ) => Promise<ArtifactCommentsFile>;
    writeRevise: (input: ReviseInput) => Promise<ReviseResult>;
    /**
     * Whether the daemon can re-dispatch this phase (the request resolves to
     * an allowlisted repo on disk). Drives the panel's "portal-only" note.
     * Defaults to a probe of commentsFilePath().canonical.
     */
    canRedispatch?: (repo: string, id: string, phase: string) => Promise<boolean>;
    audit: AuditAppender;
    bus?: SSEBroadcaster;
    logger?: ActionLogger;
}

/** Production deps — the real filesystem-backed stores. */
export function defaultArtifactCommentStore(): Omit<
    ArtifactCommentDeps,
    "audit" | "bus" | "logger"
> {
    return {
        readComments: readArtifactComments,
        addComment: addArtifactComment,
        resolveComment: (repo, id, phase, commentId) =>
            resolveArtifactComment(repo, id, phase, commentId, true),
        writeRevise: writeReviseRequest,
        canRedispatch: async (repo, id, phase) => {
            const { canonical } = await commentsFilePath(repo, id, phase);
            return canonical;
        },
    };
}

interface AddBody {
    body?: unknown;
    anchorQuote?: unknown;
    anchorStart?: unknown;
    anchorEnd?: unknown;
}

interface ResolveBody {
    commentId?: unknown;
}

/**
 * Parse a request body as form-encoded or JSON. We branch on Content-Type
 * BEFORE reading the stream: reading `c.req.json()` on a urlencoded body
 * consumes the stream so the formData fallback then sees an empty body (the
 * HTMX forms are urlencoded, so that path is the common one). Anything that
 * isn't explicitly JSON is treated as form data.
 */
async function parseBody(
    c: import("hono").Context,
): Promise<Record<string, unknown>> {
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    if (ct.includes("application/json")) {
        try {
            return (await c.req.json()) as Record<string, unknown>;
        } catch {
            return {};
        }
    }
    try {
        const form = await c.req.formData();
        const out: Record<string, unknown> = {};
        for (const [k, v] of form.entries()) {
            if (typeof v === "string") out[k] = v;
        }
        return out;
    } catch {
        return {};
    }
}

/** Render the #rd-comment-panel fragment to an HTML string. */
async function renderPanel(
    repo: string,
    id: string,
    phase: string,
    file: ArtifactCommentsFile,
    csrfToken: string,
    canRedispatch: boolean,
): Promise<string> {
    const element = jsx(RdV3CommentPanel, {
        repo,
        requestId: id,
        phase,
        comments: file.comments,
        csrfToken,
        canRedispatch,
    });
    return String(await Promise.resolve(element));
}

/**
 * Build the artifact-comment sub-router. Mounted as a sibling of the other
 * request-detail action routes.
 */
export function buildArtifactCommentRoutes(deps: ArtifactCommentDeps): Hono {
    const bus = deps.bus ?? noopBroadcaster();
    const logger = deps.logger ?? noopActionLogger();
    const router = new Hono();

    const validateParams = (
        c: import("hono").Context,
    ): { repo: string; id: string; phase: string } | null => {
        const repo = c.req.param("repo");
        const id = c.req.param("id");
        const phase = c.req.param("phase");
        if (typeof repo !== "string" || !REPO_RE.test(repo)) return null;
        if (typeof id !== "string" || !REQ_ID_RE.test(id)) return null;
        if (typeof phase !== "string" || !PHASE_RE.test(phase)) return null;
        return { repo, id, phase };
    };

    const probeRedispatch = async (
        repo: string,
        id: string,
        phase: string,
    ): Promise<boolean> => {
        if (deps.canRedispatch === undefined) return true;
        try {
            return await deps.canRedispatch(repo, id, phase);
        } catch {
            return true;
        }
    };

    // GET — render the panel fragment (used on initial pane render + refresh).
    router.get(
        "/repo/:repo/request/:id/artifact/:phase/comments",
        async (c) => {
            const p = validateParams(c);
            if (p === null) return c.notFound();
            const file = await deps.readComments(p.repo, p.id, p.phase);
            const csrf = (c.get("csrfToken") as string | undefined) ?? "";
            const canRe = await probeRedispatch(p.repo, p.id, p.phase);
            c.header("Cache-Control", "no-store");
            return c.html(
                await renderPanel(p.repo, p.id, p.phase, file, csrf, canRe),
            );
        },
    );

    // POST — add a comment (inline when anchorQuote present, else doc-level).
    router.post(
        "/repo/:repo/request/:id/artifact/:phase/comments",
        async (c) => {
            const p = validateParams(c);
            if (p === null) return c.notFound();
            const raw = (await parseBody(c)) as AddBody;
            const body = typeof raw.body === "string" ? raw.body : "";
            if (body.trim().length === 0) {
                return c.json({ error: "missing-body" }, 400);
            }

            let anchor: ArtifactComment["anchor"] = null;
            const quote =
                typeof raw.anchorQuote === "string" ? raw.anchorQuote : "";
            if (quote.trim().length > 0) {
                const start = Number.parseInt(String(raw.anchorStart ?? ""), 10);
                const end = Number.parseInt(String(raw.anchorEnd ?? ""), 10);
                anchor = {
                    quote,
                    start: Number.isFinite(start) ? start : 0,
                    end: Number.isFinite(end) ? end : quote.length,
                };
            }

            const actor = resolveActor(c.get("auth"));
            let file: ArtifactCommentsFile;
            try {
                const res = await deps.addComment({
                    repo: p.repo,
                    id: p.id,
                    phase: p.phase,
                    body,
                    author: actor,
                    anchor,
                });
                file = res.file;
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                // Map known validation errors to 400; everything else 500.
                if (
                    msg === "empty-body" ||
                    msg === "body-too-long" ||
                    msg === "too-many-comments" ||
                    msg.startsWith("invalid-")
                ) {
                    return c.json({ error: msg }, 400);
                }
                logger.error("artifact_comment_add_failed", {
                    repo: p.repo,
                    id: p.id,
                    phase: p.phase,
                    error: msg,
                });
                return c.json({ error: "internal" }, 500);
            }

            await deps.audit.append({
                event: "artifact_comment_added",
                repo: p.repo,
                id: p.id,
                phase: p.phase,
                actor,
                inline: anchor !== null,
            });
            bus.publish("artifact-comment", {
                repo: p.repo,
                id: p.id,
                phase: p.phase,
            });
            const csrf = (c.get("csrfToken") as string | undefined) ?? "";
            const canRe = await probeRedispatch(p.repo, p.id, p.phase);
            c.header("Cache-Control", "no-store");
            return c.html(
                await renderPanel(p.repo, p.id, p.phase, file, csrf, canRe),
            );
        },
    );

    // POST — resolve a comment.
    router.post(
        "/repo/:repo/request/:id/artifact/:phase/comments/resolve",
        async (c) => {
            const p = validateParams(c);
            if (p === null) return c.notFound();
            const raw = (await parseBody(c)) as ResolveBody;
            const commentId =
                typeof raw.commentId === "string" ? raw.commentId : "";
            if (commentId.length === 0) {
                return c.json({ error: "missing-comment-id" }, 400);
            }
            const actor = resolveActor(c.get("auth"));
            let file: ArtifactCommentsFile;
            try {
                file = await deps.resolveComment(
                    p.repo,
                    p.id,
                    p.phase,
                    commentId,
                );
            } catch (err) {
                logger.error("artifact_comment_resolve_failed", {
                    repo: p.repo,
                    id: p.id,
                    phase: p.phase,
                    error: err instanceof Error ? err.message : String(err),
                });
                return c.json({ error: "internal" }, 500);
            }
            await deps.audit.append({
                event: "artifact_comment_resolved",
                repo: p.repo,
                id: p.id,
                phase: p.phase,
                actor,
                commentId,
            });
            const csrf = (c.get("csrfToken") as string | undefined) ?? "";
            const canRe = await probeRedispatch(p.repo, p.id, p.phase);
            c.header("Cache-Control", "no-store");
            return c.html(
                await renderPanel(p.repo, p.id, p.phase, file, csrf, canRe),
            );
        },
    );

    // POST — revise: fold unresolved comments into a feedback artifact +
    // revise marker the daemon consumes, then re-render the (now-empty) panel.
    router.post(
        "/repo/:repo/request/:id/artifact/:phase/revise",
        async (c) => {
            const p = validateParams(c);
            if (p === null) return c.notFound();
            const actor = resolveActor(c.get("auth"));
            let result: ReviseResult;
            try {
                result = await deps.writeRevise({
                    repo: p.repo,
                    id: p.id,
                    phase: p.phase,
                    actor,
                });
            } catch (err) {
                logger.error("artifact_revise_failed", {
                    repo: p.repo,
                    id: p.id,
                    phase: p.phase,
                    error: err instanceof Error ? err.message : String(err),
                });
                return c.json({ error: "internal" }, 500);
            }
            if (!result.ok) {
                if (result.reason === "no-comments") {
                    return c.json({ error: "no-open-comments" }, 409);
                }
                if (result.reason === "invalid") {
                    return c.json({ error: result.message }, 400);
                }
                logger.error("artifact_revise_failed", {
                    repo: p.repo,
                    id: p.id,
                    phase: p.phase,
                    reason: result.reason,
                });
                return c.json({ error: "internal" }, 500);
            }
            await deps.audit.append({
                event: "artifact_revise_requested",
                repo: p.repo,
                id: p.id,
                phase: p.phase,
                actor,
                comments: result.count,
                wired: result.wired,
            });
            bus.publish("artifact-revise", {
                repo: p.repo,
                id: p.id,
                phase: p.phase,
            });
            // Re-render the panel; revise marked the folded comments resolved,
            // so the list now shows them under "resolved".
            const file = await deps.readComments(p.repo, p.id, p.phase);
            const csrf = (c.get("csrfToken") as string | undefined) ?? "";
            c.header("Cache-Control", "no-store");
            return c.html(
                await renderPanel(
                    p.repo,
                    p.id,
                    p.phase,
                    file,
                    csrf,
                    result.wired,
                ),
            );
        },
    );

    return router;
}

/** Exported for tests. */
export const __test__ = {
    REPO_RE,
    REQ_ID_RE,
    PHASE_RE,
};
