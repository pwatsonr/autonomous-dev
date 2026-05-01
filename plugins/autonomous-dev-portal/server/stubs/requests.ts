// SPEC-013-3-01 §Stub Data Modules — request detail records.
//
// Keyed by (repo, id). Returns null when the (repo, id) tuple is unknown
// so the route handler can map to a 404.

import type { RequestRecord } from "../types/render";

const STUB: Record<string, RequestRecord> = {
    "acme/REQ-000001": {
        id: "REQ-000001",
        repo: "acme",
        summary: "Add login retry policy",
        phases: [
            {
                name: "intake",
                status: "complete",
                timestamp: "2025-04-30T10:00:00Z",
                agent: "intake-bot",
                detail: "Parsed user prompt, found 3 candidate plans.",
            },
            {
                name: "plan",
                status: "in-progress",
                timestamp: "2025-04-30T10:05:00Z",
                agent: "planner",
                detail: null,
            },
            {
                name: "implement",
                status: "pending",
                timestamp: null,
                agent: null,
                detail: null,
            },
        ],
    },
};

export async function loadRequestStub(
    repo: string,
    id: string,
): Promise<RequestRecord | null> {
    const key = `${repo}/${id}`;
    return STUB[key] ?? null;
}
