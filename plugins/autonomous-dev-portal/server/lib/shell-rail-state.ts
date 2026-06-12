// SPEC-037-3-05 §deriveShellRailState — server-side state derivation for
// the portal's rail (`<ShellLayout>`) chrome.
//
// Reads heartbeat + cost-ledger + approvals queue from disk once per
// `renderFullPage` invocation and returns a flat `ShellRailState` ready
// to spread onto `<ShellLayout>`. Each source is wrapped in its own
// try/catch so a failure in one (e.g. malformed cost ledger) yields
// `undefined` for those fields without taking down the page.
//
// Homelab is intentionally NOT consulted here (SPEC-037-3-05 §Objective):
// when the planned portal-plugin-contribution mechanism lands, the
// `autonomous-dev-homelab` plugin will own its own state derivation and
// nav entry. Portal core stays Homelab-free.
//
// Caching:
//   - `getCachedHeartbeat()` wraps `readDaemonStatus()` with a 5_000 ms
//     in-memory TTL keyed by `AUTONOMOUS_DEV_STATE_DIR`. Two
//     `renderFullPage` calls within the TTL share a single disk read
//     (SR-03 in the test plan).
//   - Cost / approvals reads are NOT cached here — those sources already
//     have their own readers (CostReader / approvals routes) with their
//     own cache strategies, and the rail derivation only needs a quick
//     snapshot.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { readDaemonStatus, type DaemonStatus } from "./daemon-status";

/**
 * SPEC-037-3-05 AC-02 — flat state shape derived once per render.
 *
 * All fields are independently optional so a callsite can supply just
 * the slice it cares about (used by tests) and missing sources do not
 * cascade-fail the whole render. Field names match the matching
 * `ShellProps` keys exactly so spread propagation is mechanical.
 */
export interface ShellRailState {
    daemonStatus?: "running" | "stale" | "down" | "unknown";
    daemonAgeSeconds?: number;
    breakerState?: "OK" | "TRIPPED" | "unknown";
    breakerCount?: number;
    breakerThreshold?: number;
    mtdSpend?: number;
    mtdPctOfCap?: number;
    killSwitchEngaged?: boolean;
    approvalsCount?: number;
    requestsCount?: number;
    agentsAlertCount?: number;
}

const HEARTBEAT_TTL_MS = 5_000;

interface HeartbeatCacheEntry {
    expiresAt: number;
    value: DaemonStatus;
}

// Module-level cache keyed by resolved state dir. Each test using a
// different `AUTONOMOUS_DEV_STATE_DIR` gets its own slot, so suite-to-
// suite isolation is preserved without manual cache resets.
const heartbeatCache = new Map<string, HeartbeatCacheEntry>();

/**
 * Resolve the state dir the same way `daemon-status.ts` does. Kept in
 * sync so the cache key matches the file location actually read.
 */
function resolveStateDir(): string {
    const override = process.env["AUTONOMOUS_DEV_STATE_DIR"];
    if (override !== undefined && override.length > 0) {
        return override;
    }
    return join(homedir(), ".autonomous-dev");
}

/** Test-only hook: clears the heartbeat cache between specs. */
export function __resetShellRailStateCacheForTests(): void {
    heartbeatCache.clear();
}

async function getCachedHeartbeat(now: number): Promise<DaemonStatus> {
    const key = resolveStateDir();
    const cached = heartbeatCache.get(key);
    if (cached !== undefined && cached.expiresAt > now) {
        return cached.value;
    }
    const fresh = await readDaemonStatus();
    heartbeatCache.set(key, {
        expiresAt: now + HEARTBEAT_TTL_MS,
        value: fresh,
    });
    return fresh;
}

/**
 * SPEC-037-3-05 AC-04 — daemon-status enum mapping.
 *
 * `fresh → running`, `stale → stale`, `dead → down`. `dead` is the
 * union of "heartbeat file missing" and "heartbeat > 5min stale", both
 * of which surface to the operator as "down" in the rail.
 */
function mapDaemonStatus(s: DaemonStatus["status"]): ShellRailState["daemonStatus"] {
    switch (s) {
        case "fresh":
            return "running";
        case "stale":
            return "stale";
        case "dead":
            return "down";
        default:
            return "unknown";
    }
}

interface ParsedCostLedger {
    total_usd?: number;
    daily_usd?: Record<string, number>;
}

/**
 * Read the month-to-date spend from the cost ledger. The ledger lives
 * at `<state-dir>/cost-ledger.json` and follows the schema produced by
 * `server/cost/aggregator.ts`. Sum the entries whose date key starts
 * with the current year-month (YYYY-MM-) prefix.
 *
 * Returns `undefined` on any read/parse failure (caller surfaces this
 * as "no MTD row" rather than "$0.00").
 */
async function readMtdSpend(now: number): Promise<number | undefined> {
    try {
        const path = join(resolveStateDir(), "cost-ledger.json");
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as ParsedCostLedger;
        const daily = parsed.daily_usd;
        if (daily === null || daily === undefined || typeof daily !== "object") {
            // Fall back to top-level total if daily breakdown is missing.
            return typeof parsed.total_usd === "number" ? parsed.total_usd : undefined;
        }
        const d = new Date(now);
        const prefix = `${d.getUTCFullYear()}-${String(
            d.getUTCMonth() + 1,
        ).padStart(2, "0")}-`;
        let mtd = 0;
        for (const [day, amount] of Object.entries(daily)) {
            if (day.startsWith(prefix) && typeof amount === "number") {
                mtd += amount;
            }
        }
        return mtd;
    } catch {
        return undefined;
    }
}

/**
 * Read the configured monthly cap (USD) from the cost-cap config. Returns
 * `undefined` when the file is missing — `mtdPctOfCap` then collapses to
 * `undefined` rather than divide-by-zero.
 */
async function readMonthlyCap(): Promise<number | undefined> {
    try {
        const path = join(resolveStateDir(), "cost-cap.json");
        const raw = await readFile(path, "utf8");
        const parsed = JSON.parse(raw) as { monthly_usd?: number };
        return typeof parsed.monthly_usd === "number" && parsed.monthly_usd > 0
            ? parsed.monthly_usd
            : undefined;
    } catch {
        return undefined;
    }
}

interface ApprovalQueueFile {
    pending?: unknown[];
    active?: unknown[];
    agents?: unknown[];
}

/**
 * PLAN-038 TASK-018/019 — read counts from the SAME readers the
 * destination surfaces use, so the rail-nav badges and the surface KPIs
 * cannot disagree (TDD-037 §5.1.3 honesty contract).
 *
 *   /approvals KPI  ← readApprovalsQueue().items.length
 *   /requests  KPI  ← readRequestLedger() filtered by status
 *   /agents    KPI  ← readAgentsData().kpis.totalAgents
 *
 * Previously this read a separate `approvals.json` file with a different
 * schema (`{pending[], active[], agents[]}`); that file doesn't exist on
 * any real install and the counts diverged from the surface KPIs.
 */
async function readQueueCounts(): Promise<{
    approvalsCount?: number;
    requestsCount?: number;
    agentsAlertCount?: number;
}> {
    // Imports kept local to avoid widening the module's eager dep graph;
    // the readers are async and only touched when rail-state derives.
    const { readApprovalsQueue } = await import(
        "../wiring/approvals-reader"
    );
    const { readRequestLedger } = await import(
        "../wiring/request-ledger-reader"
    );
    const { readAgentsData } = await import("../wiring/agents-readers");

    const [approvals, requests, agents] = await Promise.all([
        readApprovalsQueue().catch(() => ({ items: [] as never[] })),
        readRequestLedger().catch(() => [] as never[]),
        readAgentsData().catch(() => ({
            kpis: { totalAgents: 0, frozenCount: 0, shadowCount: 0 },
            agents: [],
        })),
    ]);

    const activeRequests = requests.filter(
        (r) => r.status === "running" || r.status === "gate",
    );

    return {
        approvalsCount: approvals.items.length,
        requestsCount: activeRequests.length,
        agentsAlertCount: agents.kpis.totalAgents,
    };
}

/**
 * SPEC-037-3-05 — derive the full rail state from disk sources.
 *
 * Each source is wrapped independently — a failure in one yields
 * `undefined` for its fields without affecting the others (AC-02).
 *
 * @param nowMs Optional clock injection for deterministic tests. Defaults
 *              to `Date.now()`.
 */
export async function deriveShellRailState(
    nowMs: number = Date.now(),
): Promise<ShellRailState> {
    const state: ShellRailState = {};

    // Source 1: heartbeat (daemon + kill-switch).
    try {
        const hb = await getCachedHeartbeat(nowMs);
        state.daemonStatus = mapDaemonStatus(hb.status);
        if (hb.last_seen !== null) {
            const lastSeenMs = Date.parse(hb.last_seen);
            if (!Number.isNaN(lastSeenMs)) {
                state.daemonAgeSeconds = Math.max(
                    0,
                    Math.floor((nowMs - lastSeenMs) / 1000),
                );
            }
        }
        // #396: the heartbeat has NO kill_switch_active field — the daemon's
        // signal is the kill-switch.flag FILE (existence-only). Reading the
        // phantom field meant the rail could never render the engaged state.
        try {
            await readFile(join(resolveStateDir(), "kill-switch.flag"), "utf8");
            state.killSwitchEngaged = true;
        } catch {
            state.killSwitchEngaged = false;
        }
    } catch {
        state.daemonStatus = "unknown";
    }

    // Source 2: cost ledger (MTD spend + % of cap).
    try {
        const mtd = await readMtdSpend(nowMs);
        if (mtd !== undefined) {
            state.mtdSpend = mtd;
            const cap = await readMonthlyCap();
            if (cap !== undefined) {
                state.mtdPctOfCap = Math.round((mtd / cap) * 100);
            }
        }
    } catch {
        // Leave mtd fields undefined; rail-ops omits the MTD row entirely.
    }

    // Source 3: approvals queue (3 counts).
    try {
        const counts = await readQueueCounts();
        if (counts.approvalsCount !== undefined)
            state.approvalsCount = counts.approvalsCount;
        if (counts.requestsCount !== undefined)
            state.requestsCount = counts.requestsCount;
        if (counts.agentsAlertCount !== undefined)
            state.agentsAlertCount = counts.agentsAlertCount;
    } catch {
        // All three remain undefined → no badges render. RailNav handles
        // that as the "no badge" branch (SPEC-037-3-02 AC-03).
    }

    // Source 4 (#396): circuit-breaker state from the daemon's
    // crash-state.json — {consecutive_crashes, circuit_breaker_tripped}.
    // The rail previously showed a permanent "Breaker unknown --/--"
    // although the daemon has always written this file.
    try {
        const breaker = await readBreakerState();
        if (breaker !== undefined) {
            state.breakerState = breaker.tripped ? "TRIPPED" : "OK";
            state.breakerCount = breaker.count;
            state.breakerThreshold = breaker.threshold;
        }
    } catch {
        // Leave undefined → muted dot + `--/--` (honest unknown).
    }

    return state;
}

interface CrashStateFile {
    consecutive_crashes?: number;
    circuit_breaker_tripped?: boolean;
}

/**
 * Read circuit-breaker state from `crash-state.json` (#396). Threshold
 * comes from the user config's `daemon.circuit_breaker_threshold`,
 * falling back to the daemon's shipped default (3, config_defaults.json).
 */
async function readBreakerState(): Promise<
    { tripped: boolean; count: number; threshold: number } | undefined
> {
    try {
        const raw = await readFile(
            join(resolveStateDir(), "crash-state.json"),
            "utf8",
        );
        const parsed = JSON.parse(raw) as CrashStateFile;
        if (typeof parsed.circuit_breaker_tripped !== "boolean") return undefined;
        let threshold = 3; // daemon shipped default
        try {
            const cfgRaw = await readFile(
                join(homedir(), ".claude", "autonomous-dev.json"),
                "utf8",
            );
            const cfg = JSON.parse(cfgRaw) as {
                daemon?: { circuit_breaker_threshold?: number };
            };
            if (typeof cfg.daemon?.circuit_breaker_threshold === "number") {
                threshold = cfg.daemon.circuit_breaker_threshold;
            }
        } catch {
            /* keep default */
        }
        return {
            tripped: parsed.circuit_breaker_tripped,
            count: typeof parsed.consecutive_crashes === "number"
                ? parsed.consecutive_crashes
                : 0,
            threshold,
        };
    } catch {
        return undefined;
    }
}
