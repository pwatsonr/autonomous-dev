// PLAN-038 TASK-013 — read-side approvals helper.
//
// `approvals-store.tsx` has the mutating `FileApprovalsStore` (writes) and
// `readPendingApprovalsCount` (count only for the daemon-status endpoint).
// The Approvals surface needs the full pending list; this module supplies
// it without duplicating the QueueFile schema or read logic.
//
// NOTE: approvals-queue.json is bypassed in favor of the request ledger
// to match the Dashboard's "Awaiting approval" data source (status === "gate").

import type { ApprovalItem, ApprovalGateType, ApprovalPhase } from "../types/render";

import { readRequestLedger, type RequestLedgerReaderOptions } from "./request-ledger-reader";

export interface ApprovalsReadResult {
    items: ApprovalItem[];
    costCapDailyUsd: number;
}

export interface ApprovalsReaderOptions extends RequestLedgerReaderOptions {
    /** Fallback cost-cap when the file omits it. */
    defaultCostCapDailyUsd?: number;
}

/**
 * Classify a gate request's type using a best-effort heuristic.
 * Most gates come from the reviewer chain; cost and standards violations
 * would need specific markers in the request data to distinguish them.
 */
function classifyGateType(phase: string): ApprovalGateType {
    // Simple heuristic: reviewer phases suggest reviewer-chain gates
    if (phase === "review" || phase === "code") {
        return "reviewer-chain";
    }
    // Default to reviewer-chain for now; a more sophisticated implementation
    // would check additional fields or daemon markers
    return "reviewer-chain";
}

/**
 * Convert a phase string to the ApprovalPhase enum, mapping unknown values.
 */
function mapPhase(phase: string): ApprovalPhase {
    const knownPhases = ["prd", "tdd", "plan", "spec", "build", "review", "deploy"];
    if (knownPhases.includes(phase)) {
        // Map "build" to "build" (both are valid ApprovalPhase values)
        return phase as ApprovalPhase;
    }
    // Map unknown phases to a reasonable default
    if (phase === "code") return "build";
    return "review"; // fallback
}

/**
 * Returns every gate approval item (status === "gate") from the request ledger.
 * This matches the Dashboard's "Awaiting approval" data source instead of
 * reading from the separate approvals-queue.json file.
 */
export async function readApprovalsQueue(
    opts: ApprovalsReaderOptions = {},
): Promise<ApprovalsReadResult> {
    const fallback = opts.defaultCostCapDailyUsd ?? 25.0;
    const requests = await readRequestLedger(opts);

    // Filter to gate requests only
    const gateRequests = requests.filter((r) => r.status === "gate");

    // Transform to ApprovalItem shape
    const items: ApprovalItem[] = gateRequests.map((r) => ({
        id: r.id,
        summary: r.title || `Request ${r.id}`,
        repo: r.repo,
        gateType: classifyGateType(r.phase),
        phase: mapPhase(r.phase),
        variant: r.variant || "",
        waitedMin: r.waitedMin || 0,
        cost: r.cost || 0,
        detail: `${r.phase} phase requires approval`,
        actions: [
            { id: "approve", label: "Approve", confirm: null },
            { id: "reject", label: "Reject", confirm: "Reject this request?" },
        ],
    }));

    return {
        items,
        costCapDailyUsd: fallback,
    };
}
