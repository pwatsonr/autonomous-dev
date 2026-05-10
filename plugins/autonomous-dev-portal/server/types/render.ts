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

// SPEC-036-2-01 §FR-9 — Costs surface extensions. All optional for back-compat.

export interface PhaseSpend {
    /** Lowercase phase name (matches `PhaseName`). */
    phase: string;
    /** Cost in USD. */
    cost: number;
    /** Percentage of total spend (0-100). */
    pct: number;
}

export interface ReviewerSpend {
    /** Reviewer agent name (e.g. "qa-edge-case"). */
    name: string;
    /** "generic" or "specialist" — drives chip tone. */
    role: "generic" | "specialist";
    /** Number of dispatches MTD. */
    runs: number;
    /** False-positive rate 0..1, or null when unknown. */
    fpRate: number | null;
    /** Cost in USD. */
    cost: number;
}

export interface DeploySpend {
    /** Environment label (prod, staging, dev, ...). */
    env: string;
    /** Backend tag (gcp, aws, k8s, github-pages, ...). */
    backend: string;
    /** Number of deploys MTD. */
    deploys: number;
    /** Last deploy time, free-form (e.g. "14:31", "2h ago"). */
    lastDeploy: string;
    /** Health tone: ok / warn / err / muted. */
    health: "ok" | "warn" | "err";
    /** Cost in USD. */
    cost: number;
}

export interface CostSeries {
    points: CostPoint[];
    budgetUsd: number;
    // SPEC-036-2-01 §FR-9 extensions.
    /** Per-phase spend rows for the "Spend by phase" table. */
    phaseSpend?: PhaseSpend[];
    /** Per-reviewer spend rows. */
    reviewerSpend?: ReviewerSpend[];
    /** Per-(env,backend) deploy spend rows. */
    deploySpend?: DeploySpend[];
    /** MTD total cost in USD. */
    totalMtd?: number;
    /** Number of requests MTD (denominator for avg/request KPI). */
    requestCount?: number;
    /** Monthly cost cap in USD (denominator for ring + KPI sub-line). */
    costCap?: number;
}

export interface LogLine {
    ts: string;
    level: string;
    message: string;
}

// SPEC-036-2-04 §FR-9 — Ops surface extensions. All optional for back-compat.

export interface McpServer {
    /** Server name (filesystem, github, prometheus, ...). */
    name: string;
    /** Health tone. */
    status: "ok" | "warn" | "err";
    /** Free-form latency / state detail (e.g. "12ms", "retry 1/3"). */
    detail: string;
}

export interface PluginChainCategory {
    /** Display label (CORE, REVIEWERS, VARIANTS, DEPLOY, ORG). */
    name: string;
    /** Optional accent — `core` or `org` get a tinted chrome on the chip. */
    accent?: "core" | "org";
    /** Package@version strings; may be empty (renders header only). */
    packages: string[];
}

export interface LogEntry {
    /** ISO8601 or short-format ts (e.g. "14:32:04Z"). Rendered as-is. */
    ts: string;
    /** INFO / WARN / ERROR / DEBUG / TRACE. DEBUG/TRACE are filtered out. */
    level: string;
    /** Message text. Phase/deploy/agent markers handled by the fragment. */
    message: string;
}

export interface DeployEvent {
    /** Time label ("14:31", "2d ago", ...). */
    time: string;
    /** Backend tag. */
    backend: string;
    /** Environment. */
    env: string;
    /** Status tone. */
    status: "ok" | "warn" | "err";
    /** Display text ("ok", "degraded", "rolled back"). */
    statusLabel: string;
}

export interface StandardsChange {
    /** Time label ("2h ago"). */
    time: string;
    /** Body text — fragment renders this verbatim with sentence case. */
    text: string;
}

export interface HeartbeatSample {
    /** ISO timestamp or 5-minute-bucket label. */
    ts: string;
    /** Bar height encoder. */
    latencyMs: number;
    /** Sample tone. */
    status: "ok" | "slow" | "miss";
}

export interface CircuitBreakerState {
    /** "closed" (healthy), "open" (tripped), "half-open" (probing). */
    state: "closed" | "open" | "half-open";
    /** Number of failures observed in the current window. */
    failureCount: number;
    /** ISO timestamp of the most recent state change. */
    changedAt: string | null;
}

export interface KillSwitchState {
    engaged: boolean;
    armed: boolean;
    /** Server-minted ISO arm timestamp. */
    armedAt?: string;
}

export interface OpsHealth {
    daemon: { status: string; pid: number | null };
    components: Record<string, string>;
    // SPEC-036-2-04 §FR-9 / SPEC-036-2-05 / SPEC-036-2-06 extensions.
    /** MCP server health rows. */
    mcpServers?: McpServer[];
    /** Plugin chain visualization categories (5 columns). */
    pluginChain?: PluginChainCategory[];
    /** Recent log entries (last 50, server-trimmed; INFO/WARN/ERROR only). */
    recentLog?: LogEntry[];
    /** Deploy events for the right-hand column table. */
    deployEvents?: DeployEvent[];
    /** Recent standards changes feed. */
    standardsChanges?: StandardsChange[];
    /** Total standards rules in catalog (for KPI strip). */
    standardsCount?: number;
    /** Subset of `standardsCount` flagged as immutable. */
    immutableCount?: number;
    /** 24-hour heartbeat samples (5-minute buckets, max 288). */
    heartbeat?: HeartbeatSample[];
    /** Circuit breaker state for the daemon control plane. */
    circuitBreaker?: CircuitBreakerState;
    /** Kill switch idle/armed/engaged state. */
    killSwitch?: KillSwitchState;
    /** Daemon uptime label ("4d 12h"). */
    uptime?: string;
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
    costs: {
        series: CostSeries;
        /** SPEC-036-2-03 — pre-computed by the route handler. */
        projection?: import("../lib/costs-projection").ProjectionResult;
    };
    logs: { lines: LogLine[] };
    ops: {
        health: OpsHealth;
        /** SPEC-014-2-04 — per-request CSRF token threaded through to KillSwitch. */
        csrfToken?: string;
    };
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
