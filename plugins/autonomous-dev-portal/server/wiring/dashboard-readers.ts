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
// FR-026-10..15 (v3 hero): additive exports for swimlane grouping and the
// 14-day cost series. #389: the v3 hero renders ONLY real data or honest
// empty states — the deterministic seeded demo builders (cost bars,
// activity feed, agent grid, fake swimlane cards) are gone; fabricated
// data rendered as live telemetry misleads operators.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DashboardData, RepoSummary } from "../types/render";

import {
    readRepoAggregates,
    type RepoAggregationOptions,
} from "./repo-aggregation-reader";
import {
    readPortalSettings,
    type SettingsReaderOptions,
} from "./settings-reader";
import { stateDirRoot } from "./state-paths";

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
 * When no requests are active, every lane is returned empty — the view
 * renders an honest "pipeline idle" state (#389: never fabricate cards).
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

    // No active requests: return empty lanes (honest idle state, #389).
    return PHASE_KEYS.map((pk) => ({
        phase: pk,
        label: PHASE_LABELS[pk],
        cards: [],
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

/** 14-day cost bars. `segs` is null when the ledger has no per-phase data. */
export interface DayCostBar {
    /** Day index 0 (oldest) → 13 (today). */
    day: number;
    /** Per-phase cost in USD; null = attribution not recorded by the ledger. */
    segs: Record<PhaseKey, number> | null;
    total: number;
}

/**
 * Read the REAL last-14-day daily cost series from the daemon's cost
 * ledger (#389 — previously this was a seeded fabrication). The ledger
 * records per-request sessions, not per-phase costs, so `segs` is null
 * and the chart renders single-tone bars. Missing/corrupt ledger → 14
 * zero days (honest empty, never invented).
 */
export async function read14DayCostBars(ledgerPath?: string): Promise<DayCostBar[]> {
    const path = ledgerPath ?? join(stateDirRoot(), "cost-ledger.json");
    let daily: Record<string, { total_usd?: number }> = {};
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as {
            daily?: Record<string, { total_usd?: number }>;
        };
        if (parsed.daily && typeof parsed.daily === "object") daily = parsed.daily;
    } catch {
        // absent/corrupt ledger → all-zero series
    }
    const out: DayCostBar[] = [];
    const now = new Date();
    for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.UTC(
            now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i,
        ));
        const key = d.toISOString().slice(0, 10);
        const t = daily[key]?.total_usd;
        out.push({ day: 13 - i, segs: null, total: typeof t === "number" && t > 0 ? t : 0 });
    }
    return out;
}

/**
 * Read the configured monthly cost cap from the daemon's cost-cap config
 * (#389). Returns null when no cap is configured — the KPI then renders
 * "no cap configured" instead of inventing one (the old code hardcoded
 * $400, which exists nowhere).
 */
export async function readMonthlyCapUsd(capPath?: string): Promise<number | null> {
    try {
        const path = capPath ?? join(stateDirRoot(), "cost-cap.json");
        const parsed = JSON.parse(await readFile(path, "utf8")) as {
            monthly_usd?: number;
        };
        return typeof parsed.monthly_usd === "number" && parsed.monthly_usd > 0
            ? parsed.monthly_usd
            : null;
    } catch {
        return null;
    }
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

// #389: buildAgentUtilRows() (9 hardcoded fake agents), buildActivityFeed()
// (10 fixed rows), and the seeded sparkline/PRNG helpers are intentionally
// gone. The daemon records no per-agent utilization or event stream yet —
// those panels render honest empty states until a real source exists (see
// issue #394 for the /agents reader). ActivityRow/AgentUtilRow types stay
// exported for the view contract.
