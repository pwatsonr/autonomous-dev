// #500 — operator artifact-comments store.
//
// Persists operator comments left on a rendered Markdown artifact so the
// authoring AI can address them on a re-run. Two comment shapes:
//   - inline   → anchored to a selected text range within the doc
//   - doc-level → a comment on the whole document
//
// Storage layout (canonical, daemon-readable):
//   <repoPath>/.autonomous-dev/requests/<id>/artifact-comments/<phase>.json
//
// Keyed by phase + anchor: the file is one JSON document per phase holding a
// `comments[]` array. Each comment carries a stable `id` (so resolve/dedupe
// is deterministic) and an `anchor` (null for doc-level). Writes are atomic
// (atomicWriteJson) so a concurrent reader never sees a torn file.
//
// Path resolution mirrors request-record-reader.resolveRepoPath: the repo
// slug maps to a full repo path via the daemon config's repositories.
// allowlist. When the repo path cannot be resolved (e.g. the request lives
// in the portal-only stub world, or the allowlist is missing) we fall back
// to a PORTAL store under the state dir:
//   <stateDir>/artifact-comments/<repo>__<id>/<phase>.json
// so capture + persistence still work end-to-end and the data is never
// silently dropped. The daemon hook (resolve_phase_prompt) reads the
// canonical in-repo location; the portal-store fallback is portal-only.
//
// State isolation: every path honors AUTONOMOUS_DEV_STATE_DIR /
// AUTONOMOUS_DEV_USER_CONFIG (via state-paths + readJsonOrNull), so the test
// preload (tests/setup/isolate-state-dir.ts) redirects all reads/writes into
// a temp dir — operator data is never touched.

import { basename, join } from "node:path";

import { atomicWriteJson, readJsonOrNull } from "./atomic-json";
import { stateDirRoot, userConfigPath } from "./state-paths";

/** A single operator comment on an artifact. */
export interface ArtifactComment {
    /** Stable, server-assigned id (used for resolve + dedupe). */
    id: string;
    /** Pipeline phase the artifact belongs to (e.g. "prd", "spec"). */
    phase: string;
    /**
     * Inline anchor — the selected text range. `null` for a doc-level
     * comment. `quote` is the exact selected substring (used by the daemon
     * to locate the passage); `start`/`end` are character offsets into the
     * rendered doc text (best-effort, for UI re-highlighting).
     */
    anchor: { quote: string; start: number; end: number } | null;
    /** The operator's comment body. */
    body: string;
    /** Who left it (resolved from auth context; "operator" by default). */
    author: string;
    /** ISO-8601 creation timestamp. */
    createdAt: string;
    /**
     * Resolution state. `false` while the comment is awaiting the AI; set
     * `true` either by the operator (manual dismiss) or by the daemon once
     * the author phase has addressed it.
     */
    resolved: boolean;
}

/** The on-disk per-phase document. */
export interface ArtifactCommentsFile {
    /** Schema version for forward-compat. */
    v: 1;
    /** Request id (mirrored for debuggability / daemon reads). */
    id: string;
    /** Repo slug. */
    repo: string;
    /** Pipeline phase. */
    phase: string;
    /** The comments, in insertion order. */
    comments: ArtifactComment[];
    /** ISO-8601 timestamp of the last write. */
    updatedAt: string;
}

/** Input for adding a comment (id + timestamps are server-assigned). */
export interface AddCommentInput {
    repo: string;
    id: string;
    phase: string;
    body: string;
    author: string;
    /** Inline anchor, or null/undefined for a doc-level comment. */
    anchor?: ArtifactComment["anchor"];
}

/** Phase keys must match the route regex (defense-in-depth on the filename). */
const PHASE_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const REQ_ID_RE = /^REQ-[0-9]{6}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Cap a single comment body so a paste-bomb can't blow up the store. */
const MAX_BODY = 4096;
/** Cap the anchor quote length. */
const MAX_QUOTE = 2048;
/** Hard cap on comments per phase (defensive; UI shows all). */
const MAX_COMMENTS = 500;

interface DaemonConfigFile {
    repositories?: {
        allowlist?: Array<string | { id?: string; path?: string }>;
    };
}

/**
 * Resolve a repo slug → full repo path via the daemon config allowlist.
 * Tolerates both the string-entry and {id?,path?} object forms (same logic
 * as request-record-reader.resolveRepoPath). Returns null when the repo is
 * not allowlisted or the config is missing.
 */
async function resolveRepoPath(repoSlug: string): Promise<string | null> {
    const config = await readJsonOrNull<DaemonConfigFile>(userConfigPath());
    const allowlist = config?.repositories?.allowlist;
    if (!Array.isArray(allowlist)) return null;
    for (const entry of allowlist) {
        const p = typeof entry === "string" ? entry : entry?.path;
        if (typeof p === "string" && basename(p) === repoSlug) return p;
    }
    return null;
}

/**
 * Canonical (in-repo) comments file path for a resolvable repo, or the
 * portal-store fallback path otherwise. Exported for the daemon-hand-off
 * documentation + tests so the exact location is unambiguous.
 */
export async function commentsFilePath(
    repo: string,
    id: string,
    phase: string,
): Promise<{ path: string; canonical: boolean }> {
    const repoPath = await resolveRepoPath(repo);
    if (repoPath !== null) {
        return {
            path: join(
                repoPath,
                ".autonomous-dev",
                "requests",
                id,
                "artifact-comments",
                `${phase}.json`,
            ),
            canonical: true,
        };
    }
    // Portal-store fallback (portal-only; daemon does not read this).
    return {
        path: join(
            stateDirRoot(),
            "artifact-comments",
            `${repo}__${id}`,
            `${phase}.json`,
        ),
        canonical: false,
    };
}

function validateKeys(repo: string, id: string, phase: string): void {
    if (!REPO_RE.test(repo)) throw new Error("invalid-repo");
    if (!REQ_ID_RE.test(id)) throw new Error("invalid-id");
    if (!PHASE_RE.test(phase)) throw new Error("invalid-phase");
}

/** Generate a short, stable, collision-resistant comment id. */
function newCommentId(): string {
    // crypto.randomUUID is available in Bun + Node ≥ 16.
    return `cmt-${crypto.randomUUID()}`;
}

/**
 * Read the comments for a single phase. Returns an empty (but well-formed)
 * file when nothing has been written yet. Corrupt files surface as an empty
 * list rather than throwing (graceful degradation — the UI must still load).
 */
export async function readArtifactComments(
    repo: string,
    id: string,
    phase: string,
): Promise<ArtifactCommentsFile> {
    validateKeys(repo, id, phase);
    const { path } = await commentsFilePath(repo, id, phase);
    let parsed: ArtifactCommentsFile | null = null;
    try {
        parsed = await readJsonOrNull<ArtifactCommentsFile>(path);
    } catch {
        parsed = null; // corrupt JSON → treat as empty
    }
    if (parsed === null || !Array.isArray(parsed.comments)) {
        return {
            v: 1,
            id,
            repo,
            phase,
            comments: [],
            updatedAt: new Date().toISOString(),
        };
    }
    return parsed;
}

/**
 * Append a comment to a phase's file and persist atomically. Returns the
 * created comment plus the updated file.
 */
export async function addArtifactComment(
    input: AddCommentInput,
): Promise<{ comment: ArtifactComment; file: ArtifactCommentsFile }> {
    validateKeys(input.repo, input.id, input.phase);

    const body = input.body.trim();
    if (body.length === 0) throw new Error("empty-body");
    if (body.length > MAX_BODY) throw new Error("body-too-long");

    let anchor: ArtifactComment["anchor"] = null;
    if (input.anchor !== undefined && input.anchor !== null) {
        const quote = String(input.anchor.quote ?? "").slice(0, MAX_QUOTE);
        if (quote.length === 0) {
            // An inline comment with no quote is meaningless; treat as
            // doc-level rather than rejecting (fail open for the operator).
            anchor = null;
        } else {
            const start = Number.isFinite(input.anchor.start)
                ? Math.max(0, Math.trunc(input.anchor.start))
                : 0;
            const end = Number.isFinite(input.anchor.end)
                ? Math.max(start, Math.trunc(input.anchor.end))
                : start + quote.length;
            anchor = { quote, start, end };
        }
    }

    const file = await readArtifactComments(input.repo, input.id, input.phase);
    if (file.comments.length >= MAX_COMMENTS) {
        throw new Error("too-many-comments");
    }

    const comment: ArtifactComment = {
        id: newCommentId(),
        phase: input.phase,
        anchor,
        body,
        author: input.author,
        createdAt: new Date().toISOString(),
        resolved: false,
    };
    file.comments.push(comment);
    file.updatedAt = comment.createdAt;
    file.id = input.id;
    file.repo = input.repo;
    file.phase = input.phase;
    file.v = 1;

    const { path } = await commentsFilePath(input.repo, input.id, input.phase);
    await atomicWriteJson(path, file);
    return { comment, file };
}

/**
 * Mark a single comment resolved (or unresolved). Returns the updated file.
 * No-op (returns the file unchanged) when the id is not found.
 */
export async function resolveArtifactComment(
    repo: string,
    id: string,
    phase: string,
    commentId: string,
    resolved = true,
): Promise<ArtifactCommentsFile> {
    validateKeys(repo, id, phase);
    const file = await readArtifactComments(repo, id, phase);
    let changed = false;
    for (const c of file.comments) {
        if (c.id === commentId && c.resolved !== resolved) {
            c.resolved = resolved;
            changed = true;
        }
    }
    if (changed) {
        file.updatedAt = new Date().toISOString();
        const { path } = await commentsFilePath(repo, id, phase);
        await atomicWriteJson(path, file);
    }
    return file;
}

/** Count of unresolved comments in a file (used for the revise affordance). */
export function unresolvedCount(file: ArtifactCommentsFile): number {
    return file.comments.filter((c) => !c.resolved).length;
}

/** Exported for tests. */
export const __test__ = {
    PHASE_RE,
    REQ_ID_RE,
    REPO_RE,
    MAX_BODY,
    MAX_COMMENTS,
    resolveRepoPath,
};
