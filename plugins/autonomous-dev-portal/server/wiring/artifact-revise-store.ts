// #500 — "revise" hand-off writer.
//
// When the operator clicks "Send to AI to revise" on an artifact, the portal
// must (a) hand the unresolved comments to the authoring AI as feedback and
// (b) ask the daemon to re-run that phase's author.
//
// We mirror the established daemon-mediated marker pattern (gate-decision,
// request-action, config-change, verification-override): the portal NEVER
// mutates daemon state directly — it writes a marker the daemon picks up on
// its next reconcile iteration and validates before acting.
//
// Two files are written:
//
//   1. FEEDBACK ARTIFACT (canonical, in-repo, daemon-consumed by
//      resolve_phase_prompt):
//        <repoPath>/.autonomous-dev/requests/<id>/artifact-feedback/<phase>.json
//      Shape (the daemon hook reads `.feedback` — a ready-to-inject prompt
//      block — and `.comments[]` for structured access):
//        { v, id, repo, phase, requestedBy, requestedAt,
//          feedback: "<markdown block>", comments: [ {anchor, body}... ] }
//
//   2. REVISE MARKER (daemon reconcile target):
//        <stateDir>/revise-requests/<repo>__<id>.json
//      Shape:
//        { v, id, repo, phase, source:"portal", actor, ts }
//      The daemon's consume_revise_markers() validates source=="portal",
//      confirms the request is non-terminal and the feedback artifact exists,
//      then resets state.json.current_phase to <phase> (the author phase) so
//      the supervisor re-dispatches it — exactly the review-gate loopback
//      mechanism (supervisor-loop.sh resets current_phase to ${phase%_review}
//      on a *_review fail). The author re-run then injects the feedback.
//
// If the repo path cannot be resolved (portal-only stub world), the feedback
// artifact is written to the portal-store fallback and the marker records
// `canonical:false` so the daemon skips it (it cannot reset a phase for a
// request it does not own). Capture/persist still succeed; only the live
// re-dispatch is unavailable — surfaced honestly to the caller.

import { join } from "node:path";

import { atomicWriteJson } from "./atomic-json";
import {
    commentsFilePath,
    readArtifactComments,
    type ArtifactComment,
} from "./artifact-comments-store";
import { stateDirRoot } from "./state-paths";

export interface ReviseInput {
    repo: string;
    id: string;
    phase: string;
    actor: string;
}

export type ReviseResult =
    | {
          ok: true;
          /** Number of unresolved comments folded into the feedback. */
          count: number;
          /**
           * True when the feedback artifact + marker landed in the canonical
           * in-repo location the daemon reads. False when only the portal
           * fallback was written (daemon will NOT re-dispatch).
           */
          wired: boolean;
          /** Absolute path of the feedback artifact (for audit / tests). */
          feedbackPath: string;
      }
    | { ok: false; reason: "no-comments" }
    | { ok: false; reason: "invalid"; message: string }
    | { ok: false; reason: "internal"; message?: string };

const REQ_ID_RE = /^REQ-[0-9]{6}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,128}$/;
const PHASE_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/** Build the human/AI-facing feedback block from unresolved comments. */
export function buildFeedbackBlock(
    phase: string,
    comments: ArtifactComment[],
): string {
    const lines: string[] = [];
    lines.push(
        `The operator reviewed the ${phase.toUpperCase()} artifact and left ` +
            `${comments.length} comment${comments.length === 1 ? "" : "s"} that you MUST address in this revision.`,
    );
    lines.push("");
    comments.forEach((c, i) => {
        if (c.anchor !== null && c.anchor.quote.length > 0) {
            lines.push(`${i + 1}. On the passage:`);
            // Quote the anchored text so the author can locate it exactly.
            for (const q of c.anchor.quote.split("\n")) {
                lines.push(`   > ${q}`);
            }
            lines.push(`   Comment: ${c.body}`);
        } else {
            lines.push(`${i + 1}. (Document-level) ${c.body}`);
        }
        lines.push("");
    });
    lines.push(
        "Revise the artifact to resolve every comment above, then re-emit the " +
            "phase-result envelope as usual. Do not remove content the operator " +
            "did not ask you to change.",
    );
    return lines.join("\n").trim();
}

/** Feedback artifact path — canonical (in-repo) when resolvable. */
async function feedbackArtifactPath(
    repo: string,
    id: string,
    phase: string,
): Promise<{ path: string; canonical: boolean }> {
    // Reuse the comments-store resolution so both files live in the same
    // request directory and share canonical/fallback semantics.
    const { path: commentsPath, canonical } = await commentsFilePath(
        repo,
        id,
        phase,
    );
    // commentsPath ends in .../artifact-comments/<phase>.json — swap the dir.
    const dir = canonical
        ? commentsPath.replace(
              `${join("artifact-comments", `${phase}.json`)}`,
              join("artifact-feedback", `${phase}.json`),
          )
        : commentsPath.replace(
              join("artifact-comments"),
              join("artifact-feedback"),
          );
    return { path: dir, canonical };
}

/** Revise-marker path (daemon reconcile target), under the state dir. */
export function reviseMarkerPath(repo: string, id: string): string {
    return join(stateDirRoot(), "revise-requests", `${repo}__${id}.json`);
}

/**
 * Write the feedback artifact + revise marker. Folds all UNRESOLVED comments
 * for the phase into the feedback block and marks them resolved (so the next
 * revise only carries new comments). Idempotent-ish: a second call with no
 * new unresolved comments returns `no-comments`.
 */
export async function writeReviseRequest(
    input: ReviseInput,
): Promise<ReviseResult> {
    if (!REPO_RE.test(input.repo)) {
        return { ok: false, reason: "invalid", message: "invalid-repo" };
    }
    if (!REQ_ID_RE.test(input.id)) {
        return { ok: false, reason: "invalid", message: "invalid-id" };
    }
    if (!PHASE_RE.test(input.phase)) {
        return { ok: false, reason: "invalid", message: "invalid-phase" };
    }

    const file = await readArtifactComments(input.repo, input.id, input.phase);
    const unresolved = file.comments.filter((c) => !c.resolved);
    if (unresolved.length === 0) {
        return { ok: false, reason: "no-comments" };
    }

    const feedback = buildFeedbackBlock(input.phase, unresolved);
    const requestedAt = new Date().toISOString();
    const { path: fbPath, canonical } = await feedbackArtifactPath(
        input.repo,
        input.id,
        input.phase,
    );

    try {
        await atomicWriteJson(fbPath, {
            v: 1,
            id: input.id,
            repo: input.repo,
            phase: input.phase,
            requestedBy: input.actor,
            requestedAt,
            feedback,
            comments: unresolved.map((c) => ({
                id: c.id,
                anchor: c.anchor,
                body: c.body,
            })),
        });
    } catch (err) {
        return {
            ok: false,
            reason: "internal",
            message: err instanceof Error ? err.message : String(err),
        };
    }

    // Write the daemon reconcile marker only when canonical — the daemon can
    // only reset a phase for a request it owns on disk.
    if (canonical) {
        try {
            await atomicWriteJson(reviseMarkerPath(input.repo, input.id), {
                v: 1,
                id: input.id,
                repo: input.repo,
                phase: input.phase,
                source: "portal",
                actor: input.actor,
                ts: requestedAt,
            });
        } catch (err) {
            // The feedback artifact is already written; surface the marker
            // failure so the caller knows the re-dispatch is not armed.
            return {
                ok: false,
                reason: "internal",
                message: err instanceof Error ? err.message : String(err),
            };
        }
    }

    // Mark the folded comments resolved so they are not re-sent on the next
    // revise. Best-effort: a failure here doesn't undo the feedback write.
    try {
        for (const c of file.comments) {
            if (!c.resolved && unresolved.some((u) => u.id === c.id)) {
                c.resolved = true;
            }
        }
        file.updatedAt = new Date().toISOString();
        const { path } = await commentsFilePath(
            input.repo,
            input.id,
            input.phase,
        );
        await atomicWriteJson(path, file);
    } catch {
        // Non-fatal — the feedback artifact is the source of truth for the
        // daemon; a stale unresolved flag only affects the next revise.
    }

    return {
        ok: true,
        count: unresolved.length,
        wired: canonical,
        feedbackPath: fbPath,
    };
}

/** Exported for tests. */
export const __test__ = {
    REQ_ID_RE,
    REPO_RE,
    PHASE_RE,
    feedbackArtifactPath,
};
