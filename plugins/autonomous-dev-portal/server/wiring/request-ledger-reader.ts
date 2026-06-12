// PLAN-038 TASK-010 — request-ledger reader.
//
// **Important** (PLAN-038 O.Q. #2 resolution): there is NO daemon-written
// `requests-ledger.json` file. The TDD-037 v1.0/v1.1 assumption was wrong.
// Instead, this reader aggregates from the two existing daemon-written dirs:
//
//   ${state_dir}/portal/request-actions/<id>.json   — generic actions
//   ${state_dir}/portal/gate-decisions/<repo>__<id>.json — gate decisions
//
// For each request id, the latest action wins; the gate-decision (if any)
// joins to provide in-gate/decided state. Returns deduped DashboardRequest[].
//
// Failure modes (Agent 3's resilience requirement):
//   - missing dir         → empty []
//   - corrupt JSON in one → skip that file, log a warning, continue
//   - permission error    → empty [], warn

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DashboardRequest } from "../types/render";

import {
    gateDecisionsDir,
    requestActionsDir,
} from "./state-paths";

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
    score?: number;
    turns?: number;
    waitedMin?: number;
}

interface GateDecisionFile {
    id?: string;
    repo?: string;
    state?: "pending" | "approved" | "rejected" | "request-changes";
    waitedMin?: number;
}

/** Try-parse a single JSON file; return null on any failure. */
async function readJsonOrNull<T>(path: string): Promise<T | null> {
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/** Lift a parsed request-action file into the view-input shape, with safe defaults. */
function projectAction(a: RequestActionFile): DashboardRequest | null {
    // Without an id the row has no identity — skip it, but say so (the
    // resilience contract above promises a warning, not a silent drop, #390).
    if (typeof a.id !== "string") {
        console.warn("request-ledger: skipping action file without string id");
        return null;
    }
    // A missing repo is schema-incomplete but still renderable — surface the
    // row as repo "unknown" instead of silently hiding the request (#390).
    if (typeof a.repo !== "string") {
        console.warn(
            `request-ledger: action file for ${a.id} lacks 'repo'; rendering as repo "unknown"`,
        );
    }
    return {
        id: a.id,
        repo: typeof a.repo === "string" ? a.repo : "unknown",
        title: a.title ?? "",
        phase: a.phase ?? "",
        status: a.status ?? "running",
        cost: typeof a.cost === "number" ? a.cost : 0,
        turns: typeof a.turns === "number" ? a.turns : 0,
        score: typeof a.score === "number" ? a.score : 0,
        variant: a.variant ?? "",
        createdAt: a.createdAt,
        completedAt: a.completedAt,
        waitedMin: a.waitedMin,
    };
}

export interface RequestLedgerReaderOptions {
    /** Optional override for the actions dir (default: state-paths). */
    actionsDir?: string;
    /** Optional override for the gate-decisions dir (default: state-paths). */
    decisionsDir?: string;
}

/**
 * Read every request-action JSON in the actions dir, overlay any gate
 * decisions, return the deduped + projected list.
 */
export async function readRequestLedger(
    opts: RequestLedgerReaderOptions = {},
): Promise<DashboardRequest[]> {
    const actionsRoot = opts.actionsDir ?? requestActionsDir();
    const decisionsRoot = opts.decisionsDir ?? gateDecisionsDir();

    // ---------- 1. Read every action file ----------
    let actionFiles: string[];
    try {
        actionFiles = (await readdir(actionsRoot)).filter((f) =>
            f.endsWith(".json"),
        );
    } catch {
        return [];
    }

    const actionsById = new Map<string, DashboardRequest>();
    await Promise.all(
        actionFiles.map(async (f) => {
            const raw = await readJsonOrNull<RequestActionFile>(
                join(actionsRoot, f),
            );
            if (raw === null) {
                console.warn(`request-ledger: skipping unreadable action file ${f}`);
                return;
            }
            const projected = projectAction(raw);
            if (projected === null) return;
            // Latest write wins for duplicate ids (filesystem mtime would be
            // more correct, but the daemon writes each id once; ties don't
            // matter in practice).
            actionsById.set(projected.id, projected);
        }),
    );

    // ---------- 2. Overlay gate decisions ----------
    let decisionFiles: string[];
    try {
        decisionFiles = (await readdir(decisionsRoot)).filter((f) =>
            f.endsWith(".json"),
        );
    } catch {
        decisionFiles = [];
    }

    await Promise.all(
        decisionFiles.map(async (f) => {
            const raw = await readJsonOrNull<GateDecisionFile>(
                join(decisionsRoot, f),
            );
            if (raw === null || typeof raw.id !== "string") return;
            const existing = actionsById.get(raw.id);
            if (existing === undefined) return;
            // #390: terminal action status is AUTHORITATIVE. The daemon does
            // not clean up gate-decision files when a request ends, so a stale
            // "pending" decision must never resurrect a done/cancelled/failed
            // request as in-gate (the source of phantom approvals + fake
            // active counts across dashboard/requests/approvals/repos).
            if (
                existing.status === "done" ||
                existing.status === "cancelled" ||
                existing.status === "failed" ||
                existing.completedAt !== undefined
            ) {
                return;
            }
            // If gate decision is still pending, mark the request as "gate".
            if (raw.state === "pending" || raw.state === undefined) {
                existing.status = "gate";
                if (typeof raw.waitedMin === "number") {
                    existing.waitedMin = raw.waitedMin;
                }
            } else if (raw.state === "approved") {
                // Approved gates leave the request in its action-driven
                // phase; the daemon will advance it on its next loop.
            } else if (raw.state === "rejected") {
                existing.status = "done";
            }
        }),
    );

    return Array.from(actionsById.values());
}
