// SPEC-013-3-01 §Stub Data Modules — recent log lines.

import type { LogLine } from "../types/render";

const STUB: LogLine[] = [
    { ts: "2025-04-30T11:45:00Z", level: "info", message: "request started: REQ-000001" },
    { ts: "2025-04-30T11:45:05Z", level: "info", message: "phase intake complete" },
    { ts: "2025-04-30T11:46:00Z", level: "warn", message: "rate limit at 80%" },
];

export async function loadLogsStub(): Promise<LogLine[]> {
    return STUB;
}
