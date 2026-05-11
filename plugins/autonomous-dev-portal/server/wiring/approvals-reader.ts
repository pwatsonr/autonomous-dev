// PLAN-038 TASK-013 — read-side approvals helper.
//
// `approvals-store.tsx` has the mutating `FileApprovalsStore` (writes) and
// `readPendingApprovalsCount` (count only for the daemon-status endpoint).
// The Approvals surface needs the full pending list; this module supplies
// it without duplicating the QueueFile schema or read logic.

import { readFile } from "node:fs/promises";

import type { ApprovalItem } from "../types/render";

import { approvalsQueuePath } from "./state-paths";

interface QueueFile {
    items?: Array<ApprovalItem & { state?: string }>;
    costCapDailyUsd?: number;
}

export interface ApprovalsReadResult {
    items: ApprovalItem[];
    costCapDailyUsd: number;
}

export interface ApprovalsReaderOptions {
    /** Override the queue file path (default: state-paths). */
    queuePath?: string;
    /** Fallback cost-cap when the file omits it. */
    defaultCostCapDailyUsd?: number;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
    try {
        const raw = await readFile(path, "utf-8");
        return JSON.parse(raw) as T;
    } catch {
        return null;
    }
}

/**
 * Returns every PENDING approval item (state === "pending" or omitted).
 * Decided items are retained in the file for the audit trail but excluded
 * here so the Approvals surface only shows actionable rows.
 */
export async function readApprovalsQueue(
    opts: ApprovalsReaderOptions = {},
): Promise<ApprovalsReadResult> {
    const path = opts.queuePath ?? approvalsQueuePath();
    const fallback = opts.defaultCostCapDailyUsd ?? 25.0;
    const file = await readJsonOrNull<QueueFile>(path);
    if (file === null || !Array.isArray(file.items)) {
        return { items: [], costCapDailyUsd: fallback };
    }
    const pending = file.items.filter(
        (it) => it.state === undefined || it.state === "pending",
    );
    return {
        items: pending,
        costCapDailyUsd: file.costCapDailyUsd ?? fallback,
    };
}
