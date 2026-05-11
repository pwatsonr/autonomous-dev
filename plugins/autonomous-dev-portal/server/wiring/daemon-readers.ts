// Real daemon-state readers for the portal's /api/daemon-status endpoint
// and rail-ops indicators.
//
// Replaces the inline 0/0/false stubs previously hardcoded in server.ts.
// Each reader consumes a file the supervisor daemon writes:
//
//   readMtdSpend()             ~/.autonomous-dev/cost-ledger.json
//   readApprovalsCount()       ~/.autonomous-dev/approvals-queue.json
//   readKillSwitchEngaged()    ~/.autonomous-dev/kill-switch.flag
//
// Contract for every reader:
//   - Never throws. Any I/O / parse / schema error falls back to the
//     sensible default (0, 0, or false). The daemon-status route already
//     logs WARNs when these reject (via Promise.allSettled), but defending
//     in depth keeps the route's response shape stable.
//   - Caches the last-good value for 5s to avoid disk hits on every
//     rail-ops poll (which fires every 5s per fragment hx-trigger).
//
// Cost-ledger schema (per `bin/supervisor-loop.sh` § update_cost_ledger):
//   {
//     "daily": {
//       "YYYY-MM-DD": { "total_usd": number, "sessions": [...] }
//     }
//   }
// MTD = sum of `daily[k].total_usd` for keys starting with `YYYY-MM` (UTC).

import { promises as fs } from "node:fs";
import { join } from "node:path";

import { readJsonOrNull } from "./atomic-json";
import { approvalsQueuePath, stateDirRoot } from "./state-paths";

const CACHE_TTL_MS = 5_000;

/** Path to the daemon's cost ledger. Honors AUTONOMOUS_DEV_STATE_DIR. */
export function costLedgerPath(): string {
    return join(stateDirRoot(), "cost-ledger.json");
}

/** Path to the kill-switch flag. Existence-only signal; contents ignored. */
export function killSwitchFlagPath(): string {
    return join(stateDirRoot(), "kill-switch.flag");
}

/**
 * On-disk shape of `cost-ledger.json`. The daemon-side writer (Bash + jq)
 * is the source of truth; this type captures only the fields we read.
 */
interface CostLedgerFile {
    daily?: Record<string, { total_usd?: number } | undefined>;
}

interface ApprovalsQueueFile {
    items?: Array<{ state?: string } | undefined>;
}

interface CacheEntry<T> {
    value: T;
    expiresAt: number;
}

/**
 * 5s in-memory cache shared across readers. Each reader owns its own key so
 * a failure in one source does not poison the others.
 */
class ReaderCache {
    private readonly entries = new Map<string, CacheEntry<unknown>>();

    get<T>(key: string, now: number): T | undefined {
        const hit = this.entries.get(key);
        if (hit === undefined) return undefined;
        if (hit.expiresAt <= now) {
            this.entries.delete(key);
            return undefined;
        }
        return hit.value as T;
    }

    set<T>(key: string, value: T, now: number): void {
        this.entries.set(key, { value, expiresAt: now + CACHE_TTL_MS });
    }

    /** Test hook — clears all cached values. Production code should not call this. */
    clear(): void {
        this.entries.clear();
    }
}

const cache = new ReaderCache();

/** Test-only helper. Exported so unit tests can isolate cache state. */
export function __resetDaemonReaderCacheForTests(): void {
    cache.clear();
}

/**
 * Compute the current month key (`YYYY-MM`) in UTC. Matches the daemon's
 * `date -u +"%Y-%m"` used inside `check_cost_caps`, so the portal and the
 * daemon agree on month boundaries to the second.
 */
function currentMonthKeyUtc(now: number): string {
    const d = new Date(now);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${String(y)}-${m}`;
}

/**
 * Month-to-date spend in USD. Returns 0 on any error (missing file, parse
 * failure, schema surprise) — `/api/daemon-status` already surfaces a WARN
 * log when this rejects, and the rail-ops pill prefers a stable 0 over a
 * 500 response.
 */
export async function readMtdSpend(now: () => number = Date.now): Promise<number> {
    const t = now();
    const cached = cache.get<number>("mtd-spend", t);
    if (cached !== undefined) return cached;

    let value = 0;
    try {
        const file = await readJsonOrNull<CostLedgerFile>(costLedgerPath());
        if (file !== null && file.daily !== undefined && file.daily !== null) {
            const month = currentMonthKeyUtc(t);
            let total = 0;
            for (const [day, bucket] of Object.entries(file.daily)) {
                if (!day.startsWith(month)) continue;
                if (bucket === undefined || bucket === null) continue;
                const usd = bucket.total_usd;
                if (typeof usd === "number" && Number.isFinite(usd)) {
                    total += usd;
                }
            }
            value = total;
        }
    } catch {
        // Swallow — defaults to 0. The route handler logs partial failures
        // already via Promise.allSettled, but readers never throw.
        value = 0;
    }

    cache.set("mtd-spend", value, t);
    return value;
}

/**
 * Count of pending approval gates. Reads the same queue file as
 * `FileApprovalsStore`; we duplicate the lightweight count rather than
 * instantiating the store to avoid the JSX/render imports for a number.
 */
export async function readApprovalsCount(now: () => number = Date.now): Promise<number> {
    const t = now();
    const cached = cache.get<number>("approvals-count", t);
    if (cached !== undefined) return cached;

    let value = 0;
    try {
        const file = await readJsonOrNull<ApprovalsQueueFile>(approvalsQueuePath());
        if (file !== null && Array.isArray(file.items)) {
            value = file.items.filter((it) => {
                if (it === undefined || it === null) return false;
                const state = it.state ?? "pending";
                return state === "pending";
            }).length;
        }
    } catch {
        value = 0;
    }

    cache.set("approvals-count", value, t);
    return value;
}

/**
 * Kill-switch engaged signal. The daemon's `kill-switch` CLI writes
 * `${state_dir}/kill-switch.flag`; existence is the signal (the daemon's
 * gate check uses `[[ -f ... ]]`).
 */
export async function readKillSwitchEngaged(
    now: () => number = Date.now,
): Promise<boolean> {
    const t = now();
    const cached = cache.get<boolean>("kill-switch", t);
    if (cached !== undefined) return cached;

    let value = false;
    try {
        await fs.access(killSwitchFlagPath());
        value = true;
    } catch {
        // ENOENT (and any other access failure) → engaged=false. We
        // intentionally treat permission errors as not-engaged because the
        // alternative — surfacing a falsely engaged kill switch in the
        // rail-ops — is more alarming than silently degrading to "off".
        value = false;
    }

    cache.set("kill-switch", value, t);
    return value;
}
