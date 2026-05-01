// SPEC-013-3-01 §Stub Data Modules / SPEC-013-3-02 §RenderProps Union
//
// Single source of truth for the discriminated union that maps a
// `ViewName` string literal to its required render props. The dispatcher
// in `server/templates/index.ts` and the page handlers in `server/routes/`
// import from this module so adding a new view forces a compile-time
// fanout to every consumer.
//
// Stub data shapes (DashboardData, RequestRecord, …) are intentionally
// minimal in this phase — PLAN-015 will swap them for live SQLite-backed
// types without changing the union shape consumers see.

export type ViewName =
    | "dashboard"
    | "request-detail"
    | "approvals"
    | "settings"
    | "costs"
    | "logs"
    | "ops"
    | "audit"
    | "404"
    | "500";

// ---- Stub data shapes ------------------------------------------------------
// Each interface is paired with an async loader in `server/stubs/*.ts`. The
// shape here is the contract those loaders fulfill.

export interface RepoSummary {
    repo: string;
    activeRequests: number;
    lastActivity: string; // ISO8601
    monthlyCostUsd: number;
    attentionCount: number;
}

export interface DashboardData {
    repos: RepoSummary[];
}

export interface Phase {
    name: string;
    status: "pending" | "in-progress" | "complete" | "failed";
    timestamp: string | null;
    agent: string | null;
    detail: string | null;
}

export interface RequestRecord {
    id: string; // REQ-NNNNNN
    repo: string;
    summary: string;
    phases: Phase[];
}

export interface ApprovalItem {
    id: string;
    summary: string;
    riskLevel: "low" | "med" | "high";
    repo: string;
    costImpactUsd: number;
    actions: { id: string; label: string; confirm: string | null }[];
}

export interface SettingsView {
    auth_mode: string;
    port: number;
    log_level: string;
}

export interface CostPoint {
    label: string;
    value: number;
}

export interface CostSeries {
    points: CostPoint[];
    budgetUsd: number;
}

export interface LogLine {
    ts: string;
    level: string;
    message: string;
}

export interface OpsHealth {
    daemon: { status: string; pid: number | null };
    components: Record<string, string>;
}

export interface AuditRow {
    ts: string;
    actor: string;
    action: string;
    target: string;
    result: "ok" | "fail";
}

// SPEC-015-4-02 — view props for the live audit page. Re-exported as
// distinct names so the view layer never imports from `services/`.
export type AuditPageResultProp = import("./audit-types").AuditPageResult;
export type AuditFiltersProp = import("./audit-types").AuditFilters;


// ---- RenderProps union -----------------------------------------------------

export interface RenderProps {
    dashboard: { data: DashboardData };
    "request-detail": { request: RequestRecord };
    approvals: { items: ApprovalItem[] };
    settings: { config: SettingsView };
    costs: { series: CostSeries };
    logs: { lines: LogLine[] };
    ops: { health: OpsHealth };
    /** SPEC-015-4-02 — `rows` is the legacy stub shape, `page`/`filters`
     *  is the live HMAC-chained log; AuditView prefers `page` when set. */
    audit: {
        rows: AuditRow[];
        page?: AuditPageResultProp;
        filters?: AuditFiltersProp;
    };
    "404": { path: string };
    "500": { message: string };
}
