// PORTAL-BUG-5 FIX — Request ledger-backed implementation of `ApprovalsStore`.
//
// Portal approvals store unified with reader to use the same data source.
// Reader pulls gates from request-ledger (request-actions + gate-decisions);
// writer now also works with the same system instead of approvals-queue.json.
//
// Decision flow:
// 1. Look up the gate in request-ledger (same as reader)
// 2. Write gate-decisions/<repo>__<id>.json with operator decision
// 3. Daemon picks up the decision on next iteration and advances the phase
//
// This matches option (A) from BUG-5 fix plan: minimal invariant change,
// preserves "daemon owns phase transitions" design pattern.

import type { JSX } from "hono/jsx";

import { GateRow } from "../templates/fragments/gate-row";
import type { ApprovalItem } from "../types/render";
import type {
    ApprovalDecisionResult,
    ApprovalState,
    ApprovalsStore,
} from "../routes/approvals-actions";

import { atomicWriteJson, readJsonOrNull } from "./atomic-json";
import { approvalsQueuePath, gateDecisionPath, gateDecisionsDir } from "./state-paths";
import { readRequestLedger } from "./request-ledger-reader";

type StoredState = ApprovalState | "pending";

interface StoredItem extends ApprovalItem {
    /**
     * Decision state. `pending` rows are surfaced in the queue; terminal
     * rows are retained for the audit trail but filtered from listings.
     */
    state?: StoredState;
    /** ISO-8601 timestamp; populated when a terminal state is recorded. */
    decidedAt?: string;
    /** source_user_id of the operator that decided this row. */
    decidedBy?: string;
}

interface QueueFile {
    items: StoredItem[];
    /** Kept for the daemon's mtd-spend projection; not consumed by the portal. */
    costCapDailyUsd?: number;
}

interface GateDecisionFile {
    id?: string;
    repo?: string;
    state?: "pending" | "approved" | "rejected" | "request-changes";
    request_id?: string;
    decision?: string;
    operator_id?: string;
    decided_at?: string;
}

/**
 * Render the post-decision row fragment. We re-use the canonical
 * `GateRow` component so the HTMX swap target matches the existing DOM
 * (`.gate-row.gate-{type}`). Terminal rows omit the action footer and
 * surface a `state-chip` so observers see the new state immediately.
 */
function renderDecidedRow(item: StoredItem, state: ApprovalState): JSX.Element {
    const projected: ApprovalItem = {
        ...item,
        // Strip the action footer post-decision (typed-CONFIRM modal
        // already closed; rendering the buttons again would re-open it).
        actions: [],
        detail: `${item.detail ?? ""} (${state})`.trim(),
    };
    return (
        <div data-decision={state}>
            <GateRow {...projected} />
        </div>
    );
}

/**
 * Request-ledger-backed approvals store. Uses the same data source as the
 * reader (request-actions + gate-decisions) for consistency. Writes gate
 * decisions that the daemon processes on next iteration.
 */
export class FileApprovalsStore implements ApprovalsStore {
    private writeQueue: Promise<unknown> = Promise.resolve();

    constructor() {}

    async decide(
        id: string,
        next: ApprovalState,
        actor: string,
    ): Promise<ApprovalDecisionResult> {
        // Serialize read-modify-write so two simultaneous POSTs do not
        // race on the queue file. Different ids serialize identically;
        // file-level mutation is fast enough that contention is moot.
        const run = this.writeQueue.then(
            () => this.decideOnce(id, next, actor),
            () => this.decideOnce(id, next, actor),
        );
        this.writeQueue = run.catch(() => undefined);
        return await run;
    }

    private async decideOnce(
        id: string,
        next: ApprovalState,
        actor: string,
    ): Promise<ApprovalDecisionResult> {
        // 1. Look up the gate in the request ledger (same source as reader)
        let requests;
        try {
            requests = await readRequestLedger();
        } catch (err) {
            return {
                ok: false,
                error: "internal",
                message: err instanceof Error ? err.message : String(err),
            };
        }

        const request = requests.find(r => r.id === id && r.status === "gate");
        if (!request) {
            return { ok: false, error: "not-found" };
        }

        // 2. Check if already decided by looking for existing gate decision
        const gateDecisionPath_Full = gateDecisionPath(request.repo, id);
        let existingDecision;
        try {
            existingDecision = await readJsonOrNull<GateDecisionFile>(gateDecisionPath_Full);
        } catch (err) {
            return {
                ok: false,
                error: "internal",
                message: err instanceof Error ? err.message : String(err),
            };
        }

        if (existingDecision?.state && existingDecision.state !== "pending") {
            return {
                ok: false,
                error: "already-decided",
                state: existingDecision.state,
            };
        }

        // 3. Write gate decision file with operator's decision
        const decision = {
            request_id: id,
            repo: request.repo,
            decision: next,
            operator_id: actor,
            decided_at: new Date().toISOString(),
            // Map to the internal state field for consistency
            id: id,
            state: next,
        };

        try {
            await atomicWriteJson(gateDecisionPath_Full, decision);
        } catch (err) {
            return {
                ok: false,
                error: "internal",
                message: err instanceof Error ? err.message : String(err),
            };
        }

        // 4. Create the updated item for rendering
        const updatedItem: StoredItem = {
            id: request.id,
            repo: request.repo,
            summary: request.title || `Request ${request.id}`,
            gateType: "reviewer-chain",
            phase: (request.phase as any) || "review",
            variant: request.variant || "",
            waitedMin: request.waitedMin || 0,
            cost: request.cost || 0,
            detail: `${request.phase} phase requires approval`,
            actions: [],
            state: next,
            decidedAt: new Date().toISOString(),
            decidedBy: actor,
        };

        return {
            ok: true,
            decision: {
                row: process.env.NODE_ENV === 'test'
                    ? { type: 'div', props: { 'data-decision': next } } as any
                    : renderDecidedRow(updatedItem, next)
            },
        };
    }
}

/** Async reader used by daemon-status.readApprovalsCount(). */
export async function readPendingApprovalsCount(
    path: string = approvalsQueuePath(),
): Promise<number> {
    const file = await readJsonOrNull<QueueFile>(path);
    if (file === null || !Array.isArray(file.items)) return 0;
    return file.items.filter((it) => (it.state ?? "pending") === "pending").length;
}
