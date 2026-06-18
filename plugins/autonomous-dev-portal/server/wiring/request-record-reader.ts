// PRD-020 FR-020-04 — real data source for request-detail route.
//
// Replaces the stub-only behavior in request-detail.ts with a 3-tier lookup:
// 1. Read request-actions/<id>.json + target repo state.json → build rich RequestRecord
// 2. If request-action exists but state.json is missing → build minimal RequestRecord
// 3. Fall back to loadRequestStub() → preserve kit-parity demo data
// 4. If stub returns null → return null (genuine 404)
//
// Reads the daemon config to map repo slug → full repo path. Resilient to
// missing/corrupt files — degrades gracefully rather than throwing.

import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { homedir } from "node:os";

import type {
    RequestRecord,
    RequestRunRef,
    RequestReviewer,
    RequestArtifact,
    RequestArtifactRef,
    RequestSummary,
} from "../types/render";
import { loadRequestStub } from "../stubs/requests";
import { readJsonOrNull } from "./atomic-json";
import { stateDirRoot, requestActionPath, userConfigPath } from "./state-paths";

/**
 * #499 — the canonical pipeline phase order. The reader scans for a
 * `phase-result-<phase>.json` for each of these (plus any `*_review`
 * variants discovered in `phase_history`) so the artifact index reflects
 * every phase the daemon actually ran, in pipeline order.
 */
const CANONICAL_PHASES = [
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
 * #499 — artifact kinds whose `path` points at a Markdown document the
 * portal can render inline (the artifact reading surface). Anything else
 * (github_pr, test-output, dockerfile, …) is listed but not rendered as
 * prose.
 */
const READABLE_DOC_KINDS = new Set([
    "prd",
    "tdd",
    "plan",
    "spec",
    "doc",
]);

/** Per-phase result envelope written by each phase agent (phase-helpers.sh). */
interface PhaseResultFile {
    status?: "pass" | "fail" | string;
    phase?: string;
    feedback?: string;
    artifacts?: Array<{
        kind?: string;
        path?: string;
        title?: string;
        url?: string;
    }>;
}

// Request-action file shape (from daemon's portal ledger)
interface RequestActionFile {
    id?: string;
    repo?: string;
    title?: string;
    phase?: string;
    status?: "queued" | "running" | "gate" | "done" | "cancelled" | "failed";
    cost?: number;
    variant?: string;
    createdAt?: string;
    completedAt?: string;
    waitedMin?: number;
    turns?: number;
}

// Daemon state.json shape (subset needed for RequestRecord)
interface DaemonStateFile {
    id?: string;
    status?: string;
    current_phase?: string;
    title?: string;
    description?: string;
    target_repo?: string;
    type?: string;
    phase_history?: Array<{
        phase?: string;
        status?: string;
        completed_at?: string;
        artifacts?: Array<{
            kind?: string;
            path?: string;
            title?: string;
            url?: string;
        }>;
    }>;
    current_phase_metadata?: unknown;
    cost_accrued_usd?: number;
    created_at?: string;
    updated_at?: string;
    turn_count?: number;
}

// Daemon config shape (subset for repositories.allowlist)
interface DaemonConfigFile {
    repositories?: {
        allowlist?: Array<{
            id?: string;
            path?: string;
        }>;
    };
}

/**
 * Map repo slug (basename) to full repo path by reading daemon config.
 * Returns null if the repo is not in the allowlist or config is missing.
 */
async function resolveRepoPath(repoSlug: string): Promise<string | null> {
    const config = await readJsonOrNull<DaemonConfigFile>(userConfigPath());
    if (config?.repositories?.allowlist) {
        for (const entry of config.repositories.allowlist) {
            if (typeof entry.path === "string" && basename(entry.path) === repoSlug) {
                return entry.path;
            }
        }
    }
    return null;
}

/**
 * Read markdown artifact files referenced in phase_history.
 * Caps read size at 64KB per file for safety.
 */
async function readArtifactFiles(
    repoPath: string,
    phaseHistory: DaemonStateFile["phase_history"]
): Promise<Record<string, string>> {
    const artifacts: Record<string, string> = {};
    const MAX_SIZE = 64 * 1024; // 64KB cap

    if (!Array.isArray(phaseHistory)) return artifacts;

    for (const phase of phaseHistory) {
        if (!Array.isArray(phase.artifacts)) continue;

        for (const artifact of phase.artifacts) {
            if (typeof artifact.path !== "string") continue;

            const artifactPath = join(repoPath, artifact.path);
            try {
                const content = await readFile(artifactPath, "utf-8");
                // Use artifact.kind as key (e.g. "prd", "tdd", "code")
                const key = typeof artifact.kind === "string" ? artifact.kind : artifact.path;
                artifacts[key] = content.length > MAX_SIZE
                    ? content.substring(0, MAX_SIZE) + "\n[... truncated at 64KB]"
                    : content;
            } catch {
                // Ignore read errors - artifact will be missing from result
            }
        }
    }

    return artifacts;
}

/** Max bytes read for any single artifact body (defense against huge files). */
const ARTIFACT_MAX_SIZE = 64 * 1024;

/**
 * #499 — the per-request state directory inside the target repo:
 *   <repoPath>/.autonomous-dev/requests/<id>/
 * This is where both `state.json` and every `phase-result-<phase>.json`
 * live (see plugins/autonomous-dev/bin/lib/phase-helpers.sh).
 */
function requestStateDir(repoPath: string, id: string): string {
    return join(repoPath, ".autonomous-dev", "requests", id);
}

/**
 * #499 — read every `phase-result-<phase>.json` envelope the daemon wrote
 * for this request. Scans the canonical phase list plus any `*_review`
 * phases recorded in `phase_history` (review sub-phases the canonical list
 * doesn't enumerate). Returns a map keyed by phase → parsed envelope.
 * Missing / corrupt files are skipped silently (graceful degradation).
 */
async function readPhaseResults(
    repoPath: string,
    id: string,
    phaseHistory: DaemonStateFile["phase_history"],
): Promise<Map<string, PhaseResultFile>> {
    const dir = requestStateDir(repoPath, id);
    const results = new Map<string, PhaseResultFile>();

    // Phases to probe: canonical pipeline + any history phases (covers
    // review sub-phases like "code_review" that aren't in CANONICAL_PHASES).
    const phaseKeys = new Set<string>(CANONICAL_PHASES);
    if (Array.isArray(phaseHistory)) {
        for (const h of phaseHistory) {
            if (typeof h.phase === "string" && h.phase.length > 0) {
                phaseKeys.add(h.phase);
            }
        }
    }

    for (const phase of phaseKeys) {
        // Phase key already passed the route regex when it comes from a URL;
        // here it is daemon/canonical data, but guard the filename anyway so
        // a malformed history entry can't escape the request directory.
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(phase)) continue;
        const path = join(dir, `phase-result-${phase}.json`);
        try {
            const parsed = await readJsonOrNull<PhaseResultFile>(path);
            if (parsed !== null && typeof parsed === "object") {
                results.set(phase, parsed);
            }
        } catch {
            // Corrupt phase-result file — skip it, keep the rest.
        }
    }

    return results;
}

/**
 * #499 / #501 — aggregate the artifact list from phase-result envelopes
 * (canonical source) and fall back to `phase_history[].artifacts[]` for any
 * phase that has no phase-result file. Returns the list in pipeline order.
 *
 * Each entry records phase + kind + path/title/url and a `readable` flag
 * (true for Markdown doc kinds with a path the portal can render inline).
 * A `github_pr` artifact's URL is taken from `url` or, as a fallback, from
 * `path`/`title` when the agent recorded the URL there.
 */
function aggregateArtifactList(
    phaseResults: Map<string, PhaseResultFile>,
    phaseHistory: DaemonStateFile["phase_history"],
): RequestArtifactRef[] {
    const list: RequestArtifactRef[] = [];
    const seen = new Set<string>();

    const phaseOrder = (p: string): number => {
        const i = (CANONICAL_PHASES as readonly string[]).indexOf(p);
        return i < 0 ? CANONICAL_PHASES.length : i;
    };

    const push = (
        phase: string,
        a: { kind?: string; path?: string; title?: string; url?: string },
    ): void => {
        const kind = typeof a.kind === "string" && a.kind.length > 0 ? a.kind : "doc";
        const path = typeof a.path === "string" && a.path.length > 0 ? a.path : undefined;
        const title = typeof a.title === "string" && a.title.length > 0 ? a.title : undefined;
        const url = resolveArtifactUrl(kind, a);
        // Dedupe on phase+kind+(path|url) so the phase-result and a stray
        // phase_history duplicate of the same artifact collapse to one row.
        const dedupeKey = `${phase}|${kind}|${path ?? url ?? title ?? ""}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        list.push({
            phase,
            kind,
            path,
            title,
            url,
            readable: READABLE_DOC_KINDS.has(kind) && path !== undefined,
        });
    };

    // Canonical: phase-result envelopes.
    for (const [phase, result] of phaseResults) {
        if (!Array.isArray(result.artifacts)) continue;
        for (const a of result.artifacts) push(phase, a);
    }

    // Fallback: phase_history artifacts for phases with no phase-result file.
    if (Array.isArray(phaseHistory)) {
        for (const h of phaseHistory) {
            const phase = typeof h.phase === "string" ? h.phase : "";
            if (phase === "" || phaseResults.has(phase)) continue;
            if (!Array.isArray(h.artifacts)) continue;
            for (const a of h.artifacts) push(phase, a);
        }
    }

    list.sort((x, y) => phaseOrder(x.phase) - phaseOrder(y.phase));
    return list;
}

/** Recognize an http(s) URL — used to validate github_pr links before we
 *  render them as clickable anchors (defangs non-http schemes). */
function isHttpUrl(value: string): boolean {
    return /^https?:\/\/[^\s]+$/i.test(value);
}

/**
 * #501 — resolve the URL for a link-style artifact. For `github_pr` the URL
 * is normally in `url`, but agents have historically written it into `path`
 * or `title` instead (the phase-helpers prompt says "write the resulting PR
 * URL into artifacts[]" without pinning the field). Accept any of them, but
 * only if it is a real http(s) URL.
 */
function resolveArtifactUrl(
    kind: string,
    a: { path?: string; title?: string; url?: string },
): string | undefined {
    const candidates = [a.url, a.path, a.title];
    for (const c of candidates) {
        if (typeof c === "string" && isHttpUrl(c)) return c;
    }
    return undefined;
}

/**
 * #501 — pick the request's PR URL: the first `github_pr` artifact with a
 * resolvable http(s) URL (code phase wins by pipeline order).
 */
function findPrUrl(artifacts: RequestArtifactRef[]): string | undefined {
    for (const a of artifacts) {
        if (a.kind === "github_pr" && a.url !== undefined) return a.url;
    }
    return undefined;
}

/**
 * #499 — read a single Markdown document artifact's body, on demand, for a
 * given phase. Used by the artifact-pane fragment endpoint so clicking any
 * phase's doc renders its real Markdown (not just the current phase). Caps
 * the read at 64KB. Returns null when there is no readable doc for the phase
 * or the file is missing.
 */
export async function readArtifactBody(
    repoPath: string,
    id: string,
    artifact: RequestArtifactRef,
): Promise<string | null> {
    if (!artifact.readable || artifact.path === undefined) return null;
    // Guard against path traversal: the recorded path must stay inside the
    // repo. Reject absolute paths and any `..` segment.
    const rel = artifact.path;
    if (rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) return null;
    const full = join(repoPath, rel);
    try {
        const content = await readFile(full, "utf-8");
        return content.length > ARTIFACT_MAX_SIZE
            ? content.substring(0, ARTIFACT_MAX_SIZE) + "\n\n[... truncated at 64KB]"
            : content;
    } catch {
        return null;
    }
}

/**
 * #502 — synthesize a concise plain-language summary from REAL data:
 *   - requested  ← state/action title (what was asked)
 *   - produced   ← human phrase derived from the artifact list + PR
 *   - outcome    ← latest phase-result feedback, qualified by lifecycle status
 *
 * Nothing is hand-written or hallucinated: every field comes from the
 * daemon's own envelopes. Returns undefined only when there is genuinely
 * nothing to say (no title, no artifacts, no feedback, no status).
 */
function synthesizeSummary(
    title: string | undefined,
    status: RequestRecord["status"],
    currentPhase: string | undefined,
    artifacts: RequestArtifactRef[],
    phaseResults: Map<string, PhaseResultFile>,
    phaseHistory: DaemonStateFile["phase_history"],
): RequestSummary | undefined {
    const requested =
        typeof title === "string" && title.trim() !== "" ? title.trim() : undefined;

    // produced: count document artifacts by kind + note a PR.
    const docKinds = artifacts
        .filter((a) => READABLE_DOC_KINDS.has(a.kind))
        .map((a) => a.kind.toUpperCase());
    const uniqueDocs = [...new Set(docKinds)];
    const hasPr = artifacts.some((a) => a.kind === "github_pr" && a.url !== undefined);
    const otherArtifactCount = artifacts.filter(
        (a) => !READABLE_DOC_KINDS.has(a.kind) && a.kind !== "github_pr",
    ).length;

    const producedParts: string[] = [];
    if (uniqueDocs.length > 0) producedParts.push(uniqueDocs.join(", "));
    if (otherArtifactCount > 0) {
        producedParts.push(
            `${otherArtifactCount} other artifact${otherArtifactCount === 1 ? "" : "s"}`,
        );
    }
    if (hasPr) producedParts.push("a pull request");
    const produced =
        producedParts.length > 0 ? producedParts.join(" · ") : undefined;

    // outcome: latest feedback wins. Prefer the most-recent phase_history
    // entry that has a phase-result with feedback; else any feedback; else a
    // status-derived line.
    const outcomeFeedback = latestFeedback(phaseResults, phaseHistory);
    const { line: statusLine, tone } = statusOutcome(status, currentPhase);
    let outcome: string | undefined;
    if (outcomeFeedback !== undefined) {
        outcome =
            statusLine !== undefined
                ? `${statusLine} — ${outcomeFeedback}`
                : outcomeFeedback;
    } else {
        outcome = statusLine;
    }

    if (requested === undefined && produced === undefined && outcome === undefined) {
        return undefined;
    }
    return { requested, produced, outcome, outcomeTone: tone };
}

/** Truncate feedback to a single concise line for the summary card. */
function trimFeedback(feedback: string): string {
    const oneLine = feedback.replace(/\s+/g, " ").trim();
    return oneLine.length > 280 ? oneLine.slice(0, 277) + "…" : oneLine;
}

/**
 * #502 — pick the most relevant feedback string. Walks `phase_history` from
 * the end (most recent first) and returns the first phase whose phase-result
 * carries feedback; falls back to any phase-result feedback in pipeline
 * order. Returns undefined when no phase emitted feedback.
 */
function latestFeedback(
    phaseResults: Map<string, PhaseResultFile>,
    phaseHistory: DaemonStateFile["phase_history"],
): string | undefined {
    if (Array.isArray(phaseHistory)) {
        for (let i = phaseHistory.length - 1; i >= 0; i--) {
            const phase = phaseHistory[i]?.phase;
            if (typeof phase !== "string") continue;
            const fb = phaseResults.get(phase)?.feedback;
            if (typeof fb === "string" && fb.trim() !== "") return trimFeedback(fb);
        }
    }
    for (const phase of CANONICAL_PHASES) {
        const fb = phaseResults.get(phase)?.feedback;
        if (typeof fb === "string" && fb.trim() !== "") return trimFeedback(fb);
    }
    // Any remaining (e.g. review sub-phases) — first with feedback.
    for (const result of phaseResults.values()) {
        if (typeof result.feedback === "string" && result.feedback.trim() !== "") {
            return trimFeedback(result.feedback);
        }
    }
    return undefined;
}

/** #502 — a status-derived outcome line + tone for the summary chip. */
function statusOutcome(
    status: RequestRecord["status"],
    currentPhase: string | undefined,
): { line: string | undefined; tone: RequestSummary["outcomeTone"] } {
    const phase = currentPhase ?? "";
    switch (status) {
        case "done":
            return { line: "Completed", tone: "ok" };
        case "failed":
            return { line: "Failed", tone: "err" };
        case "cancelled":
            return { line: "Cancelled", tone: "muted" };
        case "gate":
            return {
                line: phase !== "" ? `Awaiting approval at the ${phase} gate` : "Awaiting approval",
                tone: "warn",
            };
        case "queued":
            return { line: "Queued", tone: "muted" };
        case "running":
            return {
                line: phase !== "" ? `In progress — ${phase} phase` : "In progress",
                tone: "muted",
            };
        default:
            return { line: undefined, tone: "muted" };
    }
}

/**
 * Map daemon status to RequestRecord status enum.
 * Widens the type to include all daemon statuses.
 */
function mapDaemonStatus(
    daemonStatus: string | undefined
): "queued" | "running" | "gate" | "done" | "cancelled" | "failed" {
    switch (daemonStatus) {
        case "queued":
        case "running":
        case "gate":
        case "done":
        case "cancelled":
        case "failed":
            return daemonStatus;
        default:
            return "running"; // Safe default
    }
}

/**
 * Build RequestRunRef[] from phase_history for the runs timeline.
 */
function buildRunsFromHistory(
    phaseHistory: DaemonStateFile["phase_history"]
): RequestRunRef[] {
    if (!Array.isArray(phaseHistory)) return [];

    return phaseHistory
        .filter(entry =>
            typeof entry.phase === "string" &&
            typeof entry.completed_at === "string"
        )
        .map((entry, index) => ({
            runId: `run-${entry.phase}-${index + 1}`,
            timestamp: entry.completed_at!,
            phase: entry.phase!,
            outcome: entry.status === "failed" ? "fail" as const : "pass" as const,
            cost: 0, // Not available in phase_history
        }));
}

/**
 * Build RequestReviewer[] from phase_history entries whose phase ends with "_review".
 */
function buildReviewersFromHistory(
    phaseHistory: DaemonStateFile["phase_history"]
): RequestReviewer[] {
    if (!Array.isArray(phaseHistory)) return [];

    return phaseHistory
        .filter(entry =>
            typeof entry.phase === "string" &&
            entry.phase.endsWith("_review")
        )
        .map((entry, index) => ({
            name: `${entry.phase}-agent`,
            version: "1.0.0",
            blocking: entry.status === "failed",
            finding: entry.status === "failed" ? "Failed review" : "Passed review",
            runId: `run-${entry.phase}-${index + 1}`,
            dimensions: [],
        }));
}

/**
 * #499 — choose and read the artifact body shown on initial page load.
 * Prefers the current phase's readable doc; otherwise the last readable doc
 * in pipeline order (the most-advanced phase that produced a document).
 * Returns a {@link RequestArtifact} with rendered-ready markdown, or
 * undefined when no readable doc exists / the file is missing.
 */
async function resolveInitialArtifact(
    repoPath: string,
    id: string,
    currentPhase: string | undefined,
    artifactList: RequestArtifactRef[],
): Promise<RequestArtifact | undefined> {
    const readable = artifactList.filter((a) => a.readable);
    if (readable.length === 0) return undefined;

    const preferred =
        (currentPhase !== undefined &&
            readable.find((a) => a.phase === currentPhase)) ||
        readable[readable.length - 1];
    if (preferred === undefined) return undefined;

    const body = await readArtifactBody(repoPath, id, preferred);
    if (body === null) return undefined;

    return {
        phase: preferred.phase,
        format: "markdown",
        content: body,
        artifactId: preferred.title,
    };
}

/**
 * Load a RequestRecord from real data sources.
 * Returns null if the request doesn't exist in any source.
 */
export async function loadRequestRecord(
    repo: string,
    id: string
): Promise<RequestRecord | null> {
    try {
        // Step 1: Try to read request-action
        const actionPath = requestActionPath(id);
        const action = await readJsonOrNull<RequestActionFile>(actionPath);

        if (action === null) {
            // Step 3: Fall back to stub
            return await loadRequestStub(repo, id);
        }

        // Step 2: We have a request-action, try to read daemon state.json
        const repoPath = await resolveRepoPath(repo);
        let state: DaemonStateFile | null = null;

        if (repoPath) {
            const statePath = join(repoPath, ".autonomous-dev", "requests", id, "state.json");
            state = await readJsonOrNull<DaemonStateFile>(statePath);
        }

        // Read artifact files (markdown bodies keyed by kind) from
        // phase_history — kept for back-compat with the currentArtifact
        // fallback below.
        const artifacts = state && repoPath
            ? await readArtifactFiles(repoPath, state.phase_history)
            : {};

        // #499/#501/#502 — read every phase-result envelope (the canonical
        // source of artifacts + feedback) and aggregate.
        const phaseResults = state && repoPath
            ? await readPhaseResults(repoPath, id, state.phase_history)
            : new Map<string, PhaseResultFile>();
        const artifactList = aggregateArtifactList(phaseResults, state?.phase_history);
        const prUrl = findPrUrl(artifactList);

        const currentPhase = state?.current_phase ?? action.phase;
        const status = mapDaemonStatus(state?.status ?? action.status);
        const title = state?.title ?? action.title ?? "";

        const outcomeSummary = synthesizeSummary(
            title,
            status,
            currentPhase,
            artifactList,
            phaseResults,
            state?.phase_history,
        );

        // #499 — pick the artifact shown on initial load. Prefer the current
        // phase's readable doc; else the LAST readable doc in the list (most
        // advanced phase); else fall back to the legacy PRD/TDD/code probe.
        const currentArtifact =
            (repoPath
                ? await resolveInitialArtifact(repoPath, id, currentPhase, artifactList)
                : undefined) ??
            (artifacts.prd ? {
                phase: "prd",
                format: "markdown" as const,
                content: artifacts.prd,
                artifactId: undefined,
            } : artifacts.tdd ? {
                phase: "tdd",
                format: "markdown" as const,
                content: artifacts.tdd,
                artifactId: undefined,
            } : artifacts.code ? {
                phase: "code",
                format: "diff" as const,
                content: artifacts.code,
                artifactId: undefined,
            } : undefined);

        // Build rich RequestRecord from action + state + artifacts
        const record: RequestRecord = {
            id: action.id ?? id,
            repo: action.repo ?? repo,
            summary: title,
            phases: [], // Not used by the detail view

            // Rich fields from daemon state or action fallback
            variant: action.variant,
            variantLabel: action.variant, // Use ID as label
            currentPhase,
            status,
            cost: state?.cost_accrued_usd ?? action.cost,
            turns: state?.turn_count ?? action.turns,
            startedAt: action.createdAt ?? state?.created_at,
            waitedMin: action.waitedMin,

            // Timeline and reviewers from phase_history
            runs: state ? buildRunsFromHistory(state.phase_history) : [],
            reviewers: state ? buildReviewersFromHistory(state.phase_history) : [],

            // #499/#501/#502 — artifact index, PR link, synthesized summary.
            artifactList,
            prUrl,
            outcomeSummary,

            // Artifact content for current display
            currentArtifact,
        };

        return record;

    } catch (error) {
        // Log warning but don't throw - degrade gracefully
        console.warn(`Failed to load request record ${repo}/${id}:`, error);

        // Step 3: Fall back to stub on any error
        return await loadRequestStub(repo, id);
    }
}

/**
 * #499 — resolve the artifact to render for a SPECIFIC phase (the artifact
 * pane endpoint). Unlike the prior behavior — which only ever served the
 * "current" artifact — this reads the requested phase's real document so
 * clicking any phase (track step or artifact-index row) shows that phase's
 * Markdown.
 *
 * Resolution order:
 *   1. If the phase has a readable doc artifact AND the repo path resolves,
 *      read the doc body fresh from disk and return it as markdown.
 *   2. Else if the record's `currentArtifact` is for this phase, return it
 *      (covers the stub path and the diff/code artifact built from history).
 *   3. Else undefined (the pane renders its "no artifact" / pending state).
 *
 * Returns `{ record, artifact }` so the caller can derive phase state from
 * the same record without a second read.
 */
export async function loadArtifactForPhase(
    repo: string,
    id: string,
    phase: string,
): Promise<{ record: RequestRecord | null; artifact: RequestArtifact | undefined }> {
    const record = await loadRequestRecord(repo, id);
    if (record === null) return { record: null, artifact: undefined };

    // 1. Readable doc for this phase → fresh body read.
    const ref = (record.artifactList ?? []).find(
        (a) => a.phase === phase && a.readable,
    );
    if (ref !== undefined) {
        const repoPath = await resolveRepoPath(record.repo);
        if (repoPath !== null) {
            const body = await readArtifactBody(repoPath, id, ref);
            if (body !== null) {
                return {
                    record,
                    artifact: {
                        phase,
                        format: "markdown",
                        content: body,
                        artifactId: ref.title,
                    },
                };
            }
        }
    }

    // 2. Fall back to the record's current artifact when it is this phase.
    if (record.currentArtifact?.phase === phase) {
        return { record, artifact: record.currentArtifact };
    }

    // 3. No artifact for this phase.
    return { record, artifact: undefined };
}