// SPEC-015-3-01 — Cost aggregation types.
//
// Read-only data shapes for the portal cost dashboard. The ledger entry
// shape mirrors the NDJSON line written by the daemon's cost ledger
// (PLAN-010-2). Aggregation outputs are pre-computed for templates so
// the rendering layer never recomputes percentages or projections.

export type CostPhase =
    | "PRD"
    | "TDD"
    | "Plan"
    | "Spec"
    | "Code"
    | "Review"
    | "Deploy";

export const CANONICAL_PHASES: ReadonlyArray<CostPhase> = [
    "PRD",
    "TDD",
    "Plan",
    "Spec",
    "Code",
    "Review",
    "Deploy",
];

export interface CostLedgerEntry {
    timestamp: string; // ISO-8601 UTC
    request_id: string; // REQ-NNNNNN
    repository: string; // absolute repo path
    phase: CostPhase;
    cost_tokens: number; // total tokens (input + output)
    cost_usd: number; // dollars (post-rate-card conversion)
    model: string;
    operation: string;
}

export interface DailySummary {
    date: string; // YYYY-MM-DD
    total_cost_usd: number;
    total_tokens: number;
    request_count: number; // distinct request_ids on this day
}

export interface MonthlySummary {
    month: string; // YYYY-MM
    total_cost_usd: number;
    total_tokens: number;
    request_count: number;
}

export interface RepoBreakdown {
    repository: string;
    total_cost_usd: number;
    request_count: number;
    pct_of_total: number; // 0..100, two decimals
}

export interface PhaseBreakdown {
    phase: CostPhase;
    total_cost_usd: number;
    pct_of_total: number;
}

export interface TopRequest {
    request_id: string;
    repository: string;
    total_cost_usd: number;
    drill_down_url: string; // /requests/${request_id}
}

export interface Projection {
    trailing_avg_usd_per_day: number;
    projected_seven_day_usd: number;
    basis_days: number; // <=7
}

export interface CapStatus {
    scope: "daily" | "monthly";
    current_usd: number;
    limit_usd: number;
    pct_of_limit: number; // 0..N (can exceed 100)
    severity: "ok" | "warn" | "exceeded";
    projected_total_usd?: number; // monthly only
}

export interface CapConfig {
    daily_usd?: number;
    monthly_usd?: number;
}

export interface AggregatorLogger {
    debug?: (msg: string) => void;
    warn?: (msg: string) => void;
}
