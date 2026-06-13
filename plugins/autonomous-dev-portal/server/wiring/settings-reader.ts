// PLAN-038 TASK-011 — portal settings reader (lightweight, read-only).
//
// Reads `~/.claude/autonomous-dev.json` (daemon config file). Maps from
// the daemon's nested shape to the view-model that settings.tsx expects.
// When absent, the reader returns sensible defaults.
//
// Distinct from `settings-store.tsx` which is the mutating store (writer)
// for the Settings surface. This file is the read-side composition input.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { RequestTypeInfo } from "../types/render";
import { userConfigPath } from "./state-paths";

export interface AllowlistEntry {
    id: string;
    path: string;
}

export interface PortalSettings {
    allowlist: AllowlistEntry[];
    /** Per-repo trust overrides, keyed by repo id. */
    trustOverrides: Record<string, string>;
    /** Global trust default (when no per-repo override). */
    globalTrust: string;
    /** Daily cost cap from governance */
    dailyCostCap: number;
    /** Per-request cost cap from governance */
    perRequestCostCap: number;
    /** Monthly cost cap from governance */
    monthlyCostCap: number;
    /** True when the caps come from the user config's governance section;
     *  false = the values are the DAEMON's defaults (#393 — the UI must
     *  say so instead of presenting them as saved settings). */
    capsFromConfig: boolean;
    /** Notification settings */
    notifications: {
        discordWebhook: string;
        slackWebhook: string;
        defaultMethod: string;
        dndEnabled: boolean;
        dndStart: string;
        dndEnd: string;
    };
}

/**
 * Daemon config file shape - nested structure used by the daemon
 */
interface DaemonConfigFile {
    governance?: {
        daily_cost_cap_usd?: number;
        monthly_cost_cap_usd?: number;
        per_request_cost_cap_usd?: number;
    };
    repositories?: {
        allowlist?: string[]; // daemon uses string[] not AllowlistEntry[]
    };
    trust?: {
        system_default_level?: number | string;
        per_repo_overrides?: Record<string, string>;
    };
    notifications?: {
        delivery?: {
            discord?: { webhook_url?: string };
            slack?: { webhook_url?: string };
            default_method?: string;
        };
        // Legacy flat fields for backward compatibility
        discordWebhook?: string;
        slackWebhook?: string;
        notifyDefault?: string;
        dndEnabled?: boolean;
        dndStart?: string;
        dndEnd?: string;
    };
}

export interface SettingsReaderOptions {
    /** Override the config file path (default: userConfigPath). */
    configPath?: string;
    /** Override the daemon defaults file (tests). */
    daemonDefaultsPath?: string;
}

export interface DaemonDefaultCaps {
    daily: number;
    perRequest: number;
    monthly: number;
}

/** Last-resort fallback mirroring plugins/autonomous-dev/config_defaults.json
 *  governance — drift-locked by a test against the repo file (#393). */
const SHIPPED_DEFAULT_CAPS: DaemonDefaultCaps = {
    daily: 100,
    perRequest: 50,
    monthly: 2000,
};

/** Sort semver-ish version strings descending. */
function semverDesc(a: string, b: string): number {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pb[i] ?? 0) - (pa[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/**
 * Read the DAEMON's actual default cost caps from its config_defaults.json
 * (#393 — the portal previously invented 25/10/500, which the daemon never
 * enforces; real shipped defaults are 100/50/2000). Resolution: explicit
 * path → repo layout → installed cache (highest version) → shipped constants.
 */
export async function readDaemonDefaultCaps(opts: {
    daemonDefaultsPath?: string;
    cacheRootDir?: string;
} = {}): Promise<DaemonDefaultCaps> {
    const candidates: string[] = [];
    candidates.push(
        opts.daemonDefaultsPath ??
            join(import.meta.dir, "..", "..", "..", "autonomous-dev", "config_defaults.json"),
    );
    const cacheRoot = opts.cacheRootDir ??
        join(homedir(), ".claude", "plugins", "cache", "autonomous-dev", "autonomous-dev");
    try {
        const versions = (await readdir(cacheRoot))
            .filter((v) => /^\d+\.\d+/.test(v))
            .sort(semverDesc);
        for (const v of versions) {
            candidates.push(join(cacheRoot, v, "config_defaults.json"));
        }
    } catch {
        /* no cache root */
    }
    for (const p of candidates) {
        try {
            const parsed = JSON.parse(await readFile(p, "utf-8")) as {
                governance?: Record<string, unknown>;
            };
            const g = parsed.governance ?? {};
            const num = (x: unknown): number | null =>
                typeof x === "number" && x > 0 ? x : null;
            const daily = num(g["daily_cost_cap_usd"]);
            const perRequest = num(g["per_request_cost_cap_usd"]);
            const monthly = num(g["monthly_cost_cap_usd"]);
            if (daily !== null && perRequest !== null && monthly !== null) {
                return { daily, perRequest, monthly };
            }
        } catch {
            /* try the next candidate */
        }
    }
    return SHIPPED_DEFAULT_CAPS;
}

export function portalSettingsPath(configPath?: string): string {
    return configPath ?? userConfigPath();
}

/**
 * Convert daemon trust level number to portal string format
 */
function formatTrustLevel(level: number | string | undefined): string {
    if (typeof level === "string") return level;
    if (typeof level === "number") return `L${level}`;
    return "L1"; // default
}

/**
 * Convert daemon allowlist (string[]) to portal format (AllowlistEntry[]).
 *
 * The repo `id` is derived from `basename(path)` so the dashboard renders
 * real repo names (e.g. `autonomous-dev`) instead of synthetic `rep-NNN`
 * placeholders. Collisions are disambiguated with a `-N` suffix; an empty
 * basename falls back to the old synthetic pattern.
 */
function formatAllowlist(paths: string[] | undefined): AllowlistEntry[] {
    if (!Array.isArray(paths)) return [];
    const seen = new Map<string, number>();
    return paths.map((path, index) => {
        const base = basename(path) || `rep-${index.toString().padStart(3, "0")}`;
        const count = seen.get(base) ?? 0;
        seen.set(base, count + 1);
        const id = count === 0 ? base : `${base}-${count}`;
        return { id, path };
    });
}

export async function readPortalSettings(
    opts: SettingsReaderOptions = {},
): Promise<PortalSettings> {
    const path = portalSettingsPath(opts.configPath);
    const dcaps = await readDaemonDefaultCaps({
        daemonDefaultsPath: opts.daemonDefaultsPath,
    });
    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch {
        // Return sensible defaults when file missing
        return {
            allowlist: [],
            trustOverrides: {},
            globalTrust: "L1",
            dailyCostCap: dcaps.daily,
            perRequestCostCap: dcaps.perRequest,
            monthlyCostCap: dcaps.monthly,
            capsFromConfig: false,
            notifications: {
                discordWebhook: "",
                slackWebhook: "",
                defaultMethod: "none",
                dndEnabled: false,
                dndStart: "22:00",
                dndEnd: "08:00"
            }
        };
    }
    let parsed: DaemonConfigFile;
    try {
        parsed = JSON.parse(raw) as DaemonConfigFile;
    } catch {
        // Return defaults on parse error
        return {
            allowlist: [],
            trustOverrides: {},
            globalTrust: "L1",
            dailyCostCap: dcaps.daily,
            perRequestCostCap: dcaps.perRequest,
            monthlyCostCap: dcaps.monthly,
            capsFromConfig: false,
            notifications: {
                discordWebhook: "",
                slackWebhook: "",
                defaultMethod: "none",
                dndEnabled: false,
                dndStart: "22:00",
                dndEnd: "08:00"
            }
        };
    }

    // Map from daemon shape to portal view-model
    const notifications = parsed.notifications ?? {};
    const delivery = notifications.delivery ?? {};

    return {
        allowlist: formatAllowlist(parsed.repositories?.allowlist),
        trustOverrides: parsed.trust?.per_repo_overrides ?? {},
        globalTrust: formatTrustLevel(parsed.trust?.system_default_level),
        dailyCostCap: parsed.governance?.daily_cost_cap_usd ?? dcaps.daily,
        perRequestCostCap: parsed.governance?.per_request_cost_cap_usd ?? dcaps.perRequest,
        monthlyCostCap: parsed.governance?.monthly_cost_cap_usd ?? dcaps.monthly,
        capsFromConfig:
            parsed.governance?.daily_cost_cap_usd !== undefined ||
            parsed.governance?.per_request_cost_cap_usd !== undefined ||
            parsed.governance?.monthly_cost_cap_usd !== undefined,
        notifications: {
            // Prefer nested daemon shape, fallback to legacy flat shape
            discordWebhook: delivery.discord?.webhook_url ?? notifications.discordWebhook ?? "",
            slackWebhook: delivery.slack?.webhook_url ?? notifications.slackWebhook ?? "",
            defaultMethod: delivery.default_method ?? notifications.notifyDefault ?? "none",
            dndEnabled: notifications.dndEnabled ?? false,
            dndStart: notifications.dndStart ?? "22:00",
            dndEnd: notifications.dndEnd ?? "08:00"
        }
    };
}

/**
 * Mask a stored webhook URL for display (#392). The raw secret must never
 * reach the rendered page; the settings route passes this masked string to
 * the notifications card, which uses it as a placeholder (never as an input
 * value, so it can never round-trip into a save).
 */
export function maskWebhookForDisplay(url: string): string {
    if (url === "") return "";
    return `configured — ends …${url.slice(-4)} (enter new value to replace)`;
}


/**
 * Real request types from the daemon plugin's config/request-types.json
 * (resolved via the same cache-root logic as the agent manifest). The
 * old Variants tab rendered kit fixtures ("Fast-track", "8-phase
 * canonical") with dead Edit buttons — these are the actual pipeline
 * variants the daemon accepts (crawl p10).
 */
export async function readRequestTypes(): Promise<RequestTypeInfo[]> {
    try {
        const { resolveManifestDir } = await import("./agent-states-reader");
        const dir = await resolveManifestDir();
        if (dir === null) return [];
        const { readFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        // resolveManifestDir points at the plugin root's agents dir parent
        // (plugin root); request-types.json lives under config/.
        const raw = await readFile(
            join(dir, "..", "config", "request-types.json"),
            "utf-8",
        );
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.flatMap((t) => {
            if (t === null || typeof t !== "object") return [];
            const o = t as Record<string, unknown>;
            if (typeof o["id"] !== "string") return [];
            return [{
                id: o["id"],
                description:
                    typeof o["description"] === "string"
                        ? o["description"]
                        : "",
                defaultCostCapUsd:
                    typeof o["default_cost_cap_usd"] === "number"
                        ? o["default_cost_cap_usd"]
                        : null,
                defaultTrustThreshold:
                    typeof o["default_trust_threshold"] === "number"
                        ? o["default_trust_threshold"]
                        : null,
                defaultReviewers: Array.isArray(o["default_reviewers"])
                    ? (o["default_reviewers"] as unknown[]).filter(
                          (r): r is string => typeof r === "string",
                      )
                    : [],
            }];
        });
    } catch {
        return [];
    }
}
