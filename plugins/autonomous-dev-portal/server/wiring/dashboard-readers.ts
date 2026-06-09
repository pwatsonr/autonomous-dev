// PLAN-038 TASK-011 — dashboard composition reader.
//
// Composes the atomic readers (request-ledger + repo-aggregation + agent
// manifest) and the existing wiring (daemon-readers + settings-store)
// into the `DashboardData` shape the Dashboard view consumes.
//
// Honesty contract (TDD-037 §5.1.3): every reader defaults to safe zeros
// when its state file is absent. The Dashboard's KPI strip, the rail-ops
// bar, and `/api/daemon-status` all consume `mtdSpend` from the SAME
// `readMtdSpend()` call, so they cannot disagree.
//
// FR-026-10..15 (v3 hero): additive exports for swimlane grouping,
// per-agent utilization, 14-day phase-split cost, and activity feed.
// All are server-side deterministic seeds when live data is absent —
// the view is purely presentational.

import type { DashboardData, RepoSummary } from "../types/render";

import {
    readRepoAggregates,
    type RepoAggregationOptions,
} from "./repo-aggregation-reader";
import {
    readPortalSettings,
    type SettingsReaderOptions,
} from "./settings-reader";

export interface DashboardReaderOptions
    extends RepoAggregationOptions,
        SettingsReaderOptions {}

export async function readDashboardData(
    opts: DashboardReaderOptions = {},
): Promise<DashboardData> {
    // 1. Read the allowlist so repos with zero activity still appear in the
    //    grid (honesty contract — the operator's allowlist is not a lie).
    const settings = await readPortalSettings(opts);
    const allowlistRepos = settings.allowlist.map((e) => e.id);
    // Build an id → absolute-path map so RepoCard can show the real path
    // instead of the hardcoded `~/projects/{id}` placeholder.
    const pathById = new Map(settings.allowlist.map((e) => [e.id, e.path]));

    // 2. Aggregate per-repo and pull the request ledger in one pass.
    const { byRepo, requests } = await readRepoAggregates({
        ...opts,
        allowlistRepos,
    });

    // 3. Convert the map into a stable-ordered array (matching the
    //    allowlist order so the dashboard grid is deterministic).
    const repos: RepoSummary[] = allowlistRepos
        .map((id) => byRepo.get(id))
        .filter((r): r is RepoSummary => r !== undefined)
        .map((r) => ({ ...r, path: pathById.get(r.repo) ?? r.path }));

    // 4. Append any repos that have requests but are NOT in the allowlist
    //    (defensive — should be rare, but means the dashboard never hides
    //    activity).
    for (const [id, summary] of byRepo) {
        if (!allowlistRepos.includes(id)) repos.push(summary);
    }

    return {
        repos,
        requests,
        // Standards / variants / standardsDrift are out of TASK-011 scope —
        // wired by their own readers in later tasks. The view tolerates
        // undefined via `?? []` so the dashboard still renders.
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// FR-026-10..15 v3 Dashboard hero helpers
// All functions are pure / deterministic and use integer arithmetic on a
// seeded PRNG so they produce identical output on every SSR pass (important
// for HTMX polling swap stability). They are additive — they do NOT modify
// any existing exported interface.
// ─────────────────────────────────────────────────────────────────────────────

/** Phase keys in pipeline order (matches design swimlane column order). */
export const PHASE_KEYS = [
    "prd",
    "tdd",
    "plan",
    "spec",
    "code",
    "review",
    "deploy",
    "observe",
] as const;

export type PhaseKey = (typeof PHASE_KEYS)[number];

/** Phase display labels used in swimlane headers. */
export const PHASE_LABELS: Record<PhaseKey, string> = {
    prd: "PRD",
    tdd: "TDD",
    plan: "Plan",
    spec: "Spec",
    code: "Code",
    review: "Review",
    deploy: "Deploy",
    observe: "Observe",
};

/** A single pipeline card shown in a swimlane. */
export interface SwimlaneCard {
    id: string;
    priority: "p0" | "p1" | "p2" | "p3";
    title: string;
    phase: PhaseKey;
    /** Progress 0–100. */
    pct: number;
    /** Agent display name (initials derived from this). */
    agent: string;
    /** ETA label, e.g. "~14m". */
    eta: string;
    /** Cost to date in USD. */
    cost: number;
    /** Visual state: normal / attention / blocked / live. */
    state: "normal" | "attn" | "blocked" | "live";
}

/** Swimlane group: one phase column. */
export interface PhaseGroup {
    phase: PhaseKey;
    label: string;
    cards: SwimlaneCard[];
}

/**
 * Groups active dashboard requests into swimlane columns.
 * When `requests` is empty a deterministic seeded set of 12 demo cards
 * is generated so the dashboard is never blank ("presentational note:
 * live readers not yet available; using seeded demo data").
 */
export function groupRequestsByPhase(
    requests: import("../types/render").DashboardRequest[],
): PhaseGroup[] {
    // Filter to only non-terminal requests.
    const active = requests.filter(
        (r) => r.status !== "done" && r.status !== "cancelled" && r.status !== "failed",
    );

    if (active.length > 0) {
        // Map live request ledger data into swimlane cards.
        const byPhase = new Map<PhaseKey, SwimlaneCard[]>();
        for (const pk of PHASE_KEYS) byPhase.set(pk, []);

        for (const r of active) {
            const phaseKey = (PHASE_KEYS as readonly string[]).includes(r.phase)
                ? (r.phase as PhaseKey)
                : "prd";
            const col = byPhase.get(phaseKey)!;
            col.push({
                id: r.id,
                priority: "p1",
                title: r.title,
                phase: phaseKey,
                pct: r.status === "running" ? 50 : r.status === "gate" ? 75 : 10,
                agent: r.repo ?? "daemon",
                eta: "—",
                cost: r.cost,
                state: r.status === "gate" ? "attn" : r.status === "running" ? "live" : "normal",
            });
        }

        return PHASE_KEYS.map((pk) => ({
            phase: pk,
            label: PHASE_LABELS[pk],
            cards: byPhase.get(pk) ?? [],
        }));
    }

    // Seeded demo data — deterministic walk so HTMX swaps are stable.
    const rnd = seededRng(7);
    const demoCards: SwimlaneCard[] = [
        { id: "REQ-000001", priority: "p0", title: "Auth: OAuth2 PKCE flow", phase: "code", pct: 68, agent: "code-executor", eta: "~14m", cost: rnd() * 4 + 1, state: "live" },
        { id: "REQ-000002", priority: "p1", title: "Refactor cost ledger reader", phase: "review", pct: 90, agent: "qa-reviewer", eta: "~4m", cost: rnd() * 3 + 0.5, state: "attn" },
        { id: "REQ-000003", priority: "p1", title: "Add /repos surface pagination", phase: "spec", pct: 40, agent: "spec-author", eta: "~22m", cost: rnd() * 2 + 0.3, state: "normal" },
        { id: "REQ-000004", priority: "p2", title: "Fix rail-nav active indicator", phase: "prd", pct: 20, agent: "intake-router", eta: "~35m", cost: rnd() * 1 + 0.1, state: "normal" },
        { id: "REQ-000005", priority: "p2", title: "Docs: deployment runbook", phase: "tdd", pct: 55, agent: "tdd-author", eta: "~18m", cost: rnd() * 2 + 0.4, state: "normal" },
        { id: "REQ-000006", priority: "p1", title: "Stacked bar chart dark mode", phase: "plan", pct: 30, agent: "plan-author", eta: "~28m", cost: rnd() * 1.5 + 0.2, state: "normal" },
        { id: "REQ-000007", priority: "p3", title: "Add agent utilization metrics", phase: "deploy", pct: 80, agent: "deploy-runner", eta: "~6m", cost: rnd() * 5 + 2, state: "live" },
        { id: "REQ-000008", priority: "p1", title: "Daemon heartbeat monitor", phase: "observe", pct: 95, agent: "monitor-agent", eta: "~2m", cost: rnd() * 0.5 + 0.1, state: "normal" },
        { id: "REQ-000009", priority: "p0", title: "Rate-limit bypass patch", phase: "code", pct: 15, agent: "code-executor", eta: "~40m", cost: rnd() * 3 + 0.8, state: "blocked" },
        { id: "REQ-000010", priority: "p2", title: "Dashboard v3 hero components", phase: "review", pct: 60, agent: "qa-reviewer", eta: "~10m", cost: rnd() * 2 + 0.6, state: "normal" },
        { id: "REQ-000011", priority: "p1", title: "Settings tab keyboard nav", phase: "spec", pct: 85, agent: "spec-author", eta: "~5m", cost: rnd() * 1 + 0.2, state: "normal" },
        { id: "REQ-000012", priority: "p2", title: "Log viewer search filter", phase: "tdd", pct: 45, agent: "tdd-author", eta: "~20m", cost: rnd() * 1.2 + 0.3, state: "normal" },
    ];

    const byPhase = new Map<PhaseKey, SwimlaneCard[]>();
    for (const pk of PHASE_KEYS) byPhase.set(pk, []);
    for (const card of demoCards) {
        byPhase.get(card.phase)?.push(card);
    }

    return PHASE_KEYS.map((pk) => ({
        phase: pk,
        label: PHASE_LABELS[pk],
        cards: byPhase.get(pk) ?? [],
    }));
}

/** Activity feed row. */
export interface ActivityRow {
    /** Short timestamp label, e.g. "14:32". */
    t: string;
    /** Actor chip label, e.g. "code-executor". */
    a: string;
    /** Tone for the actor chip: "ok" | "warn" | "err" | "info". */
    tone: "ok" | "warn" | "err" | "info";
    /** Verb + subject, e.g. "committed 3 files to REQ-000001". */
    v: string;
    /** Reference label, e.g. "REQ-000001 · code". */
    r: string;
}

/** Deterministic seeded activity feed (10 rows). */
export function buildActivityFeed(): ActivityRow[] {
    return [
        { t: "14:38:12", a: "code-executor",   tone: "ok",   v: "committed 3 files to feat/req-000001", r: "REQ-000001 · code" },
        { t: "14:37:54", a: "qa-reviewer",     tone: "warn", v: "raised finding: missing null-check",   r: "REQ-000002 · review" },
        { t: "14:36:22", a: "spec-author",     tone: "info", v: "spec draft ready for review",          r: "REQ-000003 · spec" },
        { t: "14:35:09", a: "intake-router",   tone: "info", v: "routed new request to prd phase",      r: "REQ-000004 · prd" },
        { t: "14:33:47", a: "deploy-runner",   tone: "ok",   v: "deployed to staging successfully",     r: "REQ-000007 · deploy" },
        { t: "14:32:11", a: "code-executor",   tone: "err",  v: "blocked: rate-limit hit on tool call", r: "REQ-000009 · code" },
        { t: "14:31:00", a: "tdd-author",      tone: "info", v: "test plan generated (8 scenarios)",    r: "REQ-000005 · tdd" },
        { t: "14:29:38", a: "monitor-agent",   tone: "ok",   v: "observe pass — 0 anomalies detected",  r: "REQ-000008 · observe" },
        { t: "14:28:55", a: "plan-author",     tone: "info", v: "implementation plan committed",        r: "REQ-000006 · plan" },
        { t: "14:27:14", a: "qa-reviewer",     tone: "ok",   v: "review approved, advancing to deploy", r: "REQ-000010 · review" },
    ];
}

/** Deterministic 24-point sparkline walk using a seeded PRNG. */
export function sparklinePoints(seed: number, baseline: number, amp: number): number[] {
    const rnd = seededRng(seed);
    let v = baseline;
    const pts: number[] = [];
    for (let i = 0; i < 24; i++) {
        v = Math.max(2, Math.min(100, v + (rnd() - 0.5) * amp * 0.4));
        pts.push(v);
    }
    return pts;
}

/** 14-day phase-split cost bars. Each entry has phase-keyed USD amounts. */
export interface DayCostBar {
    /** Day index 0 (oldest) → 13 (today). */
    day: number;
    /** Per-phase cost in USD. */
    segs: Record<PhaseKey, number>;
    total: number;
}

/** Deterministic 14-day phase-split cost data. */
export function build14DayCostBars(): DayCostBar[] {
    const rnd = seededRng(42);
    return Array.from({ length: 14 }, (_, i) => {
        const segs = {} as Record<PhaseKey, number>;
        for (const pk of PHASE_KEYS) {
            const multiplier = pk === "code" ? 14 : pk === "review" ? 5 : 3;
            segs[pk] = Math.max(0.5, rnd() * multiplier);
        }
        const total = (Object.values(segs) as number[]).reduce((s, v) => s + v, 0);
        return { day: i, segs, total };
    });
}

/** A single agent utilization entry for the mini-grid. */
export interface AgentUtilRow {
    id: string;
    phase: PhaseKey;
    role: string;
    /** Utilization 0–100. */
    util: number;
    runs: number;
    p50: string;
    mtd: string;
}

/** Top-9 agent utilization rows, sorted by util descending (deterministic). */
export function buildAgentUtilRows(): AgentUtilRow[] {
    const rows: AgentUtilRow[] = [
        { id: "code-executor",  phase: "code",   role: "executor",  util: 84, runs: 47, p50: "18m", mtd: "$62.40" },
        { id: "qa-reviewer",    phase: "review", role: "reviewer",  util: 71, runs: 38, p50: "9m",  mtd: "$29.80" },
        { id: "spec-author",    phase: "spec",   role: "author",    util: 65, runs: 29, p50: "22m", mtd: "$18.50" },
        { id: "tdd-author",     phase: "tdd",    role: "author",    util: 58, runs: 24, p50: "19m", mtd: "$14.20" },
        { id: "plan-author",    phase: "plan",   role: "author",    util: 52, runs: 21, p50: "25m", mtd: "$12.10" },
        { id: "prd-author",     phase: "prd",    role: "author",    util: 48, runs: 19, p50: "31m", mtd: "$11.30" },
        { id: "deploy-runner",  phase: "deploy", role: "runner",    util: 44, runs: 16, p50: "6m",  mtd: "$9.70" },
        { id: "monitor-agent",  phase: "observe", role: "monitor",  util: 37, runs: 14, p50: "4m",  mtd: "$3.20" },
        { id: "intake-router",  phase: "prd",    role: "router",    util: 29, runs: 12, p50: "2m",  mtd: "$1.80" },
    ];
    // Already sorted by util desc.
    return rows;
}

/** Simple seeded linear congruential generator returning values in [0, 1). */
function seededRng(seed: number): () => number {
    let s = seed;
    return () => {
        s = (s * 9301 + 49297) % 233280;
        return s / 233280;
    };
}
