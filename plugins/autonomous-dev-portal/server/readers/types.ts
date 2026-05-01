// SPEC-015-1-03 / SPEC-015-1-04 — Read-only accessor types.
//
// The `Result<T, E>` discriminated union is the public contract for ALL
// readers in this module. Readers never throw — corrupt files surface
// as `{ ok: false }` so the portal UI can render a banner without
// killing the process.

export type Result<T, E = Error> =
    | { ok: true; value: T }
    | { ok: false; error: E };

export type RequestPhase =
    | "pending"
    | "planning"
    | "tdd"
    | "plan_author"
    | "spec_author"
    | "executing"
    | "reviewing"
    | "completed"
    | "failed"
    | "cancelled"
    | "paused";

export const REQUEST_PHASES: ReadonlyArray<RequestPhase> = [
    "pending",
    "planning",
    "tdd",
    "plan_author",
    "spec_author",
    "executing",
    "reviewing",
    "completed",
    "failed",
    "cancelled",
    "paused",
];

export const TERMINAL_PHASES: ReadonlyArray<RequestPhase> = [
    "completed",
    "failed",
    "cancelled",
];

export type RequestSource =
    | "cli"
    | "claude-app"
    | "discord"
    | "slack"
    | "production-intelligence"
    | "portal";

export type RequestPriority = "low" | "normal" | "high" | "urgent";

export interface RequestState {
    request_id: string;
    phase: RequestPhase;
    created_at: string;
    updated_at: string;
    repository: string;
    title: string;
    source: RequestSource;
    priority: RequestPriority;
    branch?: string | null;
    session_id?: string | null;
    error?: string | null;
    cost_usd?: number | null;
    paused_at_phase?: RequestPhase | null;
    /** Forward compatibility: unknown daemon fields are preserved. */
    [extra: string]: unknown;
}

export interface PhaseEvent {
    ts: string;
    type: "phase_transition";
    request_id: string;
    from_phase: RequestPhase | null;
    to_phase: RequestPhase;
    trigger?: "daemon" | "operator" | "auto";
    duration_ms?: number;
}

export interface CostEntry {
    ts: string;
    request_id: string | null;
    phase: string | null;
    delta_usd: number;
    reason: "session_completion" | "session_failure" | "manual_adjustment";
    session_id?: string | null;
}

export interface CostLedger {
    version: 1;
    total_usd: number;
    daily_usd: Record<string, number>;
    per_request: Record<string, number>;
    entries: CostEntry[];
    last_updated: string;
}

export interface Heartbeat {
    version: 1;
    ts: string;
    pid: number;
    uptime_s: number;
    daemon_version: string;
    active_requests: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogLine {
    ts: string;
    level: LogLevel;
    message: string;
    source: "daemon" | "intake" | "portal" | "unknown";
    request_id?: string | null;
    /** Present when the origin was unstructured plain text. */
    raw?: string;
    /** Structured context (recursively redacted by LogReader). */
    context?: Record<string, unknown>;
}
