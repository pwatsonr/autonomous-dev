// PLAN-037-2 — JSON-file-backed implementation of `ApprovalsStore`.
//
// The daemon owns the canonical approvals queue. Until a daemon-RPC
// channel lands, the portal reads + writes a shared JSON file at
// `${state_dir}/approvals-queue.json`. The daemon picks up the new state
// on its next iteration; the portal applies decisions atomically.
//
// Schema (matches the daemon's existing shape — verified by inspecting
// daemon-status.ts which reads `approvalsCount` from the same source):
//
//   {
//     "items": [
//       { "id": "REQ-2041", "state": "pending", "summary": "...",
//         "repo": "acme", "gateType": "reviewer-chain", ... }
//     ],
//     "decidedAt": { "REQ-2041": "2026-05-09T14:21:00Z" }
//   }
//
// Concurrency: read-modify-write under a per-process in-memory mutex so
// two simultaneous decide() calls do not lose updates. The atomic
// rename guarantees the file is never observed in a partial state.

import type { JSX } from "hono/jsx";

import { GateRow } from "../templates/fragments/gate-row";
import type { ApprovalItem } from "../types/render";
import type {
    ApprovalDecisionResult,
    ApprovalState,
    ApprovalsStore,
} from "../routes/approvals-actions";

import { atomicWriteJson, readJsonOrNull } from "./atomic-json";
import { approvalsQueuePath } from "./state-paths";

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
 * File-backed approvals store. Reads the queue from disk on every call
 * (cheap — daemon enforces a 50KB cap) so the portal never serves stale
 * decisions from a cached in-memory copy. Writes go through `atomicWriteJson`.
 */
export class FileApprovalsStore implements ApprovalsStore {
    private writeQueue: Promise<unknown> = Promise.resolve();

    constructor(private readonly path: string = approvalsQueuePath()) {}

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
        let file: QueueFile | null;
        try {
            file = await readJsonOrNull<QueueFile>(this.path);
        } catch (err) {
            return {
                ok: false,
                error: "internal",
                message: err instanceof Error ? err.message : String(err),
            };
        }
        if (file === null || !Array.isArray(file.items)) {
            return { ok: false, error: "not-found" };
        }
        const idx = file.items.findIndex((it) => it.id === id);
        if (idx === -1) {
            return { ok: false, error: "not-found" };
        }
        // Bun's tsserver narrows `file` above; restate the index lookup
        // so TS sees a definite value inside the closure.
        const item = file.items[idx] as StoredItem;
        const current = item.state ?? "pending";
        if (current === "approved" || current === "rejected") {
            return {
                ok: false,
                error: "already-decided",
                state: current,
            };
        }
        const updated: StoredItem = {
            ...item,
            state: next,
            decidedAt: new Date().toISOString(),
            decidedBy: actor,
        };
        const nextFile: QueueFile = {
            ...file,
            items: file.items.map((it, i) => (i === idx ? updated : it)),
        };
        try {
            await atomicWriteJson(this.path, nextFile);
        } catch (err) {
            return {
                ok: false,
                error: "internal",
                message: err instanceof Error ? err.message : String(err),
            };
        }
        return {
            ok: true,
            decision: { row: renderDecidedRow(updated, next) },
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
