// SPEC-013-3-01 §Stub Data Modules — audit log rows.

import type { AuditRow } from "../types/render";

const STUB: AuditRow[] = [
    {
        ts: "2025-04-30T11:45:00Z",
        actor: "alice",
        action: "approve",
        target: "REQ-000001",
        result: "ok",
    },
    {
        ts: "2025-04-30T10:01:00Z",
        actor: "bob",
        action: "reject",
        target: "APP-002",
        result: "fail",
    },
];

export async function loadAuditStub(): Promise<AuditRow[]> {
    return STUB;
}
