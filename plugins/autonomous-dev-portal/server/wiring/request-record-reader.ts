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

import type { RequestRecord, RequestRunRef, RequestReviewer, RequestArtifact } from "../types/render";
import { loadRequestStub } from "../stubs/requests";
import { readJsonOrNull } from "./atomic-json";
import { stateDirRoot, requestActionPath, userConfigPath } from "./state-paths";

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

        // Read artifact files if we have state.json
        const artifacts = state && repoPath
            ? await readArtifactFiles(repoPath, state.phase_history)
            : {};

        // Build rich RequestRecord from action + state + artifacts
        const record: RequestRecord = {
            id: action.id ?? id,
            repo: action.repo ?? repo,
            summary: state?.title ?? action.title ?? "",
            phases: [], // Not used by the detail view

            // Rich fields from daemon state or action fallback
            variant: action.variant,
            variantLabel: action.variant, // Use ID as label
            currentPhase: state?.current_phase ?? action.phase,
            status: mapDaemonStatus(state?.status ?? action.status),
            cost: state?.cost_accrued_usd ?? action.cost,
            turns: state?.turn_count ?? action.turns,
            startedAt: action.createdAt ?? state?.created_at,
            waitedMin: action.waitedMin,

            // Timeline and reviewers from phase_history
            runs: state ? buildRunsFromHistory(state.phase_history) : [],
            reviewers: state ? buildReviewersFromHistory(state.phase_history) : [],

            // Artifact content for current display
            currentArtifact: artifacts.prd ? {
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
            } : undefined,
        };

        return record;

    } catch (error) {
        // Log warning but don't throw - degrade gracefully
        console.warn(`Failed to load request record ${repo}/${id}:`, error);

        // Step 3: Fall back to stub on any error
        return await loadRequestStub(repo, id);
    }
}