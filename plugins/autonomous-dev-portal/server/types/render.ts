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
    // SPEC-036-1-06 §RepoSummary extensions — all optional for back-compat.
    /** Trust level (`L0`/`L1`/`L2`/`L3`); rendered in mono in the top row. */
    trust?: string;
    /** Active phase name; drives the 4px phase-colored left bar (R-12). */
    phase?: string;
    /** Variant id (raw); fragments use `variantLabel` for display. */
    variant?: string;
    /** Pre-resolved variant label for display; eliminates client lookup. */
    variantLabel?: string;
    /** Backend tag (e.g. `python`, `node`); rendered as info-tone chip. */
    backend?: string;
    /** Stack tag (e.g. `react`, `cli`); rendered as muted-tone chip. */
    stack?: string;
    /** Number of pending gates against this repo (drives footer warn chip). */
    gateCount?: number;
    /** When `true`, the repo card uses warn-line treatment instead of phase
     *  left bar. SPEC-036-1-03 AC #2. */
    attn?: boolean;
}

// SPEC-036-1-06 §New types ---------------------------------------------------

export interface DashboardRequest {
    id: string;
    repo: string;
    title: string;
    phase: string;
    status: "running" | "gate";
    cost: number;
    turns: number;
    score: number;
    variant: string;
    gateType?: string;
    stack?: string;
    /** Pre-resolved variant label for display; eliminates client-side lookup. */
    variantLabel?: string;
    /** Minutes spent waiting at a gate (when status === 'gate'). */
    waitedMin?: number;
}

export interface StandardsHit {
    ruleId: string;
    severity: "blocking" | "warn" | "advisory";
    hits: number;
}

export interface StandardsDriftEntry {
    repo: string;
    hitCount: number;
    severityMax: "blocking" | "warn" | "advisory";
    hits: StandardsHit[];
}

export interface StandardRule {
    id: string;
    severity: "blocking" | "warn" | "advisory";
    desc: string;
    /** Repo-name predicate string (e.g. `"*"` or `"acme,beta"`). */
    applies: string;
    source: string;
    immutable: boolean;
    hits: number;
}

export interface PipelineVariant {
    id: string;
    label: string;
    desc: string;
    phases: string[];
    reviewers?: Record<string, string[]>;
}

export interface DashboardData {
    repos: RepoSummary[];
    // SPEC-036-1-06 §DashboardData extensions — all optional for back-compat.
    requests?: DashboardRequest[];
    standards?: StandardRule[];
    variants?: PipelineVariant[];
    standardsDrift?: StandardsDriftEntry[];
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

/**
 * SPEC-036-1-01 — server-side Dashboard aggregates passed to the view.
 * Mirrors `DashboardAggregates` in `templates/views/dashboard.tsx`,
 * declared here as well so route handlers can construct the props
 * object without importing from `templates/`.
 */
export interface DashboardAggregatesProp {
    totalActive: number;
    totalGates: number;
    totalMtd: number;
    gateBreakdownText: string;
    totalBlockingHits: number;
    standardsCount: number;
    topGates: DashboardRequest[];
    standardsDrift: StandardsDriftEntry[];
}

export interface RenderProps {
    dashboard: { data: DashboardData; aggregates: DashboardAggregatesProp };
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
