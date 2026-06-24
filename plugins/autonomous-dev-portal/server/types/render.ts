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
    | "requests"
    | "approvals"
    | "settings"
    | "costs"
    | "logs"
    | "ops"
    | "audit"
    | "agents" // PLAN-038 TASK-005 — net-new /agents surface
    | "repos" //  PLAN-038 TASK-005 — net-new /repos surface
    | "onboard" // ONBOARD Phase 3 (#594) — org/project/repo browser
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
    /** False = historical-activity row NOT in the allowlist (#395). */
    inAllowlist?: boolean;
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
    /** Absolute path to the repo on disk; populated from the operator's
     *  allowlist when available. The card uses this for the path row so
     *  the display matches the daemon's actual target instead of the
     *  hardcoded `~/projects/{repo}` placeholder. */
    path?: string;
}

// SPEC-036-1-06 §New types ---------------------------------------------------

export interface DashboardRequest {
    id: string;
    repo: string;
    title: string;
    phase: string;
    /** Lifecycle status. `"done"` (PLAN-Requests-Surface) marks a completed
     *  request; the legacy Dashboard table filters those out, the new
     *  `/requests` surface aggregates them for "Completed today" KPIs. */
    status: "queued" | "running" | "gate" | "done" | "cancelled" | "failed";
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
    /** ISO-8601 completion timestamp. Set when `status === "done"`; drives
     *  the `/requests` surface "Completed today" KPI rollup. */
    completedAt?: string;
    /** ISO-8601 creation timestamp. Powers the "Age" column on /requests. */
    createdAt?: string;
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

/**
 * SPEC-037-7-02 §Standards-applied — one row in the Standards-applied
 * section. Severity values are constrained at the type level; renderers
 * MUST coerce unknown values to `"advisory"` (defensive default).
 */
export interface StandardsRule {
    id: string;
    desc: string;
    severity: "blocking" | "warn" | "advisory";
    source: string;
    immutable?: boolean;
}

/**
 * SPEC-037-7-01/02 §Request feature flags. Optional bag used by the
 * Request Detail view to decide whether to mount conditional sections.
 * Kept as a discrete sub-object so future flag additions don't bloat the
 * `RequestRecord` interface.
 */
export interface RequestFlags {
    /** SPEC-037-7-02 — when true the Standards-applied section renders
     *  iff `standardsApplied.length > 0`. */
    hasStandards?: boolean;
    /** PLAN-042 Phase D — when true the request is currently gated on a
     *  `VERIFICATION_FAILED` envelope and the operator can authorize an
     *  override. Drives the "Override verification" button. */
    verificationFailed?: boolean;
    /** PLAN-042 Phase D — when true an override has been recorded for
     *  this request (set by either the CLI or the portal POST). The
     *  request-detail page hides the override-button when this is true
     *  and renders the audit line instead. */
    verificationOverrideApplied?: boolean;
}

export interface RequestRecord {
    id: string; // REQ-NNNNNN
    repo: string;
    summary: string;
    phases: Phase[];
    // SPEC-036-3-01..06 — Request Detail re-skin (PLAN-036-3). All optional
    // for back-compat with the existing stub & 015-* consumers.
    /** Active variant id (e.g. `"prd"`, `"code"`, `"deploy"`). */
    variant?: string;
    /** Pre-resolved variant label for display. */
    variantLabel?: string;
    /** Pipeline phase list in canonical order (variant-aware). */
    pipelinePhases?: string[];
    /** Currently-active phase name (must appear in `pipelinePhases`). */
    currentPhase?: string;
    /** Top-level lifecycle status — `"gate"` activates the gate-detail
     *  card; terminal states (done/cancelled/failed) freeze the page and
     *  disable gate controls. The old `"running" | "gate"` union made
     *  terminal states UNREPRESENTABLE at the type level — the same
     *  lifecycle gap as the requests table (crawl p2/p4). */
    status?: "queued" | "running" | "gate" | "done" | "cancelled" | "failed";
    /** Active gate type when `status === "gate"`. */
    gateType?: string;
    /** Free-form gate description rendered in the gate detail card body. */
    gateDetail?: string;
    /** Minutes elapsed at the gate. */
    waitedMin?: number;
    /** Reviewer chain (review/code phases). */
    reviewers?: RequestReviewer[];
    /** Deploy stage when `currentPhase === "deploy"`. */
    deployStage?: string;
    /** Deploy target label (e.g. `"prod-cluster"`). */
    deployTarget?: string;
    /** SPEC-036-3-02 — persistent reading surface artifact. */
    currentArtifact?: RequestArtifact;
    /** SPEC-036-3-05 — past daemon iterations against this request. */
    runs?: RequestRunRef[];

    /**
     * #499 — every artifact the request produced, aggregated from each
     * phase's `phase-result-<phase>.json` `artifacts[]`. Drives the
     * artifact index in the detail view. Empty array = none recorded.
     */
    artifactList?: RequestArtifactRef[];
    /**
     * #501 — the `github_pr` artifact URL (the PR the request opened), if
     * any. Surfaced as a clickable link in the detail view.
     */
    prUrl?: string;
    /**
     * #502 — synthesized plain-language summary of what the request did.
     */
    outcomeSummary?: RequestSummary;

    // SPEC-037-7-01 §`.rd-stat` block — three mono numeric cells in the
    // request-header right column. All optional for back-compat; renderers
    // default missing fields to `0`.
    /** Total request cost in USD. Rendered `$X.XX`. */
    cost?: number;
    /** Total daemon turns (loop iterations). */
    turns?: number;
    /** Aggregate reviewer score (0-100 or 0-10 depending on rubric). */
    score?: number;
    /** ISO-8601 start timestamp. Rendered as the final `.rd-meta` segment. */
    startedAt?: string;

    /**
     * PRD-026 §4-state gate coverage — recorded gate decision when an
     * operator has already acted on this gate.  `null` or absent means the
     * gate is still awaiting a decision (action buttons render).
     * "approved" | "rejected" | "deferred" map to the banner variants in
     * RdV3GatePanel.
     */
    gateDecision?: "approved" | "rejected" | "deferred" | null;

    // SPEC-037-7-02 §Standards-applied section.
    /** Per-request feature flag bag; drives conditional sections. */
    flags?: RequestFlags;
    /** Standards rules applied to this request (rendered iff
     *  `flags.hasStandards === true` AND list is non-empty). */
    standardsApplied?: StandardsRule[];
}

/**
 * SPEC-036-3-04 §Reviewer chain detail — per-reviewer card content.
 *
 * `dimensions` are rubric scores rendered via the `Score` primitive; each
 * dimension links to the reviewer agent run via the `runId` on the parent.
 */
export interface RequestReviewerDimension {
    /** Rubric dimension label (e.g. `"correctness"`). */
    name: string;
    /** Score numerator. */
    num: number;
    /** Score denominator. */
    den: number;
    /** Pass threshold; tone-mapping is server-derived. */
    threshold?: number;
}

export interface RequestReviewer {
    /** Reviewer agent name (e.g. `"qa-edge-case-reviewer"`). */
    name: string;
    /** Agent semver (rendered `meta-mono`). */
    version: string;
    /** When `true` the reviewer is in a blocking state — finding lines
     *  attached on this card will block the gate. */
    blocking: boolean;
    /** Free-form finding summary (one line). */
    finding: string;
    /** Reviewer agent run id; powers `/agents/{name}/runs/{runId}` links. */
    runId: string;
    /** Rubric dimensions — each rendered as a `Score` row. */
    dimensions: RequestReviewerDimension[];
}

/**
 * SPEC-036-3-02 §RequestArtifact — persistent inline reading surface.
 *
 * The artifact pane consumes this shape to render PRD/TDD prose (markdown),
 * code diffs (per-line tinted `<pre>`), or plain text. Trust boundary: the
 * daemon is authoritative for `content`; the renderer escapes diff/text
 * branches and runs a minimal markdown subset for the prose branch.
 */
export interface RequestArtifact {
    /** Phase name the artifact belongs to (uppercased in the section head). */
    phase: string;
    /** Render branch — drives format-aware rendering. */
    format: "markdown" | "diff" | "text";
    /** Daemon-authored artifact body. */
    content: string;
    /** Optional artifact identifier shown `meta-mono dim` next to the head. */
    artifactId?: string;
}

/**
 * #499 — a single artifact the request produced, as recorded in a phase's
 * `phase-result-<phase>.json` `artifacts[]` entry. This is the *listing*
 * shape (what's shown in the artifact index); the readable body for a
 * document artifact is loaded on demand into a {@link RequestArtifact}.
 *
 * `kind` is the daemon-authored artifact kind ("prd" | "tdd" | "plan" |
 * "spec" | "doc" | "github_pr" | "test-output" | …). `url` is populated
 * only for link-style artifacts (notably `github_pr` — #501). `phase` is
 * the pipeline phase whose result emitted the artifact; the detail view
 * uses it to key the on-demand body fetch.
 */
export interface RequestArtifactRef {
    /** Pipeline phase that emitted the artifact (e.g. "prd", "code"). */
    phase: string;
    /** Daemon-authored artifact kind ("prd" | "tdd" | "github_pr" | …). */
    kind: string;
    /** Repo-relative path to the artifact file (absent for pure links). */
    path?: string;
    /** One-line human title from the phase-result entry. */
    title?: string;
    /** Absolute URL for link-style artifacts (e.g. the github_pr URL). */
    url?: string;
    /**
     * True when the artifact is a Markdown document the portal can render
     * inline (prd/tdd/plan/spec/doc with a readable `path`). Drives whether
     * the artifact row is a clickable phase tab vs. an external link or an
     * inert evidence row.
     */
    readable?: boolean;
}

/**
 * #502 — synthesized plain-language summary of what a request did. Built
 * from real phase-result feedback + the artifact list + the lifecycle
 * status; never hand-written. All fields optional so the view can render a
 * partial summary (e.g. outcome line only) when the daemon has emitted
 * little.
 */
export interface RequestSummary {
    /** What was requested — the request title/description. */
    requested?: string;
    /** What was produced — short phrase, e.g. "PRD, TDD, plan + a PR". */
    produced?: string;
    /** Outcome line synthesized from the latest phase feedback + status. */
    outcome?: string;
    /** Tone for the outcome chip. */
    outcomeTone?: "ok" | "warn" | "err" | "muted";
}

/**
 * SPEC-036-3-05 §RequestRunRef — past daemon iteration row in run-history.
 */
export interface RequestRunRef {
    runId: string;
    /** ISO-8601 UTC timestamp; rendered `meta-mono dim` verbatim. */
    timestamp: string;
    /** Phase the run executed (drives the phase chip). */
    phase: string;
    /** Run outcome → outcomeTone() picks the chip tone. */
    outcome: "pass" | "fail" | "block";
    /** Cost in USD. */
    cost: number;
}

// SPEC-037-4-04 §ApprovalItem — rebuilt for the kit's gate-row shape.
//
// Replaces the legacy `riskLevel` / `costImpactUsd` schema. Each item is a
// single open gate the operator can approve or reject from the Approvals
// surface. The fields map to the kit's three-column gate-row layout:
//   - `gateType` drives the row's left-border color + segmented-filter target
//   - `phase` / `variant` / `repo` populate the gate-meta middle column
//   - `waitedMin` / `cost` render in the left/right info columns
//   - `detail` is the human-readable second line under the summary
export type ApprovalGateType =
    | "reviewer-chain"
    | "standards-violation"
    | "cost-cap";

export type ApprovalPhase =
    | "prd"
    | "tdd"
    | "plan"
    | "spec"
    | "build"
    | "review"
    | "deploy";

export interface ApprovalItem {
    id: string;
    summary: string;
    repo: string;
    /** Gate type drives the segmented filter and the row's `gate-{type}` class. */
    gateType: ApprovalGateType;
    /** Phase the gate is blocking; powers the phase chip in gate-meta. */
    phase: ApprovalPhase;
    /** Variant id (e.g. `"deep-research"`); rendered via `variantLabel`. */
    variant: string;
    /** Integer minutes the gate has been waiting. */
    waitedMin: number;
    /** Cost-to-date in USD (may be 0). */
    cost: number;
    /** Human-readable gate-detail line beneath the row summary. */
    detail: string;
    /** Optional metadata for KPI sub-line aggregation (e.g. blocking-hit count). */
    blocking?: boolean;
    actions: { id: string; label: string; confirm: string | null }[];
}

// #429 — gate-decision history surfaced on the Approvals page.
//
// Powers the Approved / Rejected tabs and the "Gate stats · 7d" card from
// the REAL gate-decisions store (see wiring/gate-history-reader.ts). These
// shapes are the view-facing projection of `GateHistoryEntry` /
// `GateHistoryStats` so route handlers stay decoupled from the reader.

/** Approvals topbar tab — which slice of gate state the page shows. */
export type ApprovalsTab = "pending" | "approved" | "rejected";

/** One decided gate, rendered in the Approved / Rejected tab tables. */
export interface GateHistoryItem {
    id: string;
    repo: string;
    phase: string;
    decision: "approved" | "rejected" | "request-changes";
    /** ISO-8601 decision timestamp (undefined when the source omitted it). */
    decidedAt?: string;
    /** Operator/actor that decided, when recorded. */
    decidedBy?: string;
}

/** 7-day gate-stats summary for the Approvals stats card (#429). */
export interface GateStats7d {
    windowDays: number;
    total: number;
    approved: number;
    rejected: number;
    requestChanges: number;
    /** approved / total, 0..1. */
    approveRate: number;
    /** rejected / total, 0..1. */
    rejectRate: number;
}

export interface SettingsView {
    auth_mode: string;
    port: number;
    log_level: string;
}

// SPEC-036-4-01 — Settings tab IDs (single source of truth).
// Server route handler, view, and tab-nav fragment all import this so a
// typo cannot create drift (per PLAN-036-4 risk row 7).
export const TAB_IDS = [
    "general",
    "variants",
    "standards",
    "backends",
    "agents",
] as const;

export type TabId = (typeof TAB_IDS)[number];

// SPEC-036-4-07 — Agent factory record + recent runs reference.
export interface AgentRunRef {
    id: string;
    /** ISO-8601 timestamp. */
    startedAt: string;
    status: "success" | "failed" | "cancelled";
    durationMs: number;
    cost: number;
}

export interface AgentRecord {
    name: string;
    role: string;
    state: "active" | "shadow" | "frozen";
    /** Approval rate as a percentage 0..100. */
    approvalPct: number;
    /** Precision percentage 0..100. */
    precisionPct: number;
    /** Recall percentage 0..100. */
    recallPct: number;
    version: string;
    /** ISO-8601 last-trained timestamp. */
    lastTrainedAt: string;
    /** Recent runs, capped to 5 by the loader (PLAN-036-4 risk row 6). */
    recentRuns: AgentRunRef[];
}

// SPEC-036-4 — deploy backend record (Backends tab).
// SPEC-037-5-04 — extends with `name`, `cost`, `caps`, `status` for the
// `.backend-card` grid layout. All new fields are optional for
// back-compat with the existing five-column table renderer.
export interface DeployBackend {
    id: string;
    label: string;
    kind: string;
    enabled: boolean;
    health: "ok" | "warn" | "err" | "muted";
    /** SPEC-037-5-04 — display name for the card top row. Falls back to `label`. */
    name?: string;
    /** SPEC-037-5-04 — free-form cost line (e.g. `"$0.012 / run"`). */
    cost?: string;
    /** SPEC-037-5-04 — capability tags rendered as `.cap-chip`. */
    caps?: string[];
    /** SPEC-037-5-04 — install/availability state driving the action footer. */
    status?: "available" | "not-installed" | string;
}

// SPEC-036-4-03 — per-repo trust override.
export interface TrustOverride {
    repo: string;
    /** Trust level (`L0`/`L1`/`L2`/`L3`) or `inherit`. */
    level: "L0" | "L1" | "L2" | "L3" | "inherit";
    source: string;
    immutable?: boolean;
}

// SPEC-036-4-04 — cost cap configuration.
export interface CostCaps {
    perRequest: number;
    daily: number;
    monthly: number;
}

// SPEC-036-4-05 — repo allowlist entry.
export interface AllowlistEntry {
    id: string;
    path: string;
    status: "ok" | "missing" | "not-a-repo";
    /** ISO-8601 timestamp. */
    addedAt: string;
}

// SPEC-036-4-06 — notifications config.
export type NotifyDefault = "discord" | "slack" | "both" | "none";
export type WebhookTestStatus = "ok" | "warn" | "err" | "muted";

export interface NotificationsConfig {
    discordWebhook: string;
    slackWebhook: string;
    discordStatus: WebhookTestStatus;
    slackStatus: WebhookTestStatus;
    notifyDefault: NotifyDefault;
    dndEnabled: boolean;
    /** `HH:MM` 24-hour format. */
    dndStart: string;
    dndEnd: string;
}

// SPEC-036-4-04 — current spend snapshot for informational display.
export interface CurrentSpend {
    today: number;
    month: number;
}

// SPEC-036-4 — Settings page data model.
// SPEC-037-5 — extends with `dailyCap`, `defaultVariant`, `defaultBackend`
// for the rebuilt General tab + Variants/Backends "Set default" actions.
// All new fields are optional; the General panel falls back to
// `costCaps.daily` / the first variant / the first available backend.
/** Real request type from the daemon's config/request-types.json
 *  (crawl p9/p10: replaces the kit-fixture "pipeline variants"). */
export interface RequestTypeInfo {
    id: string;
    description: string;
    defaultCostCapUsd: number | null;
    defaultTrustThreshold: number | null;
    defaultReviewers: string[];
}

export interface SettingsData {
    activeTab: TabId;
    trustLevel: "L0" | "L1" | "L2" | "L3";
    trustOverrides: TrustOverride[];
    allowlist: AllowlistEntry[];
    costCaps: CostCaps;
    /** False = costCaps are the daemon's defaults, not saved config (#393). */
    capsFromConfig?: boolean;
    currentSpend: CurrentSpend;
    notifications: NotificationsConfig;
    variants: PipelineVariant[];
    /** Real request types (daemon config) — renders the Variants tab. */
    requestTypes?: RequestTypeInfo[];
    standards: StandardRule[];
    backends: DeployBackend[];
    agents: AgentRecord[];
    /** Real agent rows (same reader as /agents) — renders the Agents tab.
     *  Typed loosely here to avoid a cross-module type cycle; the shape
     *  is AgentStateRow from wiring/agent-states-reader. */
    agentRows?: Array<{
        name: string;
        version: string;
        status: string;
    }>;
    /** SPEC-037-5-02 — flat numeric cap rendered in `.input-row`. */
    dailyCap?: number;
    /** SPEC-037-5-02 / 037-5-03 — currently-default variant id. */
    defaultVariant?: string;
    /** SPEC-037-5-02 / 037-5-04 — currently-default backend id. */
    defaultBackend?: string;
    /** CSRF token for form submissions */
    csrfToken?: string;
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
    /** Monthly budget; null = no cap configured (#396: never invent one). */
    budgetUsd: number | null;
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
    /** Monthly cost cap in USD; null = no cap configured (#396). */
    costCap?: number | null;
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

/**
 * Production-intelligence (observe-loop) summary surfaced on Ops (#562 / FR-938).
 * Reflects the LAST observe cycle the runner persisted to
 * `production-intelligence.json`; counts are per-run, not cumulative.
 */
export interface ProductionIntelligenceState {
    /** Run id of the last observe cycle (e.g. "RUN-20260621-040000"). */
    lastRunId: string | null;
    /** ISO timestamp the last cycle completed. */
    lastRunAt: string | null;
    /** Number of services scanned in the last cycle. */
    servicesScanned: number;
    /** Observations generated in the last cycle. */
    observationsGenerated: number;
    /** Observations filtered out (false-positives) in the last cycle. */
    observationsFiltered: number;
    /** Triage decisions processed in the last cycle. */
    triageProcessed: number;
    /** Number of errors recorded in the last cycle. */
    errorCount: number;
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
    /** Production-intelligence (observe-loop) last-run summary (#562 / FR-938). */
    productionIntelligence?: ProductionIntelligenceState;
    /** Relative time since the last daemon heartbeat ("3s ago", "—").
     *  Replaces the old `uptime` label, which rendered the string
     *  "alive" in a duration field — heartbeat.json has no start time,
     *  so true uptime is underivable (crawl p6). */
    lastHeartbeat?: string;
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

/**
 * PLAN-Requests-Surface §RequestsAggregates — pre-computed counts &
 * totals threaded into the `/requests` view so the KPI strip never has
 * to recompute from `items`. Mirrors the pattern used by
 * `DashboardAggregatesProp`.
 */
export interface RequestsAggregatesProp {
    activeCount: number;
    inGateCount: number;
    completedTodayCount: number;
    totalCostMtdUsd: number;
}

export interface RenderProps {
    dashboard: { data: DashboardData; aggregates: DashboardAggregatesProp };
    "request-detail": { request: RequestRecord; csrfToken?: string };
    requests: {
        items: DashboardRequest[];
        aggregates: RequestsAggregatesProp;
    };
    approvals: {
        items: ApprovalItem[];
        costCapDailyUsd: number;
        /** When set, overrides the default first-row selection. Threaded
         *  from `?selected=` query param so HTMX row clicks survive polls. */
        selectedId?: string;
        /** CSRF token for the approve/reject/bulk actions (#391). */
        csrfToken?: string;
        /** #429 — active tab (pending/approved/rejected). Default "pending". */
        tab?: ApprovalsTab;
        /** #429 — decided gates for the Approved/Rejected tabs. Real data
         *  from the gate-decisions store; empty when none decided yet. */
        history?: GateHistoryItem[];
        /** #429 — 7-day gate-stats summary. `null`/absent = honest empty. */
        gateStats?: GateStats7d | null;
    };
    settings: { config: SettingsView; data?: SettingsData };
    costs: {
        series: CostSeries;
        /** SPEC-036-2-03 — pre-computed by the route handler. */
        projection?: import("../lib/costs-projection").ProjectionResult;
    };
    logs: {
        lines: LogLine[];
        /**
         * When true, the log read failed server-side and `lines` is empty or
         * stale. `LiveLog` renders a dedicated `.l-err` system row so the user
         * sees an honest signal rather than a blank terminal or fabricated data.
         */
        readError?: boolean;
    };
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
        /** Daemon-applied config changes (#396) — separate from the HMAC chain. */
        configChanges?: Array<{ id: string; actor: string; ts: string; summary: string }>;
        /** Active tab (crawl p11 round 4): "chain" | "config". */
        activeTab?: string;
    };
    "404": { path: string };
    "500": { message: string };
    // PLAN-038 TASK-007 — Agents surface input. See AgentsPageData below.
    agents: AgentsPageData;
    // PLAN-038 TASK-007 — Repos surface input. See ReposPageData below.
    repos: ReposPageData;
    // ONBOARD Phase 3 (#594) — org/project/repo browser. See OnboardPageData below.
    onboard: OnboardPageData;
}

// ONBOARD Phase 3 (#594) — browser surface data shape. Composed by the route
// from onboard-readers (ownership + questions + memory + ingestion status).

export interface OnboardProjectRow {
    id: string;
    name: string;
    tags: Record<string, string>;
    repoCount: number;
}

export interface OnboardRepoRow {
    id: string;
    projectId: string | null;
    tags: Record<string, string>;
    /** participate_in_auto_improvement === true. */
    enrolled: boolean;
    /** has a pending blocking question. */
    blocked: boolean;
    /** memory topic names (chips). */
    topics: string[];
}

export interface MemoryTopicProp {
    topic: string;
    summary: string;
}

export interface OnboardIngestionStatusProp {
    reposTotal: number;
    reposWithMemory: number;
    reposBlocked: number;
    questionsPending: number;
    proposalsPending: number;
}

export interface OnboardPageData {
    org: string | null;
    projects: OnboardProjectRow[];
    /** the current page of (filtered) repos. */
    repos: OnboardRepoRow[];
    filter: { project?: string; tag?: string; q?: string };
    page: number;
    pageSize: number;
    totalRepos: number;
    totalPages: number;
    status: OnboardIngestionStatusProp;
    /** CSRF token for the enrollment toggle (wired in P3.5). */
    csrfToken?: string;
}

// PLAN-038 TASK-007 / TDD-037 §5.1.1a — Agents surface data shape.
//
// `agent-states.json` (daemon-side, see plugins/autonomous-dev/bin/agent-cli.ts)
// only tracks `{frozen[], shadowed[]}` — none of the rich metrics the kit
// screenshot implies (runs30d, fpRate, lastDispatchAt) are persisted today.
// Those fields are therefore OPTIONAL on AgentRow; the view renders `—` when
// absent. The canonical agent list comes from scanning the plugin's
// `agents/*.md` manifest directory (TASK-010 wires this composition).
export interface AgentRow {
    /** Agent name (matches the markdown file basename in `agents/`). */
    name: string;
    /** Plugin version that ships this agent (from `.claude-plugin/plugin.json`). */
    version: string;
    /** Lifecycle state. Default `"baseline"` when the agent is in neither the
     *  frozen nor shadowed list. */
    status: "baseline" | "frozen" | "shadow" | "promoted";
    /** Operator-facing mode. Currently always `"active"`; reserved for future
     *  per-agent enable/disable flags. */
    mode: "active" | "disabled";
    /** ISO 8601 of last dispatch. `null` when the daemon hasn't recorded one
     *  (or doesn't track this field at all on this install). */
    lastDispatchAt?: string | null;
    /** Run count in the trailing 30 days. `null` when not tracked. */
    runs30d?: number | null;
    /** Fraction in `[0, 1]` of runs that returned a blocking finding that
     *  was later overridden. `null` when not tracked. */
    fpRate?: number | null;
}

export interface AgentsPageData {
    kpis: {
        totalAgents: number;
        frozenCount: number;
        shadowCount: number;
    };
    agents: AgentRow[];
}

// PLAN-038 TASK-007 / TDD-037 §5.1.1a — Repos surface data shape.
//
// Composes the portal-settings allowlist + per-repo aggregates from the
// request ledger (TASK-010 composition reader). Re-uses the existing
// `RepoSummary` interface above for the row shape (Agent 2's recommendation:
// extend, don't fork).
export interface ReposPageData {
    kpis: {
        totalRepos: number;
        /** Repos with at least one RUNNING or GATE request. */
        activeRepos: number;
        /** Allowlist entries whose path does not resolve on disk. */
        /** Repos seen in request history that are NOT allowlisted
         *  (matches the table badges). Replaces `allowlistMisses`,
         *  which was hardcoded 0 (crawl p7). */
        notInAllowlist: number;
    };
    /** Full repo list, not truncated (the dashboard repos grid pulls a
     *  subset; the `/repos` surface always shows everything). */
    repos: RepoSummary[];
}
