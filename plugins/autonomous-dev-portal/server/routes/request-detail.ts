// SPEC-013-3-01 §Path Parameter Validation — `GET /repo/:repo/request/:id`.
// SPEC-036-3-01 — Request Detail re-skin: column-layout composition root
// hosting all 11 regions; threads `cache-control: no-store` and `csrfToken`
// (from request context) into the view.
//
// FR-026-20 — HTMX artifact endpoint:
//   GET /repo/:repo/request/:id/artifact/:phase
//   Returns the RdV3ArtifactPane fragment (outerHTML of #rd-artifact-pane)
//   so phase-track button clicks can swap the artifact pane inline without
//   a modal or a full-page reload. The response is always a bare HTML
//   fragment (no shell layout).
//
// Validates both path parameters with strict regexes BEFORE touching the
// stub. Any mismatch yields a 404 via notFound(c) so attackers can't probe
// for resource existence based on parsing-error messages.
//
// Repo slug:  ^[a-z0-9][a-z0-9-]{0,63}$  (lowercase, dash-allowed, 1–64 chars)
// Request ID: ^REQ-[0-9]{6}$              (exactly 6 digits)
// Phase key:  ^[a-z][a-z0-9-]{0,31}$      (alphanumeric, 1–32 chars)

import type { Context } from "hono";
import { jsx } from "hono/jsx";

import { notFound, renderPage } from "../lib/response-utils";
import {
    loadRequestRecord,
    loadArtifactForPhase,
} from "../wiring/request-record-reader";
import { RdV3ArtifactPane } from "../templates/fragments/rd-v3-artifact-pane";

const REPO_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const REQ_ID_RE = /^REQ-[0-9]{6}$/;
const PHASE_RE = /^[a-z][a-z0-9-]{0,31}$/;

/** Default pipeline for state derivation when the record has none. */
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

/**
 * GET /repo/:repo/request/:id — full request-detail page.
 *
 * Validates path params, loads the request record (real data or stub
 * fallback), and delegates rendering to `renderPage`.
 *
 * @param c - Hono context
 * @returns HTML response (full page or fragment depending on HX-Request)
 */
export const requestDetailHandler = async (c: Context): Promise<Response> => {
    const repo = c.req.param("repo");
    const id = c.req.param("id");

    if (typeof repo !== "string" || !REPO_RE.test(repo)) {
        return notFound(c);
    }
    if (typeof id !== "string" || !REQ_ID_RE.test(id)) {
        return notFound(c);
    }

    const request = await loadRequestRecord(repo, id);
    if (request === null) {
        return notFound(c);
    }

    // SPEC-036-3-01 AC-1 — cache-control: no-store on the live detail page.
    c.header("Cache-Control", "no-store");
    const csrfToken = (c.get("csrfToken") as string | undefined) ?? "";
    return renderPage(c, "request-detail", { request, csrfToken });
};

/**
 * GET /repo/:repo/request/:id/artifact/:phase — HTMX artifact pane fragment.
 *
 * FR-026-20 — Returns the `RdV3ArtifactPane` fragment (the outer element
 * carries `id="rd-artifact-pane"`) so the phase-track's `hx-swap="outerHTML"`
 * can replace the pane in-place without a modal or page reload.
 *
 * Always returns a bare HTML fragment (never a full page).
 *
 * @param c - Hono context
 * @returns HTML fragment response (no shell layout wrapper)
 */
export const artifactFragmentHandler = async (
    c: Context,
): Promise<Response> => {
    const repo = c.req.param("repo");
    const id = c.req.param("id");
    const phase = c.req.param("phase");

    if (typeof repo !== "string" || !REPO_RE.test(repo)) {
        return notFound(c);
    }
    if (typeof id !== "string" || !REQ_ID_RE.test(id)) {
        return notFound(c);
    }
    if (typeof phase !== "string" || !PHASE_RE.test(phase)) {
        return notFound(c);
    }

    // #499 — resolve the requested phase's REAL artifact (reads that phase's
    // document body, not just the current phase). Falls back to the record's
    // currentArtifact / undefined when the phase produced no readable doc.
    const { record: request, artifact } = await loadArtifactForPhase(
        repo,
        id,
        phase,
    );
    if (request === null) {
        return notFound(c);
    }

    c.header("Cache-Control", "no-store");

    // Derive phase state from the pipeline order.
    const pipeline = request.pipelinePhases ?? [...DEFAULT_PIPELINE];
    const currentPhase = request.currentPhase ?? pipeline[0] ?? "prd";
    const currentIndex = pipeline.indexOf(currentPhase);
    const phaseIndex = pipeline.indexOf(phase);

    let state: "done" | "now" | "pending";
    if (phaseIndex < 0) {
        // Phase not in pipeline — treat as pending
        state = "pending";
    } else if (phaseIndex < currentIndex) {
        state = "done";
    } else if (phaseIndex === currentIndex) {
        state = "now";
    } else {
        state = "pending";
    }

    // #499 — when a completed/earlier phase has a readable artifact, show it
    // as "done" prose (not the pending placeholder) even though the pipeline
    // has advanced past it.
    if (artifact !== undefined && state === "pending" && phaseIndex >= 0) {
        state = "done";
    }

    const branch = `auto/${id.toLowerCase()}`;

    // Render the artifact pane fragment as a bare HTML string.
    const element = jsx(RdV3ArtifactPane, {
        phase,
        state,
        artifact,
        branch,
        agent: artifact?.phase ?? "",
        dur: "",
        cost:
            request.cost !== undefined
                ? `$${request.cost.toFixed(2)}`
                : "$—",
        // #500 — pass repo + id so the pane appends the lazily-loaded comment
        // panel for readable Markdown artifacts (phase-swap reloads comments).
        repo,
        requestId: id,
    });

    // Hono JSX returns a string-like HtmlEscapedString.
    const html = String(await Promise.resolve(element));
    return c.html(html, 200);
};
